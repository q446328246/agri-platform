import { randomUUID } from "node:crypto";
import type { PrismaClientLike } from "@agri/db";
import type { PageResult, TaskCompletedPayload } from "@agri/contracts";
import { keywordHits, likePattern, toIsoTimestamp } from "@agri/shared";
import { InMemoryTaskChangeLogRepository } from "./task-change-log.repository.js";
import type { TaskChangeLog, TaskChangeLogRepository } from "./task-change-log.repository.js";

export const TASK_TYPES = ["TILLAGE", "SEEDING", "IRRIGATION", "WEEDING", "SPRAYING", "FERTILIZATION"] as const;
export const TASK_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "CANCELLED"] as const;
/** 任务优先级：HIGH 紧急 / NORMAL 常规（缺省）/ LOW 可延后，与迁移 042 的 CHECK 同源 */
export const TASK_PRIORITIES = ["HIGH", "NORMAL", "LOW"] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];
/** 归档筛选：NONE 只看在册（缺省）、ONLY 只看已归档、ALL 两者都看 */
export const TASK_ARCHIVE_FILTERS = ["NONE", "ONLY", "ALL"] as const;
export type TaskArchiveFilter = typeof TASK_ARCHIVE_FILTERS[number];
export type TaskType = typeof TASK_TYPES[number];
export type TaskStatus = typeof TASK_STATUSES[number];
export interface TaskResult {
  outcome: "success" | "partial" | "failed";
  finishedAreaMu: number;
  notes: string;
}
export interface Task {
  id: string;
  tenantId: string;
  plotCode: string;
  type: TaskType;
  name: string;
  status: TaskStatus;
  /** 优先级，缺省 NORMAL；存量行由迁移 042 的默认值兜底 */
  priority?: TaskPriority;
  scheduledAt?: string;
  scheduledEndAt?: string;
  assigneeName?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  result?: TaskResult;
  version: number;
  /** 归档时刻。在册任务读不到这一列，与地块/片区软删同一口径。 */
  deletedAt?: string;
}
export interface TaskQuery {
  page: number;
  size: number;
  keyword?: string;
  status?: TaskStatus;
  type?: TaskType;
  priority?: TaskPriority;
  plotCode?: string;
  from?: string;
  to?: string;
  archived?: TaskArchiveFilter;
}
export interface TaskRepository {
  page(tenantId: string, query: TaskQuery): Promise<PageResult<Task>>;
  /** 缺省读不到归档行；includeArchived 只给回查用，跃迁与删除仍按在册口径 */
  find(tenantId: string, id: string, includeArchived?: boolean): Promise<Task | null>;
  /** actor 取网关注入的 x-user-id，缺省记为 system；traceId 随留痕落库便于对账 */
  create(task: Task, actor?: string, traceId?: string): Promise<Task>;
  transition(task: Task, status: TaskStatus, at: string, traceId: string, result?: TaskResult, actor?: string): Promise<Task | null>;
  /** 软删归档：只置 deleted_at，不改 status/version；已归档或不存在的任务返回 null */
  remove(tenantId: string, id: string, deletedAt: string, actor?: string, traceId?: string): Promise<Task | null>;
  /** 任务变更历史（追加式留痕），归档任务也可回查 */
  history(tenantId: string, taskId: string): Promise<TaskChangeLog[]>;
  /** 排程冲突提示：同地块或同负责人的在册任务计划时间重叠；只提示不阻断 */
  conflicts(tenantId: string, probe: ConflictProbe): Promise<TaskConflict[]>;
}
/** 冲突探测入参：新建任务或回查既有任务都用它描述待检查的排程 */
export interface ConflictProbe {
  /** 回查既有任务时排除自身 */
  id?: string;
  plotCode: string;
  assigneeName?: string;
  scheduledAt?: string;
  scheduledEndAt?: string;
}
/** 一条冲突：命中的在册任务与冲突缘由（同地块 / 同负责人） */
export interface TaskConflict {
  task: Task;
  reasons: string[];
}
/**
 * 冲突判定纯函数，两套仓储共用同一口径：
 * 只看在册（未归档）且未结束（PENDING/RUNNING）的任务；双方都给了计划开始时间
 * 才比较，时间窗按 [开始, 结束 ?? 开始] 闭区间判重叠。没排时间的任务无从判断
 * 冲突，不猜；负责人为空也不参与「同人」判定。
 */
