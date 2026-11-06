import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { parseNavigationRequest, planNavigation } from "./navigation.js";
import type { NavPlan } from "./navigation.js";

type TaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED";
type TaskType = "TILLAGE" | "SEEDING" | "IRRIGATION" | "WEEDING" | "SPRAYING" | "FERTILIZATION";
const TASK_TYPES: TaskType[] = ["TILLAGE", "SEEDING", "IRRIGATION", "WEEDING", "SPRAYING", "FERTILIZATION"];
const TASK_STATUSES: TaskStatus[] = ["PENDING", "RUNNING", "COMPLETED", "CANCELLED"];
interface Task { id: string; tenantId: string; plotCode: string; type: TaskType; name: string; status: TaskStatus; scheduledAt?: string; createdAt: string }
const hoursFromNow = (hours: number): string => new Date(Date.now() + hours * 3600000).toISOString();
/** 演示农事任务：覆盖六种作业类型与四种状态，任务调度页一进就能看到排程 */
const tasks: Task[] = [
  { id: "task-demo-001", tenantId: "tenant-demo", plotCode: "511723-000001-02-00005-0000-C", type: "IRRIGATION", name: "西区一号田补灌执行", status: "RUNNING", scheduledAt: hoursFromNow(-4), createdAt: hoursFromNow(-8) },
  { id: "task-demo-002", tenantId: "tenant-demo", plotCode: "511723-000001-01-00003-0000-T", type: "SPRAYING", name: "东区三号田病虫害喷防", status: "PENDING", scheduledAt: hoursFromNow(6), createdAt: hoursFromNow(-10) },
  { id: "task-demo-003", tenantId: "tenant-demo", plotCode: "511723-000001-03-00009-0000-J", type: "FERTILIZATION", name: "联片二号田抽穗期追肥", status: "PENDING", scheduledAt: hoursFromNow(20), createdAt: hoursFromNow(-26) },
  { id: "task-demo-004", tenantId: "tenant-demo", plotCode: "511723-000001-04-00012-0000-D", type: "TILLAGE", name: "演练田耕整地作业", status: "PENDING", scheduledAt: hoursFromNow(30), createdAt: hoursFromNow(-30) },
  { id: "task-demo-005", tenantId: "tenant-demo", plotCode: "511723-000001-03-00010-0000-U", type: "WEEDING", name: "联片三号田除草作业", status: "RUNNING", scheduledAt: hoursFromNow(-2), createdAt: hoursFromNow(-14) },
  { id: "task-demo-006", tenantId: "tenant-demo", plotCode: "511723-000001-01-00001-0000-5", type: "IRRIGATION", name: "东区一号田水肥一体化追肥", status: "COMPLETED", scheduledAt: hoursFromNow(-50), createdAt: hoursFromNow(-60) },
  { id: "task-demo-007", tenantId: "tenant-demo", plotCode: "511723-000001-02-00007-0000-0", type: "SPRAYING", name: "西区三号田叶面肥喷施", status: "COMPLETED", scheduledAt: hoursFromNow(-96), createdAt: hoursFromNow(-110) },
  { id: "task-demo-008", tenantId: "tenant-demo", plotCode: "511723-000001-01-00002-0000-Z", type: "SEEDING", name: "东区二号田机插秧", status: "CANCELLED", scheduledAt: hoursFromNow(-140), createdAt: hoursFromNow(-150) },
];
/** 最近的导航方案；导航是瞬时计算，进程内保留 20 条供页面回看，不落库 */
const navPlans: NavPlan[] = [];
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `OPERATION-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(req: IncomingMessage): string { return req.headers["x-request-id"]?.toString() || randomUUID(); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
/** 把纯日期（YYYY-MM-DD）扩展为当日 23:59:59.999，使「截止日」含当天全部任务；已是完整 ISO 时原样使用 */
function endOfDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}
/** 任务筛选：关键词命中名称/地块，类型与状态精确匹配，from/to 按计划时间（无计划时按创建时间）过滤；ISO 字符串直接字典序比较即可 */
function page(query: URLSearchParams): PageResult<Task> { const pageNo = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const keyword = (query.get("keyword") || "").trim().toLowerCase(); const status = query.get("status"); const type = (query.get("type") || "").trim(); const plotCode = (query.get("plotCode") || "").trim(); const from = (query.get("from") || "").trim(); const to = (query.get("to") || "").trim(); const filtered = tasks.filter((task) => {
  if (type !== "" && task.type !== type) return false;
  if (plotCode !== "" && task.plotCode !== plotCode) return false;
  const occurredAt = task.scheduledAt ?? task.createdAt;
  if (from !== "" && occurredAt < from) return false;
  if (to !== "" && occurredAt > endOfDay(to)) return false;
  return (!keyword || `${task.name} ${task.plotCode}`.toLowerCase().includes(keyword)) && (!status || task.status === (status === "IN_PROGRESS" ? "RUNNING" : status));
}); const start = (pageNo - 1) * size; return { items: filtered.slice(start, start + size), total: filtered.length, page: pageNo, size, pages: Math.ceil(filtered.length / size) }; }
export function createOperationHttpServer(): Server { return createServer(async (req, res) => { const traceId = trace(req); const url = new URL(req.url ?? "/", "http://localhost"); try {
  if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "operation" }, traceId); return; }
  const denied = authorizeRequest(req, { read: "operation:read", write: "operation:write" });
  if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/farm-tasks") { send(res, 200, page(url.searchParams), traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/farm-tasks") { const body = await json(req); const type = (body.type as TaskType) || "IRRIGATION"; if (!TASK_TYPES.includes(type)) { send(res, 400, null, traceId, "任务类型非法"); return; } const task: Task = { id: randomUUID(), tenantId: req.headers["x-tenant-id"]?.toString() || "tenant-demo", plotCode: String(body.plotCode ?? ""), type, name: String(body.name ?? "未命名农事任务"), status: "PENDING", createdAt: new Date().toISOString() }; if (typeof body.scheduledAt === "string") task.scheduledAt = body.scheduledAt; tasks.unshift(task); send(res, 201, task, traceId); return; }
  const statusMatch = url.pathname.match(/^\/api\/v1\/farm-tasks\/([^/]+)\/status$/); const taskId = statusMatch?.[1];
  if (taskId && req.method === "POST") { const body = await json(req); const task = tasks.find((item) => item.id === taskId); if (!task) { send(res, 404, null, traceId, "任务不存在"); return; } const status = body.status as TaskStatus; if (!TASK_STATUSES.includes(status)) { send(res, 400, null, traceId, "任务状态非法"); return; } task.status = status; send(res, 200, task, traceId); return; }
  if (req.method === "POST" && url.pathname === "/api/v1/operations/path-plan") { const parsed = parseNavigationRequest(await json(req)); if (!parsed.ok || !parsed.input) { send(res, 400, null, traceId, parsed.errors.join("；")); return; } const plan = planNavigation(parsed.input); navPlans.unshift(plan); if (navPlans.length > 20) navPlans.pop(); send(res, 200, plan, traceId); return; }
  if (req.method === "GET" && url.pathname === "/api/v1/operations/path-plans") { send(res, 200, navPlans, traceId); return; }
  send(res, 404, null, traceId, "接口不存在");
} catch (error) { send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
