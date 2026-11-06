import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { forwardPestDetection, parseAiDetection } from "./ai-event.js";
interface Camera { id: string; name: string; plotCode?: string; status: "ONLINE" | "OFFLINE"; streamUrl: string }
interface Recording { id: string; cameraId: string; startedAt: string; endedAt: string; playbackUrl: string }
interface AiEvent extends ReturnType<typeof parseAiDetection> { id: string; forwarded: boolean; forwardStatus: number; receivedAt: string }
const cameras: Camera[] = [
  { id: "camera-001", name: "东区一号田摄像头", plotCode: "511723-000001-01-00001-0000-5", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-001.m3u8" },
  { id: "camera-002", name: "西区一号田摄像头", plotCode: "511723-000001-02-00005-0000-C", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-002.m3u8" },
  { id: "camera-003", name: "联片一号田摄像头", plotCode: "511723-000001-03-00008-0000-P", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-003.m3u8" },
  { id: "camera-004", name: "场部入口枪机", status: "OFFLINE", streamUrl: "https://example.invalid/live/camera-004.m3u8" },
];
/** 演示录像索引：回放地址由对象存储签发，这里只给可定位的 key */
const recordings: Recording[] = [
  { id: "rec-demo-001", cameraId: "camera-001", startedAt: new Date(Date.now() - 26 * 3600000).toISOString(), endedAt: new Date(Date.now() - 25 * 3600000).toISOString(), playbackUrl: "https://example.invalid/vod/rec-demo-001.m3u8" },
  { id: "rec-demo-002", cameraId: "camera-002", startedAt: new Date(Date.now() - 50 * 3600000).toISOString(), endedAt: new Date(Date.now() - 48 * 3600000).toISOString(), playbackUrl: "https://example.invalid/vod/rec-demo-002.m3u8" },
  { id: "rec-demo-003", cameraId: "camera-003", startedAt: new Date(Date.now() - 74 * 3600000).toISOString(), endedAt: new Date(Date.now() - 73 * 3600000).toISOString(), playbackUrl: "https://example.invalid/vod/rec-demo-003.m3u8" },
];
// 最近识别事件：转发失败的也保留在这里，便于现场排查现场网络问题
const aiEvents: AiEvent[] = [];
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `VIDEO-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
function page<T>(items: T[], query: URLSearchParams): PageResult<T> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const start = (pageNo - 1) * size; return { items: items.slice(start, start + size), total: items.length, page: pageNo, size, pages: Math.ceil(items.length / size) }; }
/** 取某个查询参数的去空值，缺省与空串统一视为「不参与筛选」 */
function param(query: URLSearchParams, name: string): string { return (query.get(name) || "").trim(); }
/** 把纯日期（YYYY-MM-DD）扩展为当日 23:59:59.999，使「截止日」含当天全部录像；已是完整 ISO 时原样使用 */
function endOfDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}
/** 摄像头筛选：关键词命中名称，地块与状态精确匹配 */
function filterCameras(query: URLSearchParams): Camera[] {
  const keyword = param(query, "keyword").toLowerCase();
  const plotCode = param(query, "plotCode");
  const status = param(query, "status");
  return cameras.filter((camera) => {
    if (plotCode !== "" && camera.plotCode !== plotCode) return false;
    if (status !== "" && camera.status !== status) return false;
    return keyword.length === 0 || camera.name.toLowerCase().includes(keyword);
  });
}
/** 录像筛选：按摄像头、地块（经由摄像头归属）与开始时间区间过滤 */
function filterRecordings(query: URLSearchParams): Recording[] {
  const cameraId = param(query, "cameraId");
  const plotCode = param(query, "plotCode");
  const from = param(query, "from");
  const to = param(query, "to");
  return recordings.filter((recording) => {
    if (cameraId !== "" && recording.cameraId !== cameraId) return false;
    if (plotCode !== "" && cameras.find((camera) => camera.id === recording.cameraId)?.plotCode !== plotCode) return false;
    if (from !== "" && recording.startedAt < from) return false;
    if (to !== "" && recording.startedAt > endOfDay(to)) return false;
    return true;
  });
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
export function createVideoHttpServer(): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "video" }, traceId); return; }
  // 识别上报由算法侧直接回调，不带用户令牌；查询识别记录仍需设备查看权限
  const denied = authorizeRequest(req, { read: "device:read", write: "device:control", ...(req.method === "POST" ? { publicPaths: ["/api/v1/video/ai-events"] } : {}) });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/video/cameras") { send(res, 200, page(filterCameras(url.searchParams), url.searchParams), traceId); return; }
  const cameraMatch = url.pathname.match(/^\/api\/v1\/video\/cameras\/([^/]+)(\/ptz)?$/); const cameraId = cameraMatch?.[1]; if (cameraId && cameraMatch?.[2] === "/ptz" && req.method === "POST") { const command = await json(req); send(res, 202, { cameraId, commandId: randomUUID(), status: "QUEUED", command }, traceId); return; } if (cameraId && !cameraMatch?.[2] && req.method === "GET") { send(res, 200, cameras.find((camera) => camera.id === cameraId) ?? null, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/video/recordings") { send(res, 200, page(filterRecordings(url.searchParams), url.searchParams), traceId); return; }
  // 视频 AI 联动：算法侧上报识别结果，转发遥测服务生成告警与虫情消息
  if (req.method === "POST" && url.pathname === "/api/v1/video/ai-events") { const detection = parseAiDetection(await json(req)); const forward = await forwardPestDetection(detection, { baseUrl: process.env.TELEMETRY_BASE_URL ?? "http://127.0.0.1:3004" }); const record: AiEvent = { id: randomUUID(), ...detection, forwarded: forward.forwarded, forwardStatus: forward.status, receivedAt: new Date().toISOString() }; aiEvents.unshift(record); if (aiEvents.length > 200) aiEvents.length = 200; send(res, forward.forwarded ? 201 : 202, record, traceId, forward.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/video/ai-events") { const plotCode = url.searchParams.get("plotCode"); const rows = plotCode ? aiEvents.filter((item) => item.plotCode === plotCode) : aiEvents; send(res, 200, page(rows, url.searchParams), traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
