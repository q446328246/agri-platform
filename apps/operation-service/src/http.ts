import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";
import { parseNavigationRequest, planNavigation } from "./navigation.js";
import type { NavPlan } from "./navigation.js";
import { CoverageError, parseCoverageRequest, planCoverage } from "./coverage.js";
import type { CoveragePlan } from "./coverage.js";

import { canTransition, InMemoryTaskRepository, TASK_ARCHIVE_FILTERS, TASK_STATUSES, TASK_TYPES } from "./task.repository.js";
import type { Task, TaskArchiveFilter, TaskQuery, TaskRepository, TaskResult, TaskStatus, TaskType } from "./task.repository.js";
const hoursFromNow = (hours: number): string => new Date(Date.now() + hours * 3600000).toISOString();
/** 操作人取网关注入的 x-user-id，与地块变更历史同一口径；缺省记为 system */
const actorOf = (req: IncomingMessage): string => req.headers["x-user-id"]?.toString() || "system";
/** 演示农事任务：覆盖六种作业类型与四种状态，任务调度页一进就能看到排程
 * startedAt/completedAt 与状态对齐（进行中的任务按计划时间开工，已完成的补一个作业时长），
 * 已取消的留一个取消时刻——迁移 016 的 CHECK 要求 CANCELLED 必有 cancelled_at，
 * 缺了它这行在 SQL 模式根本插不进去，两套模式的任务台账就会对不上（见迁移 030）。
 * 负责人与计划工时按迁移 030 的种子逐条对齐（scheduled_end_at = scheduled_at + 工时），
 * 内存种子缺这两列时，同一批演示任务在两套模式下会给出不同的排程视图。
 * 已知残留差异：030 的 result_json.finishedAreaMu 取自 plot_records.area_mu（地块台账现取），
 * 内存模式没有台账可读，已完成任务只能不带作业面积——宁缺勿造，不在种子里写死一个数。 */
