import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";

interface Device { id: string; deviceNo: string; name: string; type: string; status: "ONLINE" | "OFFLINE"; plotCode?: string; lastSeenAt: string }
const devices: Device[] = [{ id: "device-weather-001", deviceNo: "DZ-W-001", name: "达州气象站 A01", type: "WEATHER_STATION", status: "ONLINE", lastSeenAt: new Date().toISOString() }, { id: "device-soil-003", deviceNo: "DZ-S-003", name: "达州墒情站 S03", type: "SOIL_SENSOR", status: "ONLINE", plotCode: "511723-000001-01-00001-0000-5", lastSeenAt: new Date().toISOString() }];
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `IOT-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
export function createIotHttpServer(): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "iot" }, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/devices") { send(res, 200, { items: devices, total: devices.length, page: 1, size: devices.length, pages: 1 }, traceId); return; }
  const match = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)(\/commands)?$/); const id = match?.[1];
  if (id && match?.[2] === "/commands" && req.method === "POST") { const command = await json(req); send(res, 202, { commandId: randomUUID(), deviceId: id, status: "QUEUED", command }, traceId); return; }
  if (id && !match?.[2] && req.method === "GET") { send(res, 200, devices.find((device) => device.id === id) ?? null, traceId, devices.some((device) => device.id === id) ? "" : "设备不存在"); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