export function conflictsOf(probe: ConflictProbe, rows: Task[]): TaskConflict[] {
  if (!probe.scheduledAt) return [];
  const start = Date.parse(probe.scheduledAt);
  const end = Date.parse(probe.scheduledEndAt ?? probe.scheduledAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const hits: TaskConflict[] = [];
  for (const row of rows) {
    if (row.id === probe.id || row.deletedAt !== undefined) continue;
    if (row.status !== "PENDING" && row.status !== "RUNNING") continue;
    if (!row.scheduledAt) continue;
    const rowStart = Date.parse(row.scheduledAt);
    const rowEnd = Date.parse(row.scheduledEndAt ?? row.scheduledAt);
    if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd)) continue;
    if (start > rowEnd || rowStart > end) continue;
    const reasons: string[] = [];
    if (row.plotCode === probe.plotCode) reasons.push("同地块计划时间重叠");
    if (probe.assigneeName && row.assigneeName === probe.assigneeName) reasons.push("同负责人计划时间重叠");
    if (reasons.length > 0) hits.push({ task: row, reasons });
  }
  return hits;
}
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ["RUNNING", "CANCELLED"], RUNNING: ["COMPLETED", "CANCELLED"], COMPLETED: [], CANCELLED: [],
};
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}
const EVENT_TYPES: Record<TaskType, TaskCompletedPayload["taskType"]> = {
  TILLAGE: "tillage", SEEDING: "sowing", IRRIGATION: "irrigation", WEEDING: "weeding", SPRAYING: "spraying", FERTILIZATION: "fertilization",
};
function completionPayload(task: Task, at: string, result: TaskResult): TaskCompletedPayload {
  return { taskId: task.id, parcelId: task.plotCode, taskType: EVENT_TYPES[task.type], result: result.outcome, finishedAreaMu: result.finishedAreaMu, finishedAt: at };
}
export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks: Task[];
  private readonly changeLog: TaskChangeLogRepository;
  readonly completedEvents: Array<{ tenantId: string; traceId: string; payload: TaskCompletedPayload }> = [];
  constructor(tasks: Task[] = [], changeLog: TaskChangeLogRepository = new InMemoryTaskChangeLogRepository()) {
    this.tasks = structuredClone(tasks);
    this.changeLog = changeLog;
  }
  async page(tenantId: string, query: TaskQuery): Promise<PageResult<Task>> {
    const archived = query.archived ?? "NONE";
    const filtered = this.tasks.filter((task) => {
      const at = Date.parse(task.scheduledAt ?? task.createdAt);
      const isArchived = task.deletedAt !== undefined;
      return task.tenantId === tenantId
        && (archived === "ALL" || (archived === "ONLY" ? isArchived : !isArchived))
        && (!query.status || task.status === query.status) && (!query.type || task.type === query.type)
        && (!query.priority || (task.priority ?? "NORMAL") === query.priority)
        && (!query.plotCode || task.plotCode === query.plotCode)
        && (!query.keyword || keywordHits(query.keyword, [task.name, task.plotCode]))
        && (!query.from || at >= Date.parse(query.from)) && (!query.to || at <= Date.parse(query.to));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: structuredClone(filtered.slice((query.page - 1) * query.size, query.page * query.size)), total: filtered.length, page: query.page, size: query.size, pages: Math.ceil(filtered.length / query.size) };
  }
  async find(tenantId: string, id: string, includeArchived = false): Promise<Task | null> {
    const task = this.tasks.find((row) => row.id === id && row.tenantId === tenantId && (includeArchived || row.deletedAt === undefined));
    return task ? structuredClone(task) : null;
  }
  async create(task: Task, actor = "system", traceId?: string): Promise<Task> {
    // 建档只写 SQL 侧 INSERT 的那几列：状态恒为 PENDING、版本从 1 起算，
    // 开工/完工/取消时刻与作业结果都由跃迁写入。照抄调用方塞进来的状态会让内存模式
    // 凭空出现「已完成」任务，而 SQL 模式压根不认这些列。
    const record: Task = {
      id: task.id,
      tenantId: task.tenantId,
      plotCode: task.plotCode,
      type: task.type,
      name: task.name,
      status: "PENDING",
      priority: task.priority ?? "NORMAL",
      ...(task.scheduledAt === undefined ? {} : { scheduledAt: task.scheduledAt }),
      ...(task.scheduledEndAt === undefined ? {} : { scheduledEndAt: task.scheduledEndAt }),
      ...(task.assigneeName === undefined ? {} : { assigneeName: task.assigneeName }),
      createdAt: task.createdAt,
      version: 1,
    };
    this.tasks.push(record);
    await this.changeLog.append({ id: randomUUID(), taskId: record.id, tenantId: record.tenantId, action: "CREATE", summary: `新建任务：${record.name}`, actor, ...(traceId === undefined ? {} : { traceId }), createdAt: record.createdAt });
    return structuredClone(record);
  }
  async transition(task: Task, status: TaskStatus, at: string, traceId: string, result?: TaskResult, actor = "system"): Promise<Task | null> {
    const stored = this.tasks.find((row) => row.id === task.id && row.tenantId === task.tenantId);
    // 跃迁合法性按调用方拿到的快照判定，与 SQL 侧 `canTransition(task.status, status)` 一致；
    // 已归档的行不在册，SQL 侧无论是幂等回读还是 UPDATE 都带 deleted_at IS NULL，这里同一口径拦掉
    if (!stored || stored.deletedAt !== undefined || !canTransition(task.status, status)) return null;
    // 重复提交同一状态是幂等重放，不看版本：SQL 侧在这里直接回读当前行，也不写留痕
    if (task.status === status) return structuredClone(stored);
    if (status === "COMPLETED" && !result) return null;
    // 真正的写入仍受乐观锁与快照状态约束（SQL 的 UPDATE 带 version 和 status 条件）
    if (stored.version !== task.version || stored.status !== task.status) return null;
    stored.status = status;
    stored.version += 1;
    if (status === "RUNNING") stored.startedAt = at;
    if (status === "CANCELLED") stored.cancelledAt = at;
    if (status === "COMPLETED" && result) {
      stored.completedAt = at;
      stored.result = structuredClone(result);
      this.completedEvents.push({ tenantId: stored.tenantId, traceId, payload: completionPayload(stored, at, result) });
    }
    await this.changeLog.append({ id: randomUUID(), taskId: stored.id, tenantId: stored.tenantId, action: "TRANSITION", summary: `状态流转：${task.status} → ${status}`, actor, traceId, createdAt: at });
    return structuredClone(stored);
  }
  async remove(tenantId: string, id: string, deletedAt: string, actor = "system", traceId?: string): Promise<Task | null> {
    const stored = this.tasks.find((row) => row.id === id && row.tenantId === tenantId && row.deletedAt === undefined);
    if (!stored) return null;
    // 归档只盖一个时间戳：status 记的是作业走到哪一步，version 记的是状态跃迁次数，
    // 都不该被删除动作改写，否则历史行读出来的状态与乐观锁基线就失真了。
    stored.deletedAt = deletedAt;
    await this.changeLog.append({ id: randomUUID(), taskId: stored.id, tenantId: stored.tenantId, action: "ARCHIVE", summary: "任务归档", actor, ...(traceId === undefined ? {} : { traceId }), createdAt: deletedAt });
    return structuredClone(stored);
  }
  async history(tenantId: string, taskId: string): Promise<TaskChangeLog[]> {
    return this.changeLog.listByTask(tenantId, taskId);
  }
  async conflicts(tenantId: string, probe: ConflictProbe): Promise<TaskConflict[]> {
    const candidates = this.tasks.filter((task) => task.tenantId === tenantId
      && (task.plotCode === probe.plotCode || (probe.assigneeName !== undefined && task.assigneeName === probe.assigneeName)));
    return conflictsOf(probe, structuredClone(candidates));
  }
}
function fromRow(row: Record<string, unknown>): Task {
  const task: Task = { id: String(row.id), tenantId: String(row.tenant_id), plotCode: String(row.plot_code), type: row.type as TaskType, name: String(row.name), status: row.status as TaskStatus, priority: (row.priority as TaskPriority) ?? "NORMAL", createdAt: toIsoTimestamp(row.created_at), version: Number(row.version) };
  for (const [column, key] of [["scheduled_at", "scheduledAt"], ["scheduled_end_at", "scheduledEndAt"], ["started_at", "startedAt"], ["completed_at", "completedAt"], ["cancelled_at", "cancelledAt"], ["deleted_at", "deletedAt"]] as const) {
    if (row[column] != null) task[key] = toIsoTimestamp(row[column]);
  }
  if (row.assignee_name != null) task.assigneeName = String(row.assignee_name);
  if (row.result_json != null) task.result = row.result_json as TaskResult;
  return task;
}
export class SqlTaskRepository implements TaskRepository {
  private readonly changeLog: TaskChangeLogRepository;
  constructor(private readonly client: PrismaClientLike, changeLog: TaskChangeLogRepository = new InMemoryTaskChangeLogRepository()) {
    this.changeLog = changeLog;
  }
  async page(tenantId: string, query: TaskQuery): Promise<PageResult<Task>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    // 归档条件同时进 count 与分页查询，总数与页内行数才不会各算一套
    if (query.archived === "ONLY") where.push("deleted_at IS NOT NULL");
    else if (query.archived !== "ALL") where.push("deleted_at IS NULL");
    for (const [column, value] of [["status", query.status], ["type", query.type], ["priority", query.priority], ["plot_code", query.plotCode]] as const) {
      if (value) { values.push(value); where.push(`${column} = $${values.length}`); }
    }
    // 逐字段字面量匹配，与内存模式的 keywordHits 同一口径；拼接 name 和 plot_code 会造出跨字段假命中
    if (query.keyword) { values.push(likePattern(query.keyword)); where.push(`(name ILIKE $${values.length} OR plot_code ILIKE $${values.length})`); }
    if (query.from) { values.push(query.from); where.push(`COALESCE(scheduled_at, created_at) >= $${values.length}::timestamptz`); }
    if (query.to) { values.push(query.to); where.push(`COALESCE(scheduled_at, created_at) <= $${values.length}::timestamptz`); }
    const filter = where.join(" AND ");
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM operation_tasks WHERE ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM operation_tasks WHERE ${filter} ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values);
    return { items: rows.map(fromRow), total, page: query.page, size: query.size, pages: Math.ceil(total / query.size) };
  }
  async find(tenantId: string, id: string, includeArchived = false): Promise<Task | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM operation_tasks WHERE tenant_id = $1 AND id = $2${includeArchived ? "" : " AND deleted_at IS NULL"}`,
      tenantId, id,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async remove(tenantId: string, id: string, deletedAt: string, actor = "system", traceId?: string): Promise<Task | null> {
    // 不 bump version、不改 status：归档只回答「还在不在册」，作业进度与并发基线仍按最后一次跃迁读。
    // 留痕与状态更新在同一条语句里完成：归档动作与「谁归档的」要么同时成立，要么都不发生。
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`WITH changed AS (
      UPDATE operation_tasks SET deleted_at = $3 WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING *
    ), logged AS (
      INSERT INTO operation_task_change_logs (id, task_id, tenant_id, action, summary, actor, trace_id, created_at)
        SELECT $4, id, tenant_id, 'ARCHIVE', '任务归档', $5, $6, $3::timestamptz FROM changed RETURNING id
    ) SELECT * FROM changed`, tenantId, id, deletedAt, randomUUID(), actor, traceId ?? null);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async create(task: Task, actor = "system", traceId?: string): Promise<Task> {
    // 建档与建档留痕一条语句写完，避免出现「任务建了、历史没记」的审计缺口
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`WITH ins AS (
      INSERT INTO operation_tasks (id, tenant_id, plot_code, type, name, status, priority, scheduled_at, scheduled_end_at, assignee_name, created_at, version)
        VALUES ($1, $2, $3, $4, $5, 'PENDING', $13, $6, $7, $8, $9, 1) RETURNING *
    ), logged AS (
      INSERT INTO operation_task_change_logs (id, task_id, tenant_id, action, summary, actor, trace_id, created_at)
        SELECT $10, id, tenant_id, 'CREATE', '新建任务：' || name, $11, $12, $9::timestamptz FROM ins RETURNING id
    ) SELECT * FROM ins`, task.id, task.tenantId, task.plotCode, task.type, task.name, task.scheduledAt ?? null, task.scheduledEndAt ?? null, task.assigneeName ?? null, task.createdAt, randomUUID(), actor, traceId ?? null, task.priority ?? "NORMAL");
    return fromRow(rows[0]!);
  }
  async transition(task: Task, status: TaskStatus, at: string, traceId: string, result?: TaskResult, actor = "system"): Promise<Task | null> {
    if (!canTransition(task.status, status)) return null;
    if (task.status === status) return this.find(task.tenantId, task.id);
    if (status === "COMPLETED" && !result) return null;
    // One statement keeps the status update, outbox 与留痕 atomic even on a shared pg connection.
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`WITH changed AS (
      UPDATE operation_tasks SET status = $3,
        started_at = CASE WHEN $3 = 'RUNNING' THEN $4::timestamptz ELSE started_at END,
        completed_at = CASE WHEN $3 = 'COMPLETED' THEN $4::timestamptz ELSE completed_at END,
        cancelled_at = CASE WHEN $3 = 'CANCELLED' THEN $4::timestamptz ELSE cancelled_at END,
        result_json = CASE WHEN $3 = 'COMPLETED' THEN $6::jsonb ELSE result_json END, version = version + 1
      WHERE tenant_id = $1 AND id = $2 AND version = $5 AND status = $10 AND deleted_at IS NULL RETURNING *
    ), queued AS (
      INSERT INTO operation_outbox (id, task_id, tenant_id, trace_id, payload_json, created_at)
      SELECT $7, id, tenant_id, $8, $9::jsonb, $4::timestamptz FROM changed WHERE status = 'COMPLETED' RETURNING id
    ), logged AS (
      INSERT INTO operation_task_change_logs (id, task_id, tenant_id, action, summary, actor, trace_id, created_at)
        SELECT $11, id, tenant_id, 'TRANSITION', '状态流转：' || $10 || ' → ' || $3, $12, $8, $4::timestamptz FROM changed RETURNING id
    ) SELECT * FROM changed`, task.tenantId, task.id, status, at, task.version, result ? JSON.stringify(result) : null, randomUUID(), traceId,
    result ? JSON.stringify(completionPayload(task, at, result)) : null, task.status, randomUUID(), actor);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async history(tenantId: string, taskId: string): Promise<TaskChangeLog[]> {
    return this.changeLog.listByTask(tenantId, taskId);
  }
  async conflicts(tenantId: string, probe: ConflictProbe): Promise<TaskConflict[]> {
    // 只捞可能命中的行（同地块或同负责人、在册未结束、排过时间），重叠判定与内存模式共用 conflictsOf
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM operation_tasks
       WHERE tenant_id = $1 AND deleted_at IS NULL AND status IN ('PENDING', 'RUNNING') AND scheduled_at IS NOT NULL
         AND (plot_code = $2 OR ($3::text IS NOT NULL AND assignee_name = $3))`,
      tenantId, probe.plotCode, probe.assigneeName ?? null,
    );
    return conflictsOf(probe, rows.map(fromRow));
  }
}
