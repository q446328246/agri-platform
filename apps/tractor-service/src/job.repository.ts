import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/** 作业类型：与控制指令的作业类指令同源 */
export type TractorOperationType = "SEEDING" | "TILLAGE" | "WEEDING";

export const TRACTOR_OPERATION_TYPES: TractorOperationType[] = ["SEEDING", "TILLAGE", "WEEDING"];

/** 作业状态机：PLANNED 已排程 → RUNNING 作业中 → COMPLETED 完成 / PAUSED 安全暂停 / FAILED 失败 / ESTOPPED 急停终态；SAFETY_UNKNOWN 表示恢复结果未知，必须急停核实 */
export type TractorJobStatus = "PLANNED" | "RUNNING" | "PAUSED" | "SAFETY_UNKNOWN" | "COMPLETED" | "FAILED" | "ESTOPPED";

export const TRACTOR_JOB_STATUSES: TractorJobStatus[] = ["PLANNED", "RUNNING", "PAUSED", "SAFETY_UNKNOWN", "COMPLETED", "FAILED", "ESTOPPED"];

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
  /** 单调递增版本：跨实例等待控制确认期间用 CAS 拒绝过期写入 */
  revision: number;
  /** 执行周期版本：仅从非 RUNNING 进入 RUNNING 时递增，用于安全结果 fencing */
  runRevision: number;
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
  /** 该步的下发参数（换具带机具编码、作业带面积与时长），执行器据此下发 */
  parameters: Record<string, unknown>;
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
  tenantId: string;
  jobId: string;
  stage: TractorStageKind;
  commandType: string;
  /** 该步的下发参数，落库后执行器下发时原样带上 */
  parameters: Record<string, unknown>;
  /** 执行超时（毫秒），执行器据此判定等待收口 */
  timeoutMs: number;
}

export interface TractorJobQuery {
  tenantId: string;
  plotCode?: string;
  deviceId?: string;
  status?: TractorJobStatus;
  limit?: number;
  offset?: number;
}

/** CAS 条件：只有仍处于期望状态的作业/分步才允许推进，避免覆盖并发急停或重复回执。 */
export interface TractorJobUpdateOptions {
  expectedStatus?: TractorJobStatus | readonly TractorJobStatus[];
  expectedRevision?: number;
  expectedRunRevision?: number;
  /** 执行器写入必须持有当前租约，过期执行者不能覆盖接管者的状态 */
  owner?: string;
}

export interface TractorStageUpdateOptions {
  expectedStatus?: TractorStageStatus | readonly TractorStageStatus[];
  owner?: string;
}

export interface TractorJobRepository {
  createJob(tx: Tx | undefined, input: CreateTractorJobInput): Promise<TractorJob>;
  addStage(tx: Tx | undefined, input: CreateTractorStageInput): Promise<TractorJobStage>;
  listStages(tenantId: string, jobId: string): Promise<TractorJobStage[]>;
  findJob(tenantId: string, id: string): Promise<TractorJob | null>;
  listJobs(query: TractorJobQuery): Promise<TractorJob[]>;
  updateJob(tenantId: string, id: string, patch: Partial<Omit<TractorJob, "id" | "tenantId">>, options?: TractorJobUpdateOptions): Promise<TractorJob | null>;
  updateStage(tenantId: string, id: string, patch: Partial<Omit<TractorJobStage, "id" | "jobId">>, options?: TractorStageUpdateOptions): Promise<TractorJobStage | null>;
  claimJob(tenantId: string, id: string, owner: string, leaseMs: number, expectedStatus?: TractorJobStatus | readonly TractorJobStatus[]): Promise<TractorJob | null>;
  renewJobClaim(tenantId: string, id: string, owner: string, leaseMs: number): Promise<boolean>;
  releaseJobClaim(tenantId: string, id: string, owner: string): Promise<void>;
  withJobLock<T>(tenantId: string, id: string, action: () => Promise<T>): Promise<T>;
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
    revision: Number(row.revision ?? 0),
    runRevision: Number(row.run_revision ?? 0),
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
    parameters: (row.parameters ?? {}) as Record<string, unknown>,
    detail: String(row.detail ?? ""),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  if (row.command_id !== null && row.command_id !== undefined) stage.commandId = String(row.command_id);
  return stage;
}

function matchesStatus<T extends string>(status: T, expected: T | readonly T[] | undefined): boolean {
  return expected === undefined || (Array.isArray(expected) ? expected.includes(status) : status === expected);
}

