import { randomUUID } from "node:crypto";
import type { PrismaClientLike } from "@agri/db";
import type { PageResult, TaskCompletedPayload } from "@agri/contracts";
import { toIsoTimestamp } from "@agri/shared";

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
    const keyword = query.keyword?.toLowerCase();
    const filtered = this.tasks.filter((task) => {
      const at = Date.parse(task.scheduledAt ?? task.createdAt);
      return task.tenantId === tenantId && (!query.status || task.status === query.status) && (!query.type || task.type === query.type)
        && (!query.plotCode || task.plotCode === query.plotCode)
        && (!keyword || `${task.name} ${task.plotCode}`.toLowerCase().includes(keyword))
        && (!query.from || at >= Date.parse(query.from)) && (!query.to || at <= Date.parse(query.to));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: structuredClone(filtered.slice((query.page - 1) * query.size, query.page * query.size)), total: filtered.length, page: query.page, size: query.size, pages: Math.ceil(filtered.length / query.size) };
  }
  async find(tenantId: string, id: string): Promise<Task | null> {
    const task = this.tasks.find((row) => row.id === id && row.tenantId === tenantId);
    return task ? structuredClone(task) : null;
  }
  async create(task: Task): Promise<Task> { this.tasks.push(structuredClone(task)); return structuredClone(task); }
  async transition(task: Task, status: TaskStatus, at: string, traceId: string, result?: TaskResult): Promise<Task | null> {
    const stored = this.tasks.find((row) => row.id === task.id && row.tenantId === task.tenantId && row.version === task.version);
    if (!stored || !canTransition(stored.status, status)) return null;
    if (stored.status === status) return structuredClone(stored);
    if (status === "COMPLETED" && !result) return null;
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
}
function fromRow(row: Record<string, unknown>): Task {
  const task: Task = { id: String(row.id), tenantId: String(row.tenant_id), plotCode: String(row.plot_code), type: row.type as TaskType, name: String(row.name), status: row.status as TaskStatus, createdAt: toIsoTimestamp(row.created_at), version: Number(row.version) };
  for (const [column, key] of [["scheduled_at", "scheduledAt"], ["scheduled_end_at", "scheduledEndAt"], ["started_at", "startedAt"], ["completed_at", "completedAt"], ["cancelled_at", "cancelledAt"]] as const) {
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
    const where = ["tenant_id = $1"];
    for (const [column, value] of [["status", query.status], ["type", query.type], ["plot_code", query.plotCode]] as const) {
      if (value) { values.push(value); where.push(`${column} = $${values.length}`); }
    }
    if (query.keyword) { values.push(query.keyword.toLowerCase()); where.push(`strpos(lower(name || ' ' || plot_code), $${values.length}) > 0`); }
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
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT * FROM operation_tasks WHERE tenant_id = $1 AND id = $2", tenantId, id);
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
      WHERE tenant_id = $1 AND id = $2 AND version = $5 AND status = $10 RETURNING *
    ), queued AS (
      INSERT INTO operation_outbox (id, task_id, tenant_id, trace_id, payload_json, created_at)
      SELECT $7, id, tenant_id, $8, $9::jsonb, $4::timestamptz FROM changed WHERE status = 'COMPLETED' RETURNING id
    ) SELECT * FROM changed`, task.tenantId, task.id, status, at, task.version, result ? JSON.stringify(result) : null, randomUUID(), traceId,
    result ? JSON.stringify(completionPayload(task, at, result)) : null, task.status);
    return rows[0] ? fromRow(rows[0]) : null;
  }
}
