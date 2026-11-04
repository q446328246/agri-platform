import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";

type TaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED";
interface Task { id: string; tenantId: string; plotCode: string; type: "TILLAGE" | "SEEDING" | "IRRIGATION" | "WEEDING" | "SPRAYING"; name: string; status: TaskStatus; scheduledAt?: string; createdAt: string }
const tasks: Task[] = [];
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `OPERATION-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function page(query: URLSearchParams): PageResult<Task> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const keyword = (query.get("keyword") || "").trim().toLowerCase(); const status = query.get("status"); const filtered = tasks.filter((task) => (!keyword || `${task.name} ${task.plotCode}`.toLowerCase().includes(keyword)) && (!status || task.status === (status === "IN_PROGRESS" ? "RUNNING" : status))); const start = (pageNo - 1) * size; return { items: filtered.slice(start, start + size), total: filtered.length, page: pageNo, size, pages: Math.ceil(filtered.length / size) }; }
export function createOperationHttpServer(): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "operation" }, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/farm-tasks") { send(res, 200, page(url.searchParams), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/farm-tasks") { const body = await json(req); const task: Task = { id: randomUUID(), tenantId: req.headers["x-tenant-id"]?.toString() || "tenant-demo", plotCode: String(body.plotCode ?? ""), type: (body.type as Task["type"]) || "IRRIGATION", name: String(body.name ?? "未命名农事任务"), status: "PENDING", createdAt: new Date().toISOString() }; if (typeof body.scheduledAt === "string") task.scheduledAt = body.scheduledAt; tasks.unshift(task); send(res, 201, task, traceId); return; }
  const statusMatch = url.pathname.match(/^\/api\/v1\/farm-tasks\/([^/]+)\/status$/); const taskId = statusMatch?.[1];
  if (taskId && req.method === "POST") { const body = await json(req); const task = tasks.find((item) => item.id === taskId); if (!task) { send(res, 404, null, traceId, "任务不存在"); return; } const status = body.status as TaskStatus; if (!["PENDING", "RUNNING", "COMPLETED", "CANCELLED"].includes(status)) { send(res, 400, null, traceId, "任务状态非法"); return; } task.status = status; send(res, 200, task, traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/operations/path-plan") { const body = await json(req); send(res, 200, { planId: randomUUID(), plotCode: String(body.plotCode ?? ""), waypoints: body.waypoints ?? [], distanceMeter: Number(body.distanceMeter ?? 0), estimatedMinutes: Number(body.estimatedMinutes ?? 0) }, traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
