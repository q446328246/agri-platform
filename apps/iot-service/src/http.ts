import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { DEVICE_STATUSES, DEVICE_TYPES, InMemoryDeviceRepository } from "./device.repository.js";
import type { Device, DeviceRepository, DeviceStatus, DeviceType, UpdateDeviceInput } from "./device.repository.js";

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

      if (req.method === "GET" && url.pathname === "/api/v1/devices") {
        const pageNo = Math.max(1, Number(url.searchParams.get("page") || 1));
        const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("size") || 20) || 20));
        const filtered = await devices.list({
          keyword: url.searchParams.get("keyword")?.trim() || undefined,
          type: url.searchParams.get("type")?.trim() || undefined,
          status: url.searchParams.get("status")?.trim() || undefined,
          plotCode: url.searchParams.get("plotCode")?.trim() || undefined,
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
        if (await devices.findByDeviceNo(deviceNo)) { send(res, 409, null, traceId, `设备编号 ${deviceNo} 已存在`); return; }

        const created = await devices.create({
          deviceNo,
          name,
          type: type as DeviceType,
          status: status as DeviceStatus,
          ...(plotCode ? { plotCode } : {}),
        });
        send(res, 201, created, traceId);
        return;
      }

      const match = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)(\/commands)?$/);
      const id = match?.[1];
      if (id && match?.[2] === "/commands" && req.method === "POST") {
        if (!(await devices.find(id))) { send(res, 404, null, traceId, "设备不存在"); return; }
        const command = await json(req);
        send(res, 202, { commandId: randomUUID(), deviceId: id, status: "QUEUED", command }, traceId);
        return;
      }
      if (id && !match?.[2] && req.method === "GET") {
        const device = await devices.find(id);
        send(res, 200, device ?? null, traceId, device ? "" : "设备不存在");
        return;
      }
      // 台账配置编辑：只改台账字段，编号与最后上报时间不接受手工写入
      if (id && !match?.[2] && req.method === "PUT") {
        if (!(await devices.find(id))) { send(res, 404, null, traceId, "设备不存在"); return; }
        const body = await json(req);
        const input: UpdateDeviceInput = {};
        if (body.name !== undefined) {
          const name = text(body.name);
          if (!name) { send(res, 400, null, traceId, "设备名称不能为空"); return; }
          input.name = name;
        }
        if (body.type !== undefined) {
          const type = text(body.type);
          if (!DEVICE_TYPES.includes(type as DeviceType)) { send(res, 400, null, traceId, `设备类型需为 ${DEVICE_TYPES.join("/")}`); return; }
          input.type = type as DeviceType;
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
        if (Object.keys(input).length === 0) { send(res, 400, null, traceId, "没有需要修改的台账字段"); return; }
        const updated = await devices.update(id, input);
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
