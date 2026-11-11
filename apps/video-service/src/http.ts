import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { forwardPestDetection, parseAiDetection } from "./ai-event.js";
import type { AiDetection, ForwardResult } from "./ai-event.js";
import { InMemoryAiEventRepository, toDetection } from "./ai-event.repository.js";
import type { AiEventQuery, AiEventRecord, AiEventRepository } from "./ai-event.repository.js";
import { InMemoryPtzRepository, PTZ_ACTIONS } from "./ptz.repository.js";
import type { PtzAction, PtzCommand, PtzQuery, PtzRepository, PtzStatus } from "./ptz.repository.js";
import { UnconfiguredPtzChannel } from "./ptz-channel.js";
import type { PtzChannel } from "./ptz-channel.js";
interface Camera { id: string; name: string; plotCode?: string; status: "ONLINE" | "OFFLINE"; streamUrl: string }
interface Recording { id: string; cameraId: string; startedAt: string; endedAt: string; playbackUrl: string }
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
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 1_048_576) throw new Error("请求体过大"); chunks.push(Buffer.from(chunk)); } const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function integer(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error("分页参数非法");
  return parsed;
}
function aiQuery(query: URLSearchParams): AiEventQuery {
  const result: AiEventQuery = { page: integer(query.get("page"), 1, 1_000_000), size: integer(query.get("size"), 20, 200) };
  if (param(query, "plotCode") !== "") result.plotCode = param(query, "plotCode");
  const forwarded = param(query, "forwarded");
  if (forwarded === "true") result.forwarded = true;
  else if (forwarded === "false") result.forwarded = false;
  else if (forwarded !== "") throw new Error("forwarded 筛选需为 true 或 false");
  return result;
}
function ptzQuery(query: URLSearchParams): PtzQuery {
  const result: PtzQuery = { page: integer(query.get("page"), 1, 1_000_000), size: integer(query.get("size"), 20, 200) };
  if (param(query, "cameraId") !== "") result.cameraId = param(query, "cameraId");
  return result;
}
export interface VideoHttpOptions {
  aiEvents?: AiEventRepository;
  ptz?: PtzRepository;
  channel?: PtzChannel;
  forward?: (detection: AiDetection, options: { baseUrl: string; timeoutMs?: number; deviceToken?: string | undefined }) => Promise<ForwardResult>;
}
export function createVideoHttpServer(options: VideoHttpOptions = {}): Server {
  const aiEvents = options.aiEvents ?? new InMemoryAiEventRepository();
  const ptz = options.ptz ?? new InMemoryPtzRepository();
  const channel = options.channel ?? new UnconfiguredPtzChannel();
  const forward = options.forward ?? forwardPestDetection;
  /** 云台投递后按通道真实结果落状态：未接入硬件通道时留存 QUEUED，不假装下发成功 */
  const deliverPtz = async (tenantId: string, command: PtzCommand): Promise<{ command: PtzCommand; message: string }> => {
    const delivered = await channel.deliver(command);
    const status: PtzStatus = channel.configured ? (delivered.ok ? "SENT" : "FAILED") : "QUEUED";
    const settled = (await ptz.settle(tenantId, command.id, status, delivered.message)) ?? command;
    return { command: settled, message: delivered.message };
  };
  return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "video" }, traceId); return; }
  // 识别上报由算法侧凭 DEVICE_CALLBACK_TOKEN 回调；查询与人工重试仍需设备权限
  const denied = authorizeRequest(req, { read: "device:read", write: "device:control", ...(req.method === "POST" ? { callbackPaths: ["/api/v1/video/ai-events"] } : {}) });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  const tenantId = req.headers["x-tenant-id"]?.toString() || "tenant-demo";
  const forwardOptions = { baseUrl: process.env.TELEMETRY_BASE_URL ?? "http://127.0.0.1:3004", deviceToken: process.env.DEVICE_CALLBACK_TOKEN };
  if (req.method === "GET" && url.pathname === "/api/v1/video/cameras") { send(res, 200, page(filterCameras(url.searchParams), url.searchParams), traceId); return; }
  const cameraMatch = url.pathname.match(/^\/api\/v1\/video\/cameras\/([^/]+)(\/ptz)?$/); const cameraId = cameraMatch?.[1];
  if (cameraId && cameraMatch?.[2] === "/ptz" && req.method === "POST") {
    if (!cameras.some((camera) => camera.id === cameraId)) { send(res, 404, null, traceId, "摄像头不存在"); return; }
    const body = await json(req);
    const action = String(body.action ?? "").trim().toUpperCase();
    if (!PTZ_ACTIONS.includes(action as PtzAction)) throw new Error("云台动作需为 LEFT/RIGHT/UP/DOWN/ZOOM_IN/ZOOM_OUT/STOP");
    let speed: number | undefined;
    if (body.speed !== undefined && body.speed !== null && body.speed !== "") {
      const parsed = Number(body.speed);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) throw new Error("云台速度需为 1 到 10 的整数");
      speed = parsed;
    }
    const command = await ptz.create({ id: randomUUID(), tenantId, cameraId, action: action as PtzAction, ...(speed !== undefined ? { speed } : {}), status: "QUEUED", message: "", createdAt: new Date().toISOString() });
    const delivered = await deliverPtz(tenantId, command);
    send(res, 202, delivered.command, traceId, delivered.message); return;
  }
  if (cameraId && !cameraMatch?.[2] && req.method === "GET") { send(res, 200, cameras.find((camera) => camera.id === cameraId) ?? null, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/video/recordings") { send(res, 200, page(filterRecordings(url.searchParams), url.searchParams), traceId); return; }
  // 视频 AI 联动：先落库再转发，转发失败保留记录并由中继补投，重启不丢识别结果
  if (req.method === "POST" && url.pathname === "/api/v1/video/ai-events") {
    const detection = parseAiDetection(await json(req));
    let record: AiEventRecord = await aiEvents.create({ id: randomUUID(), tenantId, cameraId: detection.cameraId, plotCode: detection.plotCode, pestType: detection.pestType, level: detection.level, confidence: detection.confidence, ...(detection.imageFileId ? { imageFileId: detection.imageFileId } : {}), detectedAt: detection.detectedAt, receivedAt: new Date().toISOString(), forwarded: false, forwardStatus: 0, forwardMessage: "", retryCount: 0 });
    const result = await forward(detection, forwardOptions);
    record = (result.forwarded ? await aiEvents.markForwarded(tenantId, record.id, new Date().toISOString(), result.status, result.message) : await aiEvents.markFailed(tenantId, record.id, result.status, result.message)) ?? record;
    send(res, record.forwarded ? 201 : 202, record, traceId, result.message); return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/video/ai-events") { send(res, 200, await aiEvents.page(tenantId, aiQuery(url.searchParams)), traceId); return; }
  const aiRetryMatch = url.pathname.match(/^\/api\/v1\/video\/ai-events\/([^/]+)\/retry$/);
  if (aiRetryMatch && req.method === "POST") {
    const event = await aiEvents.find(tenantId, decodeURIComponent(aiRetryMatch[1]!));
    if (!event) { send(res, 404, null, traceId, "识别事件不存在"); return; }
    if (event.forwarded) { send(res, 400, null, traceId, "该识别事件已转发成功，无需重试"); return; }
    const result = await forward(toDetection(event), forwardOptions);
    const updated = (result.forwarded ? await aiEvents.markForwarded(tenantId, event.id, new Date().toISOString(), result.status, result.message) : await aiEvents.markFailed(tenantId, event.id, result.status, result.message)) ?? event;
    send(res, updated.forwarded ? 200 : 202, updated, traceId, result.message); return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/video/ptz-commands") { send(res, 200, await ptz.page(tenantId, ptzQuery(url.searchParams)), traceId); return; }
  const ptzRetryMatch = url.pathname.match(/^\/api\/v1\/video\/ptz-commands\/([^/]+)\/retry$/);
  if (ptzRetryMatch && req.method === "POST") {
    const command = await ptz.find(tenantId, decodeURIComponent(ptzRetryMatch[1]!));
    if (!command) { send(res, 404, null, traceId, "云台指令不存在"); return; }
    if (command.status === "SENT") { send(res, 400, null, traceId, "该指令已下发成功，无需重试"); return; }
    const delivered = await deliverPtz(tenantId, command);
    send(res, 200, delivered.command, traceId, delivered.message); return;
  }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
