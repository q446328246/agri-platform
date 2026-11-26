import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { DEVICE_STATUSES, DEVICE_TYPES, DEFAULT_TENANT, InMemoryDeviceRepository } from "./device.repository.js";
import type { Device, DeviceRepository, DeviceStatus, DeviceType, UpdateDeviceInput } from "./device.repository.js";
import { DEFAULT_DEVICE_PROTOCOL, DEVICE_PROTOCOLS, fieldAccessCatalogue, isPlcProtocol, normalizeBinding, resolveDeviceProtocolDriver } from "./device-binding.js";
import type { DeviceProtocol, DeviceProtocolDriver, ModbusBinding } from "./device-binding.js";
import { normalizePlcConfig, publicPlcConfig } from "./plc-binding.js";
import type { PlcDeviceConfig } from "./plc-binding.js";
import { parseMqttConfig, publicMqttConfig } from "./mqtt-config.js";
import type { MqttConfigCipher, MqttDeviceConfig } from "./mqtt-config.js";
import { MqttProvisioningError } from "./emqx-device-provisioner.js";
import type { MqttDeviceProvisioner } from "./emqx-device-provisioner.js";

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
  mqttConfigCipher?: MqttConfigCipher;
  mqttProvisioner?: MqttDeviceProvisioner;
  mqttCaPath?: string;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `IOT-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendCertificate(res: ServerResponse, certificate: string, traceId: string): void {
  const body = Buffer.from(certificate, "utf8");
  res.writeHead(200, {
    "content-type": "application/x-x509-ca-cert; charset=utf-8",
    "content-disposition": 'attachment; filename="mqtt-ca.crt"',
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
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

class HttpError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

function publicDevice(device: Device) {
  const { mqtt, plc, ...rest } = device;
  const driver = resolveDeviceProtocolDriver(device.protocol, device.driverId);
  const connection = driver.connectionKind === "MQTT"
    ? mqtt ? publicMqttConfig(mqtt) : null
    : driver.connectionKind === "MODBUS_TCP"
      ? device.binding ?? null
      : driver.connectionKind === "PLC"
        ? plc ? publicPlcConfig(plc) : null
        : {};
  return { ...rest, connection, ...(mqtt ? { mqtt: publicMqttConfig(mqtt) } : {}) };
}

interface NormalizedConnection {
  binding: ModbusBinding | null;
  mqtt: MqttDeviceConfig | null;
  plc: PlcDeviceConfig | null;
  mqttPassword?: string;
}

function legacyConnection(body: Record<string, unknown>, driver: DeviceProtocolDriver): unknown {
  if (driver.connectionKind !== "PLC" && body.plc !== undefined && body.plc !== null) throw new HttpError("只有 PLC 协议使用 plc 连接配置");
  if (driver.connectionKind === "PLC") {
    if (body.binding !== undefined && body.binding !== null) throw new HttpError("PLC 协议使用 connection 连接配置，不使用 Modbus binding");
    if (body.mqtt !== undefined && body.mqtt !== null) throw new HttpError("PLC 协议不使用 MQTT 连接配置");
    return body.plc;
  }
  if (driver.connectionKind === "MQTT") {
    if (body.binding !== undefined && body.binding !== null) throw new HttpError("只有 Modbus TCP 协议需要现场绑定");
    return body.mqtt;
  }
  if (driver.connectionKind === "MODBUS_TCP") {
    if (body.mqtt !== undefined && body.mqtt !== null) throw new HttpError("只有 MQTT 协议需要 MQTT 连接配置");
    return body.binding;
  }
  if ((body.binding !== undefined && body.binding !== null) || (body.mqtt !== undefined && body.mqtt !== null) || (body.plc !== undefined && body.plc !== null)) {
    throw new HttpError(`${driver.protocol} 回调式接入没有连接参数`);
  }
  return undefined;
}

function normalizeConnection(
  driver: DeviceProtocolDriver,
  raw: unknown,
  current: Device | undefined,
  deviceType: DeviceType,
  cipher: MqttConfigCipher | undefined,
): NormalizedConnection {
  if (driver.connectionKind === "NONE") {
    if (raw !== undefined && raw !== null) throw new HttpError(`${driver.protocol} 回调式接入没有连接参数`);
    return { binding: null, mqtt: null, plc: null };
  }
  if (raw === undefined || raw === null) throw new HttpError(`${driver.protocol} 接入必须提供连接参数${driver.connectionKind === "MODBUS_TCP" ? "（现场绑定）" : ""}`);
  if (driver.connectionKind === "PLC" && isPlcProtocol(driver.protocol)) {
    const parsed = normalizePlcConfig(driver.protocol, raw, deviceType, current?.plc, cipher);
    return { binding: null, mqtt: null, plc: parsed.config };
  }
  if (driver.connectionKind === "MODBUS_TCP") {
    const value = raw as Record<string, unknown>;
    const merged = current?.binding && typeof raw === "object" && !Array.isArray(raw) ? { ...current.binding, ...value } : raw;
    return { binding: normalizeBinding(driver.protocol, merged, deviceType), mqtt: null, plc: null };
  }
  if (!cipher) throw new HttpError("MQTT 配置加密密钥未配置", 503);
  const parsed = parseMqttConfig(raw, current?.mqtt, cipher);
  return { binding: null, plc: null, mqtt: parsed.config, ...(parsed.password ? { mqttPassword: parsed.password } : {}) };
}

async function configuredCa(dependencies: IotDependencies): Promise<string> {
  if (!dependencies.mqttCaPath) throw new HttpError("CA 证书未配置", 404);
  try {
    return await readFile(dependencies.mqttCaPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError("CA 证书文件不存在", 404);
    throw new HttpError("CA 证书读取失败", 500);
  }
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
      const denied = authorizeRequest(req, {
        read: "device:read",
        write: "device:control",
        callbackPaths: ["/api/v1/device/heartbeat"],
      });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
      // 台账的读写都在这一租户内进行
      const tenantId = tenantOf(req);

      if (req.method === "POST" && url.pathname === "/api/v1/device/heartbeat") {
        const body = await json(req);
        const deviceId = text(body.deviceId);
        if (!deviceId.startsWith("device-demo-sim-")) throw new HttpError("心跳接口仅用于协议模拟设备", 403);
        const status = text(body.status) || "ONLINE";
        if (!DEVICE_STATUSES.includes(status as DeviceStatus)) throw new HttpError(`status 需为 ${DEVICE_STATUSES.join("/")}`);
        if (!(await devices.recordHeartbeat(tenantId, deviceId, status as DeviceStatus, new Date().toISOString()))) throw new HttpError("设备不存在", 404);
        send(res, 200, { deviceId, status }, traceId);
        return;
      }

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
        send(res, 200, { items: filtered.slice(start, start + size).map(publicDevice), total: filtered.length, page: pageNo, size, pages: Math.ceil(filtered.length / size) }, traceId);
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
        const driver = resolveDeviceProtocolDriver(protocol, text(body.driverId) || undefined);
        if (body.connection !== undefined && legacyConnection(body, driver) !== undefined) {
          throw new HttpError("connection 与 binding/mqtt/plc 不能同时提交");
        }
        const connection = normalizeConnection(driver, body.connection !== undefined ? body.connection : legacyConnection(body, driver), undefined, type as DeviceType, dependencies.mqttConfigCipher);
        if (await devices.findByDeviceNo(tenantId, deviceNo)) { send(res, 409, null, traceId, `设备编号 ${deviceNo} 已存在`); return; }
        if (dependencies.mqttProvisioner && connection.mqtt && connection.mqttPassword) {
          await dependencies.mqttProvisioner.provision({ tenantId, deviceNo, username: connection.mqtt.username, password: connection.mqttPassword });
        }

        const created = await devices.create(tenantId, {
          deviceNo,
          name,
          type: type as DeviceType,
          status: status as DeviceStatus,
          ...(plotCode ? { plotCode } : {}),
          protocol,
          driverId: driver.id,
          ...(connection.binding ? { binding: connection.binding } : {}),
          ...(connection.mqtt ? { mqtt: connection.mqtt } : {}),
          ...(connection.plc ? { plc: connection.plc } : {}),
        });
        send(res, 201, publicDevice(created), traceId);
        return;
      }

      // 现场接入目录：协议、剖面与缺省值只有服务端一份定义，配置弹窗按它渲染，不在前端复写点位与常量
      if (req.method === "GET" && url.pathname === "/api/v1/devices/field-access") {
        send(res, 200, fieldAccessCatalogue(), traceId);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/devices/mqtt-ca") {
        sendCertificate(res, await configuredCa(dependencies), traceId);
        return;
      }
      const caMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/mqtt-ca$/);
      if (caMatch?.[1] && req.method === "GET") {
        const device = await devices.find(tenantId, caMatch[1]);
        if (!device) { send(res, 404, null, traceId, "设备不存在"); return; }
        if (device.protocol !== "MQTT") { send(res, 400, null, traceId, "该设备未使用 MQTT 协议"); return; }
        const certificate = device.mqtt?.caCertificate || await configuredCa(dependencies);
        sendCertificate(res, certificate, traceId);
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
        send(res, 200, publicDevice(device), traceId);
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
        const nextProtocol = body.protocol === undefined ? current.protocol : (text(body.protocol) as DeviceProtocol);
        if (!DEVICE_PROTOCOLS.includes(nextProtocol)) { send(res, 400, null, traceId, `接入协议需为 ${DEVICE_PROTOCOLS.join("/")}`); return; }
        const driver = resolveDeviceProtocolDriver(nextProtocol, text(body.driverId) || (nextProtocol === current.protocol ? current.driverId : undefined));
        const legacy = legacyConnection(body, driver);
        if (body.connection !== undefined && legacy !== undefined) throw new HttpError("connection 与 binding/mqtt/plc 不能同时提交");
        const connectionChanged = body.connection !== undefined || legacy !== undefined || nextProtocol !== current.protocol || driver.id !== current.driverId;
        if (connectionChanged) {
          const rawConnection = body.connection !== undefined ? body.connection : legacy !== undefined ? legacy : undefined;
          const connection = normalizeConnection(driver, rawConnection, nextProtocol === current.protocol ? current : undefined, nextType, dependencies.mqttConfigCipher);
          if (dependencies.mqttProvisioner && current.mqtt && connection.mqtt && current.mqtt.username !== connection.mqtt.username && !connection.mqttPassword) {
            throw new HttpError("测试自动开户模式下，修改 MQTT 账号必须同时填写密码");
          }
          input.protocol = nextProtocol;
          input.driverId = driver.id;
          input.binding = connection.binding;
          input.mqtt = connection.mqtt;
          input.plc = connection.plc;
          if (dependencies.mqttProvisioner && connection.mqtt && connection.mqttPassword) {
            await dependencies.mqttProvisioner.provision({ tenantId, deviceNo: current.deviceNo, username: connection.mqtt.username, password: connection.mqttPassword });
          }
        }
        if (Object.keys(input).length === 0) { send(res, 400, null, traceId, "没有需要修改的台账字段"); return; }
        const updated = await devices.update(tenantId, id, input);
        send(res, 200, updated ? publicDevice(updated) : null, traceId, updated ? "" : "设备不存在");
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      const status = error instanceof HttpError || error instanceof MqttProvisioningError ? error.status : 400;
      send(res, status, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}

export type { Device };
