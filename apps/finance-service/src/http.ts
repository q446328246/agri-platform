import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { InMemoryFinanceRepository } from "./repository.js";
import type { FinanceRepository } from "./repository.js";
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `FINANCE-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
export function createFinanceHttpServer(repository: FinanceRepository = new InMemoryFinanceRepository()): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "finance" }, traceId); return; }
  const denied = authorizeRequest(req, { read: "finance:read", write: "finance:write" });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/finance/entries") { const plotCode = url.searchParams.get("plotCode") ?? undefined; send(res, 200, await repository.list(plotCode), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/finance/entries") { const body = await json(req); const entry = { id: randomUUID(), plotCode: String(body.plotCode ?? ""), season: String(body.season ?? new Date().getFullYear()), kind: body.kind === "OUTPUT" ? "OUTPUT" as const : "INPUT" as const, category: String(body.category ?? "OTHER"), amount: Number(body.amount ?? 0), unit: String(body.unit ?? "元"), note: String(body.note ?? ""), createdAt: new Date().toISOString() }; await repository.create(entry); send(res, 201, entry, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/finance/summary") { const plotCode = url.searchParams.get("plotCode") ?? undefined; send(res, 200, await repository.summary(plotCode), traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
