import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";

interface Message { id: string; tenantId: string; type: "NOTICE" | "ALERT"; title: string; content: string; level: "INFO" | "WARNING" | "CRITICAL"; read: boolean; createdAt: string }
const messages: Message[] = [];
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `MESSAGE-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function page(query: URLSearchParams): PageResult<Message> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const start = (pageNo - 1) * size; return { items: messages.slice(start, start + size), total: messages.length, page: pageNo, size, pages: Math.ceil(messages.length / size) }; }
export function createMessageHttpServer(): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "message" }, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/messages") { send(res, 200, page(url.searchParams), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/messages") { const body = await json(req); const message: Message = { id: randomUUID(), tenantId: req.headers["x-tenant-id"]?.toString() || "tenant-demo", type: body.type === "ALERT" ? "ALERT" : "NOTICE", title: String(body.title ?? "系统通知"), content: String(body.content ?? ""), level: body.level === "CRITICAL" ? "CRITICAL" : body.level === "WARNING" ? "WARNING" : "INFO", read: false, createdAt: new Date().toISOString() }; messages.unshift(message); send(res, 201, message, traceId); return; }
  const match = url.pathname.match(/^\/api\/v1\/messages\/([^/]+)\/read$/); const id = match?.[1];
  if (id && req.method === "POST") { const message = messages.find((item) => item.id === id); if (!message) { send(res, 404, null, traceId, "消息不存在"); return; } message.read = true; send(res, 200, message, traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
