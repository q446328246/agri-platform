import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 农事任务变更历史（追加式留痕）。
 *
 * 只记「谁在什么时候对哪个任务做了什么」，是一条只增不改的时间线：
 * 建档、状态跃迁、归档删除各写一行，供任务详情页回看操作轨迹。
 *
 * 有意不存旧值快照、不做更新/删除：日志是被审计的对象，改它本身就应留痕，
 * 因此这里只追加。历史从迁移 039 起记录，启用前的存量任务不回补（不伪造过去的操作）。
 * actor 取网关注入的 x-user-id，系统内部触发时记为 system，与地块变更历史同一口径。
 */

/** 变更动作：建档 / 状态跃迁 / 归档删除 */
export type TaskChangeAction = "CREATE" | "TRANSITION" | "ARCHIVE";

export const TASK_CHANGE_ACTIONS: TaskChangeAction[] = ["CREATE", "TRANSITION", "ARCHIVE"];

export interface TaskChangeLog {
  id: string;
  /** 任务编号（operation_tasks.id） */
  taskId: string;
  tenantId: string;
  action: TaskChangeAction;
  /** 人类可读摘要，例如「状态流转：PENDING → RUNNING」 */
  summary: string;
  /** 操作人，取网关注入的 x-user-id；缺省记为 system */
  actor: string;
  /** 请求追踪号，与任务变更同一次调用带入 */
  traceId?: string;
  createdAt: string;
}

export interface TaskChangeLogRepository {
  append(log: TaskChangeLog): Promise<TaskChangeLog>;
  /** 按任务倒序返回变更历史（最近在前）；归档任务也要能回查，不随 deleted_at 过滤 */
  listByTask(tenantId: string, taskId: string): Promise<TaskChangeLog[]>;
}

const LOG_COLUMNS = "id, task_id, tenant_id, action, summary, actor, trace_id, created_at";

function toLog(row: Record<string, unknown>): TaskChangeLog {
  const log: TaskChangeLog = {
    id: String(row.id),
    taskId: String(row.task_id),
    tenantId: String(row.tenant_id ?? "tenant-demo"),
    action: String(row.action) as TaskChangeAction,
    summary: String(row.summary ?? ""),
    actor: String(row.actor ?? "system"),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.trace_id != null) log.traceId = String(row.trace_id);
  return log;
}

/** PostgreSQL 实现，表结构由迁移 039 管理 */
export class SqlTaskChangeLogRepository implements TaskChangeLogRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async append(log: TaskChangeLog): Promise<TaskChangeLog> {
    await this.client.$executeRawUnsafe(
      `INSERT INTO operation_task_change_logs (id, task_id, tenant_id, action, summary, actor, trace_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      log.id,
      log.taskId,
      log.tenantId,
      log.action,
      log.summary,
      log.actor,
      log.traceId ?? null,
      log.createdAt,
    );
    return log;
  }

  async listByTask(tenantId: string, taskId: string): Promise<TaskChangeLog[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${LOG_COLUMNS} FROM operation_task_change_logs WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at DESC, id DESC`,
      tenantId,
      taskId,
    );
    return rows.map(toLog);
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryTaskChangeLogRepository implements TaskChangeLogRepository {
  private readonly rows: TaskChangeLog[] = [];

  constructor(seed: TaskChangeLog[] = []) {
    this.rows.push(...seed.map((row) => structuredClone(row)));
  }

  async append(log: TaskChangeLog): Promise<TaskChangeLog> {
    const row = structuredClone(log);
    this.rows.push(row);
    return structuredClone(row);
  }

  async listByTask(tenantId: string, taskId: string): Promise<TaskChangeLog[]> {
    // 与 SQL 的 ORDER BY created_at DESC, id DESC 同序，并深拷贝：留痕是嵌套结构，避免调用方改到内部行
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((row) => structuredClone(row));
  }
}
