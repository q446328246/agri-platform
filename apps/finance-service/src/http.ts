import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { InMemoryFinanceRepository } from "./repository.js";
import type { FinanceEntry, FinanceRepository, FinanceSummary } from "./repository.js";
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `FINANCE-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
/** 投入产出筛选：kind/category/season 精确匹配，关键词命中备注/类别/地块，from/to 按登记时间过滤 */
function filterEntries(rows: FinanceEntry[], search: URLSearchParams): FinanceEntry[] {
  const kind = (search.get("kind") || "").trim();
  const category = (search.get("category") || "").trim();
  const season = (search.get("season") || "").trim();
  const keyword = (search.get("keyword") || "").trim().toLowerCase();
  const from = (search.get("from") || "").trim();
  const to = (search.get("to") || "").trim();
  const toEnd = /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
  return rows.filter((entry) => {
    if (kind !== "" && entry.kind !== kind) return false;
    if (category !== "" && entry.category !== category) return false;
    if (season !== "" && entry.season !== season) return false;
    if (from !== "" && entry.createdAt < from) return false;
    if (to !== "" && entry.createdAt > toEnd) return false;
    return keyword.length === 0 || `${entry.note} ${entry.category} ${entry.plotCode}`.toLowerCase().includes(keyword);
  });
}
/** 除 plotCode 外还带了筛选条件时，汇总改用过滤后的行内存聚合，保证卡片数字与列表联动 */
function hasExtraFilters(search: URLSearchParams): boolean {
  return ["kind", "category", "season", "keyword", "from", "to"].some((name) => (search.get(name) || "").trim() !== "");
}
export function createFinanceHttpServer(repository: FinanceRepository = new InMemoryFinanceRepository()): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "finance" }, traceId); return; }
  const denied = authorizeRequest(req, { read: "finance:read", write: "finance:write" });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/finance/entries") { const plotCode = url.searchParams.get("plotCode") ?? undefined; send(res, 200, filterEntries(await repository.list(plotCode), url.searchParams), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/finance/entries") { const body = await json(req); const entry = { id: randomUUID(), plotCode: String(body.plotCode ?? ""), season: String(body.season ?? new Date().getFullYear()), kind: body.kind === "OUTPUT" ? "OUTPUT" as const : "INPUT" as const, category: String(body.category ?? "OTHER"), amount: Number(body.amount ?? 0), unit: String(body.unit ?? "元"), note: String(body.note ?? ""), createdAt: new Date().toISOString() }; await repository.create(entry); send(res, 201, entry, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/finance/summary") {
    const plotCode = url.searchParams.get("plotCode") ?? undefined;
    if (!hasExtraFilters(url.searchParams)) { send(res, 200, await repository.summary(plotCode), traceId); return; }
    const rows = filterEntries(await repository.list(plotCode), url.searchParams);
    const input = rows.filter((row) => row.kind === "INPUT").reduce((sum, row) => sum + row.amount, 0);
    const output = rows.filter((row) => row.kind === "OUTPUT").reduce((sum, row) => sum + row.amount, 0);
    const summary: FinanceSummary = { plotCode: plotCode ?? null, input, output, profit: output - input, currency: "CNY" };
    send(res, 200, summary, traceId);
    return;
  }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