const demoTasks: Omit<Task, "version">[] = [
  { id: "task-demo-001", tenantId: "tenant-demo", plotCode: "511723-000001-02-00005-0000-C", type: "IRRIGATION", name: "西区一号田补灌执行", status: "RUNNING", scheduledAt: hoursFromNow(-4), scheduledEndAt: hoursFromNow(-1), assigneeName: "张建国", createdAt: hoursFromNow(-8), startedAt: hoursFromNow(-4) },
  { id: "task-demo-002", tenantId: "tenant-demo", plotCode: "511723-000001-01-00003-0000-T", type: "SPRAYING", name: "东区三号田病虫害喷防", status: "PENDING", scheduledAt: hoursFromNow(6), scheduledEndAt: hoursFromNow(8), assigneeName: "李秀芳", createdAt: hoursFromNow(-10) },
  { id: "task-demo-003", tenantId: "tenant-demo", plotCode: "511723-000001-03-00009-0000-J", type: "FERTILIZATION", name: "联片二号田抽穗期追肥", status: "PENDING", scheduledAt: hoursFromNow(20), scheduledEndAt: hoursFromNow(24), assigneeName: "王德明", createdAt: hoursFromNow(-26) },
  { id: "task-demo-004", tenantId: "tenant-demo", plotCode: "511723-000001-04-00012-0000-D", type: "TILLAGE", name: "演练田耕整地作业", status: "PENDING", scheduledAt: hoursFromNow(30), scheduledEndAt: hoursFromNow(36), assigneeName: "赵光辉", createdAt: hoursFromNow(-30) },
  { id: "task-demo-005", tenantId: "tenant-demo", plotCode: "511723-000001-03-00010-0000-U", type: "WEEDING", name: "联片三号田除草作业", status: "RUNNING", scheduledAt: hoursFromNow(-2), scheduledEndAt: hoursFromNow(3), assigneeName: "陈利军", createdAt: hoursFromNow(-14), startedAt: hoursFromNow(-2) },
  { id: "task-demo-006", tenantId: "tenant-demo", plotCode: "511723-000001-01-00001-0000-5", type: "IRRIGATION", name: "东区一号田水肥一体化追肥", status: "COMPLETED", scheduledAt: hoursFromNow(-50), scheduledEndAt: hoursFromNow(-46), assigneeName: "张建国", createdAt: hoursFromNow(-60), startedAt: hoursFromNow(-50), completedAt: hoursFromNow(-46) },
  { id: "task-demo-007", tenantId: "tenant-demo", plotCode: "511723-000001-02-00007-0000-0", type: "SPRAYING", name: "西区三号田叶面肥喷施", status: "COMPLETED", scheduledAt: hoursFromNow(-96), scheduledEndAt: hoursFromNow(-93), assigneeName: "李秀芳", createdAt: hoursFromNow(-110), startedAt: hoursFromNow(-96), completedAt: hoursFromNow(-93) },
  { id: "task-demo-008", tenantId: "tenant-demo", plotCode: "511723-000001-01-00002-0000-Z", type: "SEEDING", name: "东区二号田机插秧", status: "CANCELLED", scheduledAt: hoursFromNow(-140), scheduledEndAt: hoursFromNow(-132), assigneeName: "王德明", createdAt: hoursFromNow(-150), cancelledAt: hoursFromNow(-141) },
];
class InputError extends Error {}
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status === 409 ? "OPS-409-001" : status >= 400 ? `OPERATION-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body));
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 1_048_576) throw new InputError("请求体过大"); chunks.push(Buffer.from(chunk)); }
  const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw new InputError(`${field}不能为空且不能超过${max}字`);
  return value.trim();
}
function time(value: unknown, field: string, dateOnly = false, end = false): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new InputError(`${field}格式非法`);
  let source = value;
  if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(source)) source += end ? "T23:59:59.999Z" : "T00:00:00.000Z";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(source) || !Number.isFinite(Date.parse(source))) throw new InputError(`${field}需为含时区的有效时间`);
  const day = source.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new InputError(`${field}日期非法`);
  return new Date(source).toISOString();
}
function integer(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new InputError("分页参数非法");
  return parsed;
}
function queryOf(query: URLSearchParams): TaskQuery {
  const result: TaskQuery = { page: integer(query.get("page"), 1, 1_000_000), size: integer(query.get("size"), 20, 200) };
  const status = query.get("status") === "IN_PROGRESS" ? "RUNNING" : query.get("status");
  const type = query.get("type");
  if (status) { if (!TASK_STATUSES.includes(status as TaskStatus)) throw new InputError("任务状态非法"); result.status = status as TaskStatus; }
  if (type) { if (!TASK_TYPES.includes(type as TaskType)) throw new InputError("任务类型非法"); result.type = type as TaskType; }
  if (query.get("keyword")) result.keyword = text(query.get("keyword"), "关键词", 200);
  if (query.get("plotCode")) result.plotCode = text(query.get("plotCode"), "地块编码", 100);
  const archived = query.get("archived");
  if (archived) {
    if (!TASK_ARCHIVE_FILTERS.includes(archived as TaskArchiveFilter)) throw new InputError("归档筛选非法");
    result.archived = archived as TaskArchiveFilter;
  }
  const from = time(query.get("from") || undefined, "开始日期", true);
  const to = time(query.get("to") || undefined, "结束日期", true, true);
  if (from) result.from = from;
  if (to) result.to = to;
  if (from && to && from > to) throw new InputError("开始日期不能晚于结束日期");
  return result;
}
function resultOf(value: unknown): TaskResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("完成任务必须填写实际作业结果");
  const result = value as Record<string, unknown>;
  if (!["success", "partial", "failed"].includes(String(result.outcome))) throw new InputError("作业结果非法");
  if (typeof result.finishedAreaMu !== "number" || !Number.isFinite(result.finishedAreaMu) || result.finishedAreaMu < 0) throw new InputError("实际作业面积必须为非负数");
  return { outcome: result.outcome as TaskResult["outcome"], finishedAreaMu: result.finishedAreaMu, notes: text(result.notes, "作业说明", 2000) };
}
export function createOperationHttpServer(options: { tasks?: TaskRepository } = {}): Server {
  const tasks = options.tasks ?? new InMemoryTaskRepository(demoTasks.map((task) => ({ ...task, version: 1 })));
  const navPlans = new Map<string, NavPlan[]>();
  const coveragePlans = new Map<string, CoveragePlan[]>();
  return createServer(async (req, res) => {
    const traceId = req.headers["x-request-id"]?.toString() || randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const tenantId = req.headers["x-tenant-id"]?.toString() || "tenant-demo";
    try {
      if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "operation" }, traceId); return; }
      const denied = authorizeRequest(req, { read: "operation:read", write: "operation:write" });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
      if (req.method === "GET" && url.pathname === "/api/v1/farm-tasks") { send(res, 200, await tasks.page(tenantId, queryOf(url.searchParams)), traceId); return; }
      if (req.method === "POST" && url.pathname === "/api/v1/farm-tasks") {
        const body = await json(req); const type = body.type ?? "IRRIGATION";
        if (!TASK_TYPES.includes(type as TaskType)) throw new InputError("任务类型非法");
        const task: Task = { id: randomUUID(), tenantId, plotCode: text(body.plotCode, "地块编码", 100, true), type: type as TaskType, name: text(body.name, "任务名称", 200, true), status: "PENDING", createdAt: new Date().toISOString(), version: 1 };
        const start = time(body.scheduledAt, "计划开始时间"); const end = time(body.scheduledEndAt, "计划结束时间");
        if (end && (!start || end <= start)) throw new InputError("计划结束时间必须晚于开始时间");
        if (start) task.scheduledAt = start;
        if (end) task.scheduledEndAt = end;
        const assigneeName = text(body.assigneeName, "负责人", 100);
        if (assigneeName) task.assigneeName = assigneeName;
        send(res, 201, await tasks.create(task, actorOf(req), traceId), traceId); return;
      }
      const statusMatch = url.pathname.match(/^\/api\/v1\/farm-tasks\/([^/]+)\/status$/);
      const detailMatch = url.pathname.match(/^\/api\/v1\/farm-tasks\/([^/]+)$/);
      const historyMatch = url.pathname.match(/^\/api\/v1\/farm-tasks\/([^/]+)\/history$/);
      if (historyMatch?.[1] && req.method === "GET") {
        // 变更历史是审计对象，归档任务也要能回查（留痕表不随 deleted_at 过滤）
        const logs = await tasks.history(tenantId, decodeURIComponent(historyMatch[1]));
        send(res, 200, logs, traceId); return;
      }
      if (statusMatch?.[1] && req.method === "POST") {
        const body = await json(req);
        const task = await tasks.find(tenantId, decodeURIComponent(statusMatch[1]));
        if (!task) { send(res, 404, null, traceId, "任务不存在"); return; }
        const status = body.status as TaskStatus;
        if (!TASK_STATUSES.includes(status)) throw new InputError("任务状态非法");
        if (task.status === status) { send(res, 200, task, traceId); return; }
        if (!canTransition(task.status, status) || (body.version !== undefined && body.version !== task.version)) { send(res, 409, null, traceId, "任务状态已变化或不允许该操作，请刷新后重试"); return; }
        const result = status === "COMPLETED" ? resultOf(body.result) : undefined;
        const updated = await tasks.transition(task, status, new Date().toISOString(), traceId, result, actorOf(req));
        if (!updated) { send(res, 409, null, traceId, "任务已被其他操作更新，请刷新后重试"); return; }
        send(res, 200, updated, traceId); return;
      }
      if (detailMatch?.[1] && req.method === "GET") {
        // 归档行默认仍读不到；带 includeArchived=true 才放行回查，跃迁与删除不受这个开关影响
        const includeArchived = url.searchParams.get("includeArchived") === "true";
        const task = await tasks.find(tenantId, decodeURIComponent(detailMatch[1]), includeArchived);
        send(res, task ? 200 : 404, task, traceId, task ? "" : "任务不存在"); return;
      }
      if (detailMatch?.[1] && req.method === "DELETE") {
        // 与地块/片区同一口径：删除是归档，行留在表里，列表与详情此后都读不到。
        // 不挡 RUNNING——地块软删同样不校验名下有没有在途作业，平台里「删除」只表示不再在册。
        const removed = await tasks.remove(tenantId, decodeURIComponent(detailMatch[1]), new Date().toISOString(), actorOf(req), traceId);
        send(res, removed ? 200 : 404, removed, traceId, removed ? "" : "任务不存在"); return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/operations/path-plan") {
        const parsed = parseNavigationRequest(await json(req));
        if (!parsed.ok || !parsed.input) throw new InputError(parsed.errors.join("；"));
        const plan = planNavigation(parsed.input); const plans = navPlans.get(tenantId) ?? [];
        plans.unshift(plan); if (plans.length > 20) plans.pop(); navPlans.set(tenantId, plans);
        send(res, 200, plan, traceId); return;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/operations/path-plans") { send(res, 200, navPlans.get(tenantId) ?? [], traceId); return; }
      if (req.method === "POST" && url.pathname === "/api/v1/operations/coverage-plan") {
        const parsed = parseCoverageRequest(await json(req));
        if (!parsed.ok || !parsed.input) throw new InputError(parsed.errors.join("；"));
        const plan = planCoverage(parsed.input); const plans = coveragePlans.get(tenantId) ?? [];
        plans.unshift(plan); if (plans.length > 20) plans.pop(); coveragePlans.set(tenantId, plans);
        send(res, 200, plan, traceId); return;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/operations/coverage-plans") { send(res, 200, coveragePlans.get(tenantId) ?? [], traceId); return; }
      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      const invalid = error instanceof InputError || error instanceof CoverageError || error instanceof SyntaxError || error instanceof URIError;
      send(res, invalid ? 400 : 500, null, traceId, invalid ? error.message : "任务服务处理失败");
    }
  });
}
