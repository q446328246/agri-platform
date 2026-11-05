import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { LocalFileObjectStorage } from "./storage.js";
import type { ObjectStorage } from "./storage.js";
interface FileMeta { id: string; name: string; contentType: string; size: number; storageKey: string; plotCode?: string; createdAt: string }
const files: FileMeta[] = [];
export { InMemoryObjectStorage, S3ObjectStorage } from "./storage.js";
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `FILE-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function page(query: URLSearchParams): PageResult<FileMeta> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const start = (pageNo - 1) * size; return { items: files.slice(start, start + size), total: files.length, page: pageNo, size, pages: Math.ceil(files.length / size) }; }
export function createFileHttpServer(storage: ObjectStorage = new LocalFileObjectStorage()): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "file" }, traceId); return; }
  const denied = authorizeRequest(req, { read: "plot:read", write: "plot:write" });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/files") { send(res, 200, page(url.searchParams), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/files") { const body = await json(req); const id = randomUUID(); const storageKey = `local/${id}`; const content = typeof body.contentBase64 === "string" ? Buffer.from(body.contentBase64, "base64") : Buffer.alloc(0); await storage.put(storageKey, content); const file: FileMeta = { id, name: String(body.name ?? "未命名文件"), contentType: String(body.contentType ?? "application/octet-stream"), size: content.length || Number(body.size ?? 0), storageKey, createdAt: new Date().toISOString() }; if (typeof body.plotCode === "string") file.plotCode = body.plotCode; files.unshift(file); send(res, 201, file, traceId); return; }
  const contentMatch = url.pathname.match(/^\/api\/v1\/files\/([^/]+)\/content$/); const contentId = contentMatch?.[1]; if (contentId && req.method === "GET") { const file = files.find((item) => item.id === contentId); if (!file) { send(res, 404, null, traceId, "文件不存在"); return; } const content = await storage.get(file.storageKey); if (!content) { send(res, 404, null, traceId, "文件内容不存在"); return; } res.writeHead(200, { "content-type": file.contentType, "content-length": content.length }); res.end(content); return; }
  const match = url.pathname.match(/^\/api\/v1\/files\/([^/]+)$/); const id = match?.[1]; if (id && req.method === "GET") { send(res, 200, files.find((file) => file.id === id) ?? null, traceId); return; } if (id && req.method === "DELETE") { const index = files.findIndex((file) => file.id === id); if (index >= 0) { const [file] = files.splice(index, 1); if (file) await storage.delete(file.storageKey); } send(res, 204, null, traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
