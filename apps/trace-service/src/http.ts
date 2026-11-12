import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { InMemoryTraceRepository, IRRIGATION_EVENT } from "./repository.js";
import type { TraceRepository, TraceRecord } from "./repository.js";
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `TRACE-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function page(rows: TraceRecord[], query: URLSearchParams): PageResult<TraceRecord> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const start = (pageNo - 1) * size; return { items: rows.slice(start, start + size), total: rows.length, page: pageNo, size, pages: Math.ceil(rows.length / size) }; }
/** 在仓储的 plotCode/event 条件之外，补充关键词（追溯码/详情/操作人）与记录时间区间过滤 */
function filterRecords(rows: TraceRecord[], query: URLSearchParams): TraceRecord[] {
  const keyword = (query.get("keyword") || "").trim().toLowerCase();
  const from = (query.get("from") || "").trim();
  const to = (query.get("to") || "").trim();
  const toEnd = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
  return rows.filter((row) => {
    if (from !== "" && row.createdAt < from) return false;
    if (to !== "" && row.createdAt > toEnd) return false;
    return keyword.length === 0 || `${row.traceCode} ${row.detail} ${row.operator}`.toLowerCase().includes(keyword);
  });
}
export function createTraceHttpServer(repository: TraceRepository = new InMemoryTraceRepository()): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "trace" }, traceId); return; }
  const denied = authorizeRequest(req, { read: "trace:read", write: "trace:write" });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/trace/records") { const rows = await repository.list(url.searchParams.get("plotCode") ?? undefined, url.searchParams.get("event") ?? undefined, url.searchParams.get("batchCode") ?? undefined); send(res, 200, page(filterRecords(rows, url.searchParams), url.searchParams), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/trace/records") {
    const body = await json(req);
    const event = String(body.event ?? "FARM_OPERATION");
    // 灌溉档案的用水量与时长只认设备结单事件，人工补录等于伪造用水账
    if (event === IRRIGATION_EVENT) throw new Error("灌溉完成由设备结单事件写入，不支持人工补录");
    const item: TraceRecord = { id: randomUUID(), traceCode: `TR-${Date.now()}-${Math.floor(Math.random() * 1000)}`, batchCode: String(body.batchCode ?? "").trim(), plotCode: String(body.plotCode ?? ""), event, detail: String(body.detail ?? ""), operator: String(body.operator ?? "system"), createdAt: new Date().toISOString() };
    await repository.create(item);
    send(res, 201, item, traceId);
    return;
  }
  const chainMatch = url.pathname.match(/^\/api\/v1\/trace\/chain\/([^/]+)$/); const chainCode = chainMatch?.[1]; if (chainCode && req.method === "GET") { send(res, 200, await repository.chain(decodeURIComponent(chainCode)), traceId); return; }
  const match = url.pathname.match(/^\/api\/v1\/trace\/([^/]+)$/); const code = match?.[1]; if (code && req.method === "GET") { send(res, 200, await repository.findByCode(code), traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
