import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
interface Camera { id: string; name: string; plotCode?: string; status: "ONLINE" | "OFFLINE"; streamUrl: string }
interface Recording { id: string; cameraId: string; startedAt: string; endedAt: string; playbackUrl: string }
const cameras: Camera[] = [{ id: "camera-001", name: "达州示范田东区", plotCode: "511723-000001-01-00001-0000-5", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-001.m3u8" }];
const recordings: Recording[] = [];
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `VIDEO-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
function page<T>(items: T[], query: URLSearchParams): PageResult<T> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const start = (pageNo - 1) * size; return { items: items.slice(start, start + size), total: items.length, page: pageNo, size, pages: Math.ceil(items.length / size) }; }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
export function createVideoHttpServer(): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "video" }, traceId); return; }
  const denied = authorizeRequest(req, { read: "device:read", write: "device:control" });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/video/cameras") { send(res, 200, page(cameras, url.searchParams), traceId); return; }
  const cameraMatch = url.pathname.match(/^\/api\/v1\/video\/cameras\/([^/]+)(\/ptz)?$/); const cameraId = cameraMatch?.[1]; if (cameraId && cameraMatch?.[2] === "/ptz" && req.method === "POST") { const command = await json(req); send(res, 202, { cameraId, commandId: randomUUID(), status: "QUEUED", command }, traceId); return; } if (cameraId && !cameraMatch?.[2] && req.method === "GET") { send(res, 200, cameras.find((camera) => camera.id === cameraId) ?? null, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/video/recordings") { send(res, 200, page(recordings, url.searchParams), traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
