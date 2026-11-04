import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { InMemoryTraceRepository } from "./repository.js";
import type { TraceRepository, TraceRecord } from "./repository.js";
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `TRACE-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function page(rows: TraceRecord[], query: URLSearchParams): PageResult<TraceRecord> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const start = (pageNo - 1) * size; return { items: rows.slice(start, start + size), total: rows.length, page: pageNo, size, pages: Math.ceil(rows.length / size) }; }
export function createTraceHttpServer(repository: TraceRepository = new InMemoryTraceRepository()): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "trace" }, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/trace/records") { send(res, 200, page(await repository.list(url.searchParams.get("plotCode") ?? undefined), url.searchParams), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/trace/records") { const body = await json(req); const item: TraceRecord = { id: randomUUID(), traceCode: `TR-${Date.now()}-${Math.floor(Math.random() * 1000)}`, plotCode: String(body.plotCode ?? ""), event: String(body.event ?? "FARM_OPERATION"), detail: String(body.detail ?? ""), operator: String(body.operator ?? "system"), createdAt: new Date().toISOString() }; await repository.create(item); send(res, 201, item, traceId); return; }
  const match = url.pathname.match(/^\/api\/v1\/trace\/([^/]+)$/); const code = match?.[1]; if (code && req.method === "GET") { send(res, 200, await repository.findByCode(code), traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
