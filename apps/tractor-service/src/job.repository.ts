import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/** 作业类型：与控制指令的作业类指令同源 */
export type TractorOperationType = "SEEDING" | "TILLAGE" | "WEEDING";

export const TRACTOR_OPERATION_TYPES: TractorOperationType[] = ["SEEDING", "TILLAGE", "WEEDING"];

/** 作业状态机：PLANNED 已排程 → RUNNING 作业中 → COMPLETED 完成 / PAUSED 安全暂停 / FAILED 失败 / ESTOPPED 急停终态 */
export type TractorJobStatus = "PLANNED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "ESTOPPED";

export const TRACTOR_JOB_STATUSES: TractorJobStatus[] = ["PLANNED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "ESTOPPED"];

/** 分步类型：换具 → 作业 → 返航 */
export type TractorStageKind = "TOOL_SWITCH" | "OPERATION" | "RETURN_HOME";

export type TractorStageStatus = "PENDING" | "SENT" | "DONE" | "FAILED" | "SKIPPED";

/** 拖拉机作业：一次作业的编排留痕，含分步指令序列 */
export interface TractorJob {
  id: string;
  tenantId: string;
  plotCode: string;
  deviceId: string;
  operationType: TractorOperationType;
  parameters: Record<string, unknown>;
  status: TractorJobStatus;
  /** 已完成分步数，执行器据此断点续跑 */
  currentStage: number;
  operator: string;
  reason: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 分步指令：每步挂一条控制侧指令，复用其生命周期 */
export interface TractorJobStage {
  id: string;
  jobId: string;
  stage: TractorStageKind;
  commandType: string;
  commandId?: string;
  status: TractorStageStatus;
  /** 执行备注：下发结果、等待超时等 */
  detail: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTractorJobInput {
  tenantId: string;
  plotCode: string;
  deviceId: string;
  operationType: TractorOperationType;
  parameters: Record<string, unknown>;
  operator: string;
  reason: string;
}

export interface CreateTractorStageInput {
  jobId: string;
  stage: TractorStageKind;
  commandType: string;
  /** 执行超时（毫秒），执行器据此判定等待收口 */
  timeoutMs: number;
}

export interface TractorJobQuery {
  plotCode?: string;
  deviceId?: string;
  status?: TractorJobStatus;
  limit?: number;
}

export interface TractorJobRepository {
  createJob(tx: Tx | undefined, input: CreateTractorJobInput): Promise<TractorJob>;
  addStage(tx: Tx | undefined, input: CreateTractorStageInput): Promise<TractorJobStage>;
  listStages(jobId: string): Promise<TractorJobStage[]>;
  findJob(id: string): Promise<TractorJob | null>;
  listJobs(query: TractorJobQuery): Promise<TractorJob[]>;
  updateJob(tx: Tx | undefined, id: string, patch: Partial<Omit<TractorJob, "id" | "tenantId">>): Promise<TractorJob | null>;
  updateStage(tx: Tx | undefined, id: string, patch: Partial<Omit<TractorJobStage, "id" | "jobId">>): Promise<TractorJobStage | null>;
}

function toJob(row: Record<string, unknown>): TractorJob {
  const job: TractorJob = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    plotCode: String(row.plot_code),
    deviceId: String(row.device_id),
    operationType: String(row.operation_type) as TractorOperationType,
    parameters: (row.parameters ?? {}) as Record<string, unknown>,
    status: String(row.status) as TractorJobStatus,
    currentStage: Number(row.current_stage),
    operator: String(row.operator ?? ""),
    reason: String(row.reason ?? ""),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  if (row.started_at !== null && row.started_at !== undefined) job.startedAt = toIsoTimestamp(row.started_at);
  if (row.finished_at !== null && row.finished_at !== undefined) job.finishedAt = toIsoTimestamp(row.finished_at);
  return job;
}

function toStage(row: Record<string, unknown>): TractorJobStage {
  const stage: TractorJobStage = {
    id: String(row.id),
    jobId: String(row.job_id),
    stage: String(row.stage) as TractorStageKind,
    commandType: String(row.command_type),
    status: String(row.status) as TractorStageStatus,
    detail: String(row.detail ?? ""),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  if (row.command_id !== null && row.command_id !== undefined) stage.commandId = String(row.command_id);
  return stage;
}

/** 内存实现：仅供测试与降级路径，构造默认空库 */
export class InMemoryTractorJobRepository implements TractorJobRepository {
  private readonly jobs = new Map<string, TractorJob>();
  private readonly stages = new Map<string, TractorJobStage>();

  async createJob(_tx: Tx | undefined, input: CreateTractorJobInput): Promise<TractorJob> {
    const now = new Date().toISOString();
    const job: TractorJob = {
      id: ulid(),
      ...input,
      status: "PLANNED",
      currentStage: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async addStage(_tx: Tx | undefined, input: CreateTractorStageInput): Promise<TractorJobStage> {
    const now = new Date().toISOString();
    const stage: TractorJobStage = {
      id: ulid(),
      jobId: input.jobId,
      stage: input.stage,
      commandType: input.commandType,
      status: "PENDING",
      detail: JSON.stringify({ timeoutMs: input.timeoutMs }),
      createdAt: now,
      updatedAt: now,
    };
    this.stages.set(stage.id, structuredClone(stage));
    return structuredClone(stage);
  }

  async listStages(jobId: string): Promise<TractorJobStage[]> {
    return [...this.stages.values()].filter((stage) => stage.jobId === jobId).map((stage) => structuredClone(stage));
  }

  async findJob(id: string): Promise<TractorJob | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async listJobs(query: TractorJobQuery): Promise<TractorJob[]> {
    return [...this.jobs.values()]
      .filter((job) => (query.plotCode === undefined || job.plotCode === query.plotCode)
        && (query.deviceId === undefined || job.deviceId === query.deviceId)
        && (query.status === undefined || job.status === query.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, query.limit ?? 50)
      .map((job) => structuredClone(job));
  }

  async updateJob(_tx: Tx | undefined, id: string, patch: Partial<Omit<TractorJob, "id" | "tenantId">>): Promise<TractorJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const next: TractorJob = { ...job, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async updateStage(_tx: Tx | undefined, id: string, patch: Partial<Omit<TractorJobStage, "id" | "jobId">>): Promise<TractorJobStage | null> {
    const stage = this.stages.get(id);
    if (!stage) return null;
    const next: TractorJobStage = { ...stage, ...patch, updatedAt: new Date().toISOString() };
    this.stages.set(id, structuredClone(next));
    return structuredClone(next);
  }
}

/** SQL 实现：迁移 065 的 tractor_jobs / tractor_job_stages */
export class SqlTractorJobRepository implements TractorJobRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async createJob(tx: Tx | undefined, input: CreateTractorJobInput): Promise<TractorJob> {
    const client = tx ?? this.client;
    const now = new Date();
    const rows = await client.$queryRawUnsafe(
      `INSERT INTO tractor_jobs (id, tenant_id, plot_code, device_id, operation_type, parameters, status, current_stage, operator, reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PLANNED', 0, $7, $8, $9, $9)
       RETURNING *`,
      ulid(), input.tenantId, input.plotCode, input.deviceId, input.operationType, JSON.stringify(input.parameters), input.operator, input.reason, now,
    ) as Record<string, unknown>[];
    return toJob(rows[0]!);
  }

  async addStage(tx: Tx | undefined, input: CreateTractorStageInput): Promise<TractorJobStage> {
    const client = tx ?? this.client;
    const now = new Date();
    const rows = await client.$queryRawUnsafe(
      `INSERT INTO tractor_job_stages (id, job_id, stage, command_type, status, detail, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5::text, $6, $6)
       RETURNING *`,
      ulid(), input.jobId, input.stage, input.commandType, JSON.stringify({ timeoutMs: input.timeoutMs }), now,
    ) as Record<string, unknown>[];
    return toStage(rows[0]!);
  }

  async listStages(jobId: string): Promise<TractorJobStage[]> {
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM tractor_job_stages WHERE job_id = $1 ORDER BY created_at`,
      jobId,
    ) as Record<string, unknown>[];
    return rows.map(toStage);
  }

  async findJob(id: string): Promise<TractorJob | null> {
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM tractor_jobs WHERE id = $1 LIMIT 1`,
      id,
    ) as Record<string, unknown>[];
    return rows[0] ? toJob(rows[0]) : null;
  }

  async listJobs(query: TractorJobQuery): Promise<TractorJob[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (query.plotCode !== undefined) add("plot_code = ?", query.plotCode);
    if (query.deviceId !== undefined) add("device_id = ?", query.deviceId);
    if (query.status !== undefined) add("status = ?", query.status);
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(200, Math.max(1, query.limit ?? 50)));
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM tractor_jobs${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      ...params,
    ) as Record<string, unknown>[];
    return rows.map(toJob);
  }

  async updateJob(tx: Tx | undefined, id: string, patch: Partial<Omit<TractorJob, "id" | "tenantId">>): Promise<TractorJob | null> {
    const client = tx ?? this.client;
    const columns: string[] = [];
    const values: unknown[] = [];
    const map: Array<[keyof TractorJob, string]> = [
      ["plotCode", "plot_code"], ["deviceId", "device_id"], ["operationType", "operation_type"],
      ["parameters", "parameters"], ["status", "status"], ["currentStage", "current_stage"],
      ["operator", "operator"], ["reason", "reason"], ["startedAt", "started_at"], ["finishedAt", "finished_at"],
    ];
    for (const [key, column] of map) {
      if (!(key in patch)) continue;
      columns.push(column);
      const value = patch[key as keyof typeof patch];
      if (column === "parameters" && value !== undefined) values.push(JSON.stringify(value));
      // 只有时间列转 Date；文本列原样下传，避免空串被 new Date("") 解析成无效时间
      else if (key === "startedAt" || key === "finishedAt") values.push(value === undefined ? null : (value instanceof Date ? value : new Date(String(value))));
      else values.push(value ?? null);
    }
    if (columns.length === 0) return this.findJob(id);
    columns.push("updated_at");
    values.push(new Date());
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await client.$queryRawUnsafe(
      `UPDATE tractor_jobs SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(", ")} WHERE id = $${columns.length + 1} RETURNING *`,
      ...values, id,
    ) as Record<string, unknown>[];
    return rows[0] ? toJob(rows[0]) : null;
  }

  async updateStage(tx: Tx | undefined, id: string, patch: Partial<Omit<TractorJobStage, "id" | "jobId">>): Promise<TractorJobStage | null> {
    const client = tx ?? this.client;
    const columns: string[] = [];
    const values: unknown[] = [];
    const map: Array<[keyof TractorJobStage, string]> = [
      ["stage", "stage"], ["commandType", "command_type"], ["commandId", "command_id"],
      ["status", "status"], ["detail", "detail"],
    ];
    for (const [key, column] of map) {
      if (!(key in patch)) continue;
      columns.push(column);
      values.push(patch[key as keyof typeof patch] ?? null);
    }
    if (columns.length === 0) {
      const rows = await client.$queryRawUnsafe(`SELECT * FROM tractor_job_stages WHERE id = $1 LIMIT 1`, id) as Record<string, unknown>[];
      return rows[0] ? toStage(rows[0]) : null;
    }
    columns.push("updated_at");
    values.push(new Date());
    const rows = await client.$queryRawUnsafe(
      `UPDATE tractor_job_stages SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(", ")} WHERE id = $${columns.length + 1} RETURNING *`,
      ...values, id,
    ) as Record<string, unknown>[];
    return rows[0] ? toStage(rows[0]) : null;
  }
}
