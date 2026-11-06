import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

interface Device { id: string; deviceNo: string; name: string; type: string; status: "ONLINE" | "OFFLINE"; plotCode?: string; lastSeenAt: string }
/** 演示设备台账：与迁移 010 的地块编码、遥测读数一一对应，页面与曲线都能取到数 */
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3600000).toISOString();
const EAST_1 = "511723-000001-01-00001-0000-5";
const EAST_2 = "511723-000001-01-00002-0000-Z";
const EAST_3 = "511723-000001-01-00003-0000-T";
const WEST_1 = "511723-000001-02-00005-0000-C";
const LINK_2 = "511723-000001-03-00009-0000-J";
const LINK_3 = "511723-000001-03-00010-0000-U";
const LINK_1 = "511723-000001-03-00008-0000-P";
const devices: Device[] = [
  { id: "device-weather-001", deviceNo: "DZ-W-001", name: "达州气象站 A01", type: "WEATHER_STATION", status: "ONLINE", lastSeenAt: new Date().toISOString() },
  { id: "device-soil-003", deviceNo: "DZ-S-003", name: "东区一号田墒情站 S03", type: "SOIL_SENSOR", status: "ONLINE", plotCode: EAST_1, lastSeenAt: new Date().toISOString() },
  { id: "device-station-002", deviceNo: "DZ-C-002", name: "东区二号田综合监测站 C02", type: "INTEGRATED_STATION", status: "ONLINE", plotCode: EAST_2, lastSeenAt: new Date().toISOString() },
  { id: "device-soil-004", deviceNo: "DZ-S-004", name: "西区一号田墒情站 S04", type: "SOIL_SENSOR", status: "ONLINE", plotCode: WEST_1, lastSeenAt: new Date().toISOString() },
  { id: "device-ndvi-001", deviceNo: "DZ-R-001", name: "苗情遥感反演节点 R01", type: "REMOTE_SENSE", status: "ONLINE", plotCode: EAST_3, lastSeenAt: hoursAgo(2) },
  { id: "device-lamp-001", deviceNo: "DZ-L-001", name: "东区虫情测报灯 L01", type: "INSECT_LAMP", status: "ONLINE", plotCode: EAST_3, lastSeenAt: new Date().toISOString() },
  { id: "device-lamp-002", deviceNo: "DZ-L-002", name: "联片虫情测报灯 L02", type: "INSECT_LAMP", status: "OFFLINE", plotCode: LINK_2, lastSeenAt: hoursAgo(14) },
  { id: "device-valve-001", deviceNo: "DZ-V-001", name: "首部水肥泵阀 V01", type: "FERTILIZER_VALVE", status: "ONLINE", plotCode: EAST_1, lastSeenAt: new Date().toISOString() },
  { id: "device-valve-002", deviceNo: "DZ-V-002", name: "西区灌溉阀门 V02", type: "IRRIGATION_VALVE", status: "ONLINE", plotCode: WEST_1, lastSeenAt: new Date().toISOString() },
  { id: "device-pump-001", deviceNo: "DZ-P-001", name: "联片灌溉泵站 P01", type: "IRRIGATION_PUMP", status: "ONLINE", plotCode: LINK_1, lastSeenAt: hoursAgo(1) },
  { id: "device-drone-001", deviceNo: "DZ-D-001", name: "植保无人机 U01", type: "AGRICULTURAL_DRONE", status: "ONLINE", plotCode: EAST_3, lastSeenAt: hoursAgo(3) },
  { id: "device-tractor-001", deviceNo: "DZ-T-001", name: "无人驾驶拖拉机 T01", type: "AUTO_TRACTOR", status: "OFFLINE", plotCode: LINK_3, lastSeenAt: hoursAgo(6) },
];
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `IOT-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
/** 设备台账筛选：关键词命中名称/编号，类型、状态、地块精确匹配，默认全量返回但分页字段真实生效 */
function pageDevices(query: URLSearchParams): { items: Device[]; total: number; page: number; size: number; pages: number } {
  const pageNo = Math.max(1, Number(query.get("page") || 1));
  const size = Math.min(200, Math.max(1, Number(query.get("size") || 20)));
  const keyword = (query.get("keyword") || "").trim().toLowerCase();
  const type = (query.get("type") || "").trim();
  const status = (query.get("status") || "").trim();
  const plotCode = (query.get("plotCode") || "").trim();
  const filtered = devices.filter((device) => {
    if (type !== "" && device.type !== type) return false;
    if (status !== "" && device.status !== status) return false;
    if (plotCode !== "" && device.plotCode !== plotCode) return false;
    return keyword.length === 0 || `${device.name} ${device.deviceNo}`.toLowerCase().includes(keyword);
  });
  const start = (pageNo - 1) * size;
  return { items: filtered.slice(start, start + size), total: filtered.length, page: pageNo, size, pages: Math.ceil(filtered.length / size) };
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
export function createIotHttpServer(): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "iot" }, traceId); return; }
  const denied = authorizeRequest(req, { read: "device:read", write: "device:control" });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/devices") { send(res, 200, pageDevices(url.searchParams), traceId); return; }
  const match = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)(\/commands)?$/); const id = match?.[1];
  if (id && match?.[2] === "/commands" && req.method === "POST") { const command = await json(req); send(res, 202, { commandId: randomUUID(), deviceId: id, status: "QUEUED", command }, traceId); return; }
  if (id && !match?.[2] && req.method === "GET") { send(res, 200, devices.find((device) => device.id === id) ?? null, traceId, devices.some((device) => device.id === id) ? "" : "设备不存在"); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
