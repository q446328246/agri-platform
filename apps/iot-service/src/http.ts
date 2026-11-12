import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { DEVICE_STATUSES, DEVICE_TYPES, DEFAULT_TENANT, InMemoryDeviceRepository } from "./device.repository.js";
import type { Device, DeviceRepository, DeviceStatus, DeviceType, UpdateDeviceInput } from "./device.repository.js";
import { DEFAULT_DEVICE_PROTOCOL, DEVICE_PROTOCOLS, fieldAccessCatalogue, normalizeBinding } from "./device-binding.js";
import type { DeviceProtocol } from "./device-binding.js";

/**
 * 设备台账 HTTP 接口。
 *
 * 台账按租户隔离（迁移 035）：列表、详情、编辑、指令下发与新增的撞号校验都只在
 * `tenantOf` 现取的租户内进行，租户只认网关透传的可信身份头，请求体自报的 tenantId 一律忽略。
 * 没有会话身份的内部调用落到进程配置的 `TENANT_ID`——一套部署对一个现场。
 */

/** 台账一屏最多取多少条，导出与下拉都按这个上限取全量 */
const MAX_PAGE_SIZE = 200;

export interface IotDependencies {
  devices?: DeviceRepository;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `IOT-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trace(req: IncomingMessage): string {
  return req.headers["x-request-id"]?.toString() || randomUUID();
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 台账归属租户：可信身份头 > 进程配置 > 演示租户 */
function tenantOf(req: IncomingMessage): string {
  return req.headers["x-tenant-id"]?.toString().trim() || process.env.TENANT_ID?.trim() || DEFAULT_TENANT;
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

export function createIotHttpServer(dependencies: IotDependencies = {}): Server {
  const devices = dependencies.devices ?? new InMemoryDeviceRepository();

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "iot" }, traceId); return; }
      const denied = authorizeRequest(req, { read: "device:read", write: "device:control" });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
      // 台账的读写都在这一租户内进行
      const tenantId = tenantOf(req);

      if (req.method === "GET" && url.pathname === "/api/v1/devices") {
        const pageNo = Math.max(1, Number(url.searchParams.get("page") || 1));
        const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("size") || 20) || 20));
        const filtered = await devices.list(tenantId, {
          keyword: url.searchParams.get("keyword")?.trim() || undefined,
          type: url.searchParams.get("type")?.trim() || undefined,
          status: url.searchParams.get("status")?.trim() || undefined,
          plotCode: url.searchParams.get("plotCode")?.trim() || undefined,
          protocol: url.searchParams.get("protocol")?.trim() || undefined,
        });
        const start = (pageNo - 1) * size;
        send(res, 200, { items: filtered.slice(start, start + size), total: filtered.length, page: pageNo, size, pages: Math.ceil(filtered.length / size) }, traceId);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/devices") {
        const body = await json(req);
        const deviceNo = text(body.deviceNo);
        const name = text(body.name);
        const type = text(body.type);
        const status = text(body.status) || "OFFLINE";
        const plotCode = text(body.plotCode);

        if (!deviceNo) { send(res, 400, null, traceId, "设备编号不能为空"); return; }
        if (!name) { send(res, 400, null, traceId, "设备名称不能为空"); return; }
        if (!DEVICE_TYPES.includes(type as DeviceType)) { send(res, 400, null, traceId, `设备类型需为 ${DEVICE_TYPES.join("/")}`); return; }
        if (!DEVICE_STATUSES.includes(status as DeviceStatus)) { send(res, 400, null, traceId, `设备状态需为 ${DEVICE_STATUSES.join("/")}`); return; }
        const protocol = (text(body.protocol) || DEFAULT_DEVICE_PROTOCOL) as DeviceProtocol;
        if (!DEVICE_PROTOCOLS.includes(protocol)) { send(res, 400, null, traceId, `接入协议需为 ${DEVICE_PROTOCOLS.join("/")}`); return; }
        // 现场协议设备的接入地址与剖面在建档时就校验到位，否则要等网关下发才发现连不上
        const binding = normalizeBinding(protocol, body.binding, type as DeviceType) ?? undefined;
        if (await devices.findByDeviceNo(tenantId, deviceNo)) { send(res, 409, null, traceId, `设备编号 ${deviceNo} 已存在`); return; }

        const created = await devices.create(tenantId, {
          deviceNo,
          name,
          type: type as DeviceType,
          status: status as DeviceStatus,
          ...(plotCode ? { plotCode } : {}),
          protocol,
          ...(binding ? { binding } : {}),
        });
        send(res, 201, created, traceId);
        return;
      }

      // 现场接入目录：协议、剖面与缺省值只有服务端一份定义，配置弹窗按它渲染，不在前端复写点位与常量
      if (req.method === "GET" && url.pathname === "/api/v1/devices/field-access") {
        send(res, 200, fieldAccessCatalogue(), traceId);
        return;
      }

      const match = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)(\/commands)?$/);
      const id = match?.[1];
      if (id && match?.[2] === "/commands" && req.method === "POST") {
        // 在册校验按租户查：别家农场的设备号在这里等同于不存在
        if (!(await devices.find(tenantId, id))) { send(res, 404, null, traceId, "设备不存在"); return; }
        const command = await json(req);
        send(res, 202, { commandId: randomUUID(), deviceId: id, status: "QUEUED", command }, traceId);
        return;
      }
      if (id && !match?.[2] && req.method === "GET") {
        const device = await devices.find(tenantId, id);
        // 与同文件的 PUT/commands 一个口径：不在本租户台账里就是不存在，不返回 200 + null
        if (!device) { send(res, 404, null, traceId, "设备不存在"); return; }
        send(res, 200, device, traceId);
        return;
      }
      // 台账配置编辑：只改台账字段，编号、归属租户与最后上报时间不接受手工写入
      if (id && !match?.[2] && req.method === "PUT") {
        const current = await devices.find(tenantId, id);
        if (!current) { send(res, 404, null, traceId, "设备不存在"); return; }
        const body = await json(req);
        const input: UpdateDeviceInput = {};
        let nextType = current.type;
        if (body.name !== undefined) {
          const name = text(body.name);
          if (!name) { send(res, 400, null, traceId, "设备名称不能为空"); return; }
          input.name = name;
        }
        if (body.type !== undefined) {
          const type = text(body.type);
          if (!DEVICE_TYPES.includes(type as DeviceType)) { send(res, 400, null, traceId, `设备类型需为 ${DEVICE_TYPES.join("/")}`); return; }
          input.type = type as DeviceType;
          nextType = type as DeviceType;
        }
        if (body.status !== undefined) {
          const status = text(body.status);
          if (!DEVICE_STATUSES.includes(status as DeviceStatus)) { send(res, 400, null, traceId, `设备状态需为 ${DEVICE_STATUSES.join("/")}`); return; }
          input.status = status as DeviceStatus;
        }
        if (body.plotCode !== undefined) {
          if (typeof body.plotCode !== "string") { send(res, 400, null, traceId, "地块编码需为字符串，空串表示解绑地块"); return; }
          input.plotCode = body.plotCode.trim();
        }
        // 接入协议与绑定一起改：协议不变时缺省沿用在册绑定，协议改了则旧绑定作废、必须给新的
        if (body.protocol !== undefined || body.binding !== undefined) {
          const nextProtocol = body.protocol === undefined ? current.protocol : (text(body.protocol) as DeviceProtocol);
          if (!DEVICE_PROTOCOLS.includes(nextProtocol)) { send(res, 400, null, traceId, `接入协议需为 ${DEVICE_PROTOCOLS.join("/")}`); return; }
          const rawBinding = body.binding !== undefined ? body.binding : nextProtocol === current.protocol ? current.binding : null;
          input.protocol = nextProtocol;
          input.binding = normalizeBinding(nextProtocol, rawBinding, nextType);
        }
        if (Object.keys(input).length === 0) { send(res, 400, null, traceId, "没有需要修改的台账字段"); return; }
        const updated = await devices.update(tenantId, id, input);
        send(res, 200, updated, traceId, updated ? "" : "设备不存在");
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}

export type { Device };