/** 内存实现：仅供测试与降级路径，构造默认空库 */
export class InMemoryTractorJobRepository implements TractorJobRepository {
  private readonly jobs = new Map<string, TractorJob>();
  private readonly stages = new Map<string, TractorJobStage>();
  private readonly claims = new Map<string, { owner: string; until: number }>();

  async createJob(_tx: Tx | undefined, input: CreateTractorJobInput): Promise<TractorJob> {
    const now = new Date().toISOString();
    const job: TractorJob = {
      id: ulid(),
      ...input,
      status: "PLANNED",
      revision: 0,
      runRevision: 0,
      currentStage: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async addStage(_tx: Tx | undefined, input: CreateTractorStageInput): Promise<TractorJobStage> {
    if (this.jobs.get(input.jobId)?.tenantId !== input.tenantId) throw new Error("作业不存在或不属于当前租户");
    const now = new Date().toISOString();
    const stage: TractorJobStage = {
      id: ulid(),
      jobId: input.jobId,
      stage: input.stage,
      commandType: input.commandType,
      status: "PENDING",
      parameters: input.parameters,
      detail: JSON.stringify({ timeoutMs: input.timeoutMs }),
      createdAt: now,
      updatedAt: now,
    };
    this.stages.set(stage.id, structuredClone(stage));
    return structuredClone(stage);
  }

  async listStages(tenantId: string, jobId: string): Promise<TractorJobStage[]> {
    if (this.jobs.get(jobId)?.tenantId !== tenantId) return [];
    return [...this.stages.values()].filter((stage) => stage.jobId === jobId).map((stage) => structuredClone(stage));
  }

  async findJob(tenantId: string, id: string): Promise<TractorJob | null> {
    const job = this.jobs.get(id);
    return job?.tenantId === tenantId ? structuredClone(job) : null;
  }

  async listJobs(query: TractorJobQuery): Promise<TractorJob[]> {
    const offset = Math.max(0, query.offset ?? 0);
    return [...this.jobs.values()]
      .filter((job) => job.tenantId === query.tenantId
        && (query.plotCode === undefined || job.plotCode === query.plotCode)
        && (query.deviceId === undefined || job.deviceId === query.deviceId)
        && (query.status === undefined || job.status === query.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(offset, offset + (query.limit ?? 50))
      .map((job) => structuredClone(job));
  }

  private ownsActiveClaim(id: string, owner: string | undefined): boolean {
    if (owner === undefined) return true;
    const claim = this.claims.get(id);
    return claim?.owner === owner && claim.until > Date.now();
  }

  async updateJob(tenantId: string, id: string, patch: Partial<Omit<TractorJob, "id" | "tenantId">>, options?: TractorJobUpdateOptions): Promise<TractorJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId || !matchesStatus(job.status, options?.expectedStatus)
      || (options?.expectedRevision !== undefined && job.revision !== options.expectedRevision)
      || (options?.expectedRunRevision !== undefined && job.runRevision !== options.expectedRunRevision)
      || !this.ownsActiveClaim(id, options?.owner)) return null;
    const next: TractorJob = {
      ...job, ...patch, revision: job.revision + 1,
      runRevision: job.runRevision + (patch.status === "RUNNING" && job.status !== "RUNNING" ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async updateStage(tenantId: string, id: string, patch: Partial<Omit<TractorJobStage, "id" | "jobId">>, options?: TractorStageUpdateOptions): Promise<TractorJobStage | null> {
    const stage = this.stages.get(id);
    if (!stage || this.jobs.get(stage.jobId)?.tenantId !== tenantId || !matchesStatus(stage.status, options?.expectedStatus) || !this.ownsActiveClaim(stage.jobId, options?.owner)) return null;
    const next: TractorJobStage = { ...stage, ...patch, updatedAt: new Date().toISOString() };
    this.stages.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async claimJob(tenantId: string, id: string, owner: string, leaseMs: number, expectedStatus: TractorJobStatus | readonly TractorJobStatus[] = ["PLANNED", "RUNNING"]): Promise<TractorJob | null> {
    const job = this.jobs.get(id);
    const claim = this.claims.get(id);
    const now = Date.now();
    if (!job || job.tenantId !== tenantId || !matchesStatus(job.status, expectedStatus) || (claim && claim.until > now && claim.owner !== owner)) return null;
    this.claims.set(id, { owner, until: now + leaseMs });
    return structuredClone(job);
  }

  async renewJobClaim(tenantId: string, id: string, owner: string, leaseMs: number): Promise<boolean> {
    const job = this.jobs.get(id);
    const claim = this.claims.get(id);
    if (!job || job.tenantId !== tenantId || !claim || claim.owner !== owner || claim.until <= Date.now()) return false;
    claim.until = Date.now() + leaseMs;
    return true;
  }

  async releaseJobClaim(tenantId: string, id: string, owner: string): Promise<void> {
    if (this.jobs.get(id)?.tenantId === tenantId && this.claims.get(id)?.owner === owner) this.claims.delete(id);
  }

  async withJobLock<T>(_tenantId: string, _id: string, action: () => Promise<T>): Promise<T> {
    return action();
  }
}

/** SQL 实现：迁移 065 的 tractor_jobs / tractor_job_stages */
export class SqlTractorJobRepository implements TractorJobRepository {
  constructor(private readonly client: PrismaClientLike, private readonly jobLockTimeoutMs = 60_000) {}

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
      `INSERT INTO tractor_job_stages (id, job_id, stage, command_type, parameters, status, detail, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5::jsonb, 'PENDING', $6::text, $7, $7
       WHERE EXISTS (SELECT 1 FROM tractor_jobs WHERE id = $2 AND tenant_id = $8)
       RETURNING *`,
      ulid(), input.jobId, input.stage, input.commandType, JSON.stringify(input.parameters), JSON.stringify({ timeoutMs: input.timeoutMs }), now, input.tenantId,
    ) as Record<string, unknown>[];
    if (!rows[0]) throw new Error("作业不存在或不属于当前租户");
    return toStage(rows[0]);
  }

  async listStages(tenantId: string, jobId: string): Promise<TractorJobStage[]> {
    const rows = await this.client.$queryRawUnsafe(
      `SELECT s.* FROM tractor_job_stages s JOIN tractor_jobs j ON j.id = s.job_id
       WHERE s.job_id = $1 AND j.tenant_id = $2 ORDER BY s.created_at`,
      jobId, tenantId,
    ) as Record<string, unknown>[];
    return rows.map(toStage);
  }

  async findJob(tenantId: string, id: string): Promise<TractorJob | null> {
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM tractor_jobs WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      id, tenantId,
    ) as Record<string, unknown>[];
    return rows[0] ? toJob(rows[0]) : null;
  }

  async listJobs(query: TractorJobQuery): Promise<TractorJob[]> {
    const conditions: string[] = ["tenant_id = $1"];
    const params: unknown[] = [query.tenantId];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (query.plotCode !== undefined) add("plot_code = ?", query.plotCode);
    if (query.deviceId !== undefined) add("device_id = ?", query.deviceId);
    if (query.status !== undefined) add("status = ?", query.status);
    const where = ` WHERE ${conditions.join(" AND ")}`;
    params.push(Math.min(200, Math.max(1, query.limit ?? 50)));
    params.push(Math.max(0, Math.trunc(query.offset ?? 0)));
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM tractor_jobs${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params,
    ) as Record<string, unknown>[];
    return rows.map(toJob);
  }

  async updateJob(tenantId: string, id: string, patch: Partial<Omit<TractorJob, "id" | "tenantId">>, options?: TractorJobUpdateOptions): Promise<TractorJob | null> {
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
      else if (key === "startedAt" || key === "finishedAt") values.push(value === undefined ? null : (value instanceof Date ? value : new Date(String(value))));
      else values.push(value ?? null);
    }
    columns.push("updated_at");
    values.push(new Date());
    const queryParams: unknown[] = [];
    const conditions: string[] = [];
    const add = (sql: string, value: unknown): void => {
      queryParams.push(value);
      conditions.push(sql.replace("?", `$${values.length + queryParams.length}`));
    };
    add("tenant_id = ?", tenantId);
    add("id = ?", id);
    if (options?.owner !== undefined) {
      add("execution_owner = ?", options.owner);
      add("execution_until > ?", new Date());
    }
    if (options?.expectedStatus !== undefined) {
      const expected = Array.isArray(options.expectedStatus) ? options.expectedStatus : [options.expectedStatus];
      const statuses = expected.map((status) => {
        add("status = ?", status);
        return conditions.pop()!;
      });
      conditions.push(`(${statuses.join(" OR ")})`);
    }
    if (options?.expectedRevision !== undefined) add("revision = ?", options.expectedRevision);
    if (options?.expectedRunRevision !== undefined) add("run_revision = ?", options.expectedRunRevision);
    const runRevisionSet = patch.status === "RUNNING" ? ", run_revision = run_revision + CASE WHEN status <> 'RUNNING' THEN 1 ELSE 0 END" : "";
    const rows = await this.client.$queryRawUnsafe(
      `UPDATE tractor_jobs SET revision = revision + 1${runRevisionSet}, ${columns.map((column, index) => `${column} = $${index + 1}`).join(", ")} WHERE ${conditions.join(" AND ")} RETURNING *`,
      ...values, ...queryParams,
    ) as Record<string, unknown>[];
    return rows[0] ? toJob(rows[0]) : null;
  }

  async updateStage(tenantId: string, id: string, patch: Partial<Omit<TractorJobStage, "id" | "jobId">>, options?: TractorStageUpdateOptions): Promise<TractorJobStage | null> {
    const columns: string[] = [];
    const values: unknown[] = [];
    const map: Array<[keyof TractorJobStage, string]> = [
      ["stage", "stage"], ["commandType", "command_type"], ["commandId", "command_id"],
      ["status", "status"], ["parameters", "parameters"], ["detail", "detail"],
    ];
    for (const [key, column] of map) {
      if (!(key in patch)) continue;
      columns.push(column);
      if (column === "parameters") values.push(JSON.stringify(patch.parameters ?? {}));
      else values.push(patch[key as keyof typeof patch] ?? null);
    }
    columns.push("updated_at");
    values.push(new Date());
    const queryParams: unknown[] = [];
    const conditions: string[] = [];
    const add = (sql: string, value: unknown): void => {
      queryParams.push(value);
      conditions.push(sql.replace("?", `$${values.length + queryParams.length}`));
    };
    add("s.id = ?", id);
    add("j.tenant_id = ?", tenantId);
    if (options?.owner !== undefined) {
      add("j.execution_owner = ?", options.owner);
      add("j.execution_until > ?", new Date());
    }
    if (options?.expectedStatus !== undefined) {
      const expected = Array.isArray(options.expectedStatus) ? options.expectedStatus : [options.expectedStatus];
      const statuses = expected.map((status) => {
        add("s.status = ?", status);
        return conditions.pop()!;
      });
      conditions.push(`(${statuses.join(" OR ")})`);
    }
    const rows = await this.client.$queryRawUnsafe(
      `UPDATE tractor_job_stages s SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(", ")}
       FROM tractor_jobs j WHERE j.id = s.job_id AND ${conditions.join(" AND ")} RETURNING s.*`,
      ...values, ...queryParams,
    ) as Record<string, unknown>[];
    return rows[0] ? toStage(rows[0]) : null;
  }

  async claimJob(tenantId: string, id: string, owner: string, leaseMs: number, expectedStatus: TractorJobStatus | readonly TractorJobStatus[] = ["PLANNED", "RUNNING"]): Promise<TractorJob | null> {
    const now = new Date();
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const params: unknown[] = [tenantId, id, owner, now, new Date(now.getTime() + leaseMs), ...statuses];
    const rows = await this.client.$queryRawUnsafe(
      `UPDATE tractor_jobs SET execution_owner = $3, execution_until = $5
       WHERE tenant_id = $1 AND id = $2
         AND (execution_until IS NULL OR execution_until <= $4 OR execution_owner = $3)
         AND status IN (${statuses.map((_, index) => `$${index + 6}`).join(", ")})
       RETURNING *`,
      ...params,
    ) as Record<string, unknown>[];
    return rows[0] ? toJob(rows[0]) : null;
  }

  async renewJobClaim(tenantId: string, id: string, owner: string, leaseMs: number): Promise<boolean> {
    const rows = await this.client.$queryRawUnsafe(
      `UPDATE tractor_jobs SET execution_until = $3
       WHERE tenant_id = $1 AND id = $2 AND execution_owner = $4 AND execution_until > $5
       RETURNING id`,
      tenantId, id, new Date(Date.now() + leaseMs), owner, new Date(),
    ) as Array<{ id: string }>;
    return rows.length > 0;
  }

  async releaseJobClaim(tenantId: string, id: string, owner: string): Promise<void> {
    await this.client.$executeRawUnsafe(
      `UPDATE tractor_jobs SET execution_owner = NULL, execution_until = NULL
       WHERE tenant_id = $1 AND id = $2 AND execution_owner = $3`,
      tenantId, id, owner,
    );
  }

  async withJobLock<T>(tenantId: string, id: string, action: () => Promise<T>): Promise<T> {
    const key = `tractor-job:${tenantId}:${id}`;
    const deadline = Date.now() + this.jobLockTimeoutMs;
    let locked = false;
    try {
      while (!locked) {
        const rows = await this.client.$queryRawUnsafe<Array<{ locked: boolean }>>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked", key,
        );
        locked = rows[0]?.locked === true;
        if (locked) break;
        if (Date.now() >= deadline) throw new Error(`等待作业 ${id} 分布式锁超时`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return await action();
    } finally {
      if (locked) await this.client.$queryRawUnsafe("SELECT pg_advisory_unlock(hashtext($1))", key);
    }
  }
}
