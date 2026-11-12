import { randomUUID } from "node:crypto";
import type { PrismaClientLike } from "@agri/db";
import type { PageResult, TaskCompletedPayload } from "@agri/contracts";
import { keywordHits, likePattern, toIsoTimestamp } from "@agri/shared";

export const TASK_TYPES = ["TILLAGE", "SEEDING", "IRRIGATION", "WEEDING", "SPRAYING", "FERTILIZATION"] as const;
export const TASK_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "CANCELLED"] as const;
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
  plotCode?: string;
  from?: string;
  to?: string;
}
export interface TaskRepository {
  page(tenantId: string, query: TaskQuery): Promise<PageResult<Task>>;
  find(tenantId: string, id: string): Promise<Task | null>;
  create(task: Task): Promise<Task>;
  transition(task: Task, status: TaskStatus, at: string, traceId: string, result?: TaskResult): Promise<Task | null>;
  /** 软删归档：只置 deleted_at，不改 status/version；已归档或不存在的任务返回 null */
  remove(tenantId: string, id: string, deletedAt: string): Promise<Task | null>;
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
  readonly completedEvents: Array<{ tenantId: string; traceId: string; payload: TaskCompletedPayload }> = [];
  constructor(tasks: Task[] = []) { this.tasks = structuredClone(tasks); }
  async page(tenantId: string, query: TaskQuery): Promise<PageResult<Task>> {
    const filtered = this.tasks.filter((task) => {
      const at = Date.parse(task.scheduledAt ?? task.createdAt);
      return task.tenantId === tenantId && task.deletedAt === undefined
        && (!query.status || task.status === query.status) && (!query.type || task.type === query.type)
        && (!query.plotCode || task.plotCode === query.plotCode)
        && (!query.keyword || keywordHits(query.keyword, [task.name, task.plotCode]))
        && (!query.from || at >= Date.parse(query.from)) && (!query.to || at <= Date.parse(query.to));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: structuredClone(filtered.slice((query.page - 1) * query.size, query.page * query.size)), total: filtered.length, page: query.page, size: query.size, pages: Math.ceil(filtered.length / query.size) };
  }
  async find(tenantId: string, id: string): Promise<Task | null> {
    const task = this.tasks.find((row) => row.id === id && row.tenantId === tenantId && row.deletedAt === undefined);
    return task ? structuredClone(task) : null;
  }
  async create(task: Task): Promise<Task> {
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
      ...(task.scheduledAt === undefined ? {} : { scheduledAt: task.scheduledAt }),
      ...(task.scheduledEndAt === undefined ? {} : { scheduledEndAt: task.scheduledEndAt }),
      ...(task.assigneeName === undefined ? {} : { assigneeName: task.assigneeName }),
      createdAt: task.createdAt,
      version: 1,
    };
    this.tasks.push(record);
    return structuredClone(record);
  }
  async transition(task: Task, status: TaskStatus, at: string, traceId: string, result?: TaskResult): Promise<Task | null> {
    const stored = this.tasks.find((row) => row.id === task.id && row.tenantId === task.tenantId);
    // 跃迁合法性按调用方拿到的快照判定，与 SQL 侧 `canTransition(task.status, status)` 一致；
    // 已归档的行不在册，SQL 侧无论是幂等回读还是 UPDATE 都带 deleted_at IS NULL，这里同一口径拦掉
    if (!stored || stored.deletedAt !== undefined || !canTransition(task.status, status)) return null;
    // 重复提交同一状态是幂等重放，不看版本：SQL 侧在这里直接回读当前行
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
    return structuredClone(stored);
  }
  async remove(tenantId: string, id: string, deletedAt: string): Promise<Task | null> {
    const stored = this.tasks.find((row) => row.id === id && row.tenantId === tenantId && row.deletedAt === undefined);
    if (!stored) return null;
    // 归档只盖一个时间戳：status 记的是作业走到哪一步，version 记的是状态跃迁次数，
    // 都不该被删除动作改写，否则历史行读出来的状态与乐观锁基线就失真了。
    stored.deletedAt = deletedAt;
    return structuredClone(stored);
  }
}
function fromRow(row: Record<string, unknown>): Task {
  const task: Task = { id: String(row.id), tenantId: String(row.tenant_id), plotCode: String(row.plot_code), type: row.type as TaskType, name: String(row.name), status: row.status as TaskStatus, createdAt: toIsoTimestamp(row.created_at), version: Number(row.version) };
  for (const [column, key] of [["scheduled_at", "scheduledAt"], ["scheduled_end_at", "scheduledEndAt"], ["started_at", "startedAt"], ["completed_at", "completedAt"], ["cancelled_at", "cancelledAt"], ["deleted_at", "deletedAt"]] as const) {
    if (row[column] != null) task[key] = toIsoTimestamp(row[column]);
  }
  if (row.assignee_name != null) task.assigneeName = String(row.assignee_name);
  if (row.result_json != null) task.result = row.result_json as TaskResult;
  return task;
}
export class SqlTaskRepository implements TaskRepository {
  constructor(private readonly client: PrismaClientLike) {}
  async page(tenantId: string, query: TaskQuery): Promise<PageResult<Task>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1", "deleted_at IS NULL"];
    for (const [column, value] of [["status", query.status], ["type", query.type], ["plot_code", query.plotCode]] as const) {
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
  async find(tenantId: string, id: string): Promise<Task | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      "SELECT * FROM operation_tasks WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
      tenantId, id,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async remove(tenantId: string, id: string, deletedAt: string): Promise<Task | null> {
    // 不 bump version、不改 status：归档只回答「还在不在册」，作业进度与并发基线仍按最后一次跃迁读。
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      "UPDATE operation_tasks SET deleted_at = $3 WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING *",
      tenantId, id, deletedAt,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async create(task: Task): Promise<Task> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`INSERT INTO operation_tasks (id, tenant_id, plot_code, type, name, status, scheduled_at, scheduled_end_at, assignee_name, created_at, version)
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, 1) RETURNING *`, task.id, task.tenantId, task.plotCode, task.type, task.name, task.scheduledAt ?? null, task.scheduledEndAt ?? null, task.assigneeName ?? null, task.createdAt);
    return fromRow(rows[0]!);
  }
  async transition(task: Task, status: TaskStatus, at: string, traceId: string, result?: TaskResult): Promise<Task | null> {
    if (!canTransition(task.status, status)) return null;
    if (task.status === status) return this.find(task.tenantId, task.id);
    if (status === "COMPLETED" && !result) return null;
    // One statement keeps the status update and outbox atomic even on a shared pg connection.
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
    ) SELECT * FROM changed`, task.tenantId, task.id, status, at, task.version, result ? JSON.stringify(result) : null, randomUUID(), traceId,
    result ? JSON.stringify(completionPayload(task, at, result)) : null, task.status);
    return rows[0] ? fromRow(rows[0]) : null;
  }
}
