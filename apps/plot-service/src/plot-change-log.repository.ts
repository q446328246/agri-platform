import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 地块变更历史（追加式留痕）。
 *
 * 只记「谁在什么时候对哪块地做了什么」，是一条只增不改的时间线：
 * 建档、改档案、重绘边界、删除各写一行，供地块详情页回看操作轨迹。
 *
 * 有意不存旧值快照也不做更新/删除：日志是被审计的对象，改它本身就应留痕，
 * 因此这里只追加。历史从启用留痕起记录，启用前的存量地块不回补（不伪造过去的操作）。
 */

/** 变更动作：建档 / 更新 / 删除 / 合并生成 / 拆分生成 */
export type PlotChangeAction = "CREATE" | "UPDATE" | "DELETE" | "MERGE" | "SPLIT";

export const PLOT_CHANGE_ACTIONS: PlotChangeAction[] = ["CREATE", "UPDATE", "DELETE", "MERGE", "SPLIT"];

export interface PlotChangeLog {
  id: string;
  /** 地块编码（plots.parcel_code） */
  parcelCode: string;
  tenantId: string;
  action: PlotChangeAction;
  /** 人类可读摘要，例如「修改：名称、边界」 */
  summary: string;
  /** 操作人，取网关注入的 x-user-id；缺省记为 system */
  actor: string;
  createdAt: string;
}

export interface PlotChangeLogRepository {
  append(tx: unknown, log: PlotChangeLog): Promise<PlotChangeLog>;
  /** 按地块倒序返回变更历史（最近在前） */
  listByPlot(tenantId: string, parcelCode: string): Promise<PlotChangeLog[]>;
}

const LOG_COLUMNS = "id, parcel_code, tenant_id, action, summary, actor, created_at";

function toLog(row: Record<string, unknown>): PlotChangeLog {
  return {
    id: String(row.id),
    parcelCode: String(row.parcel_code),
    tenantId: String(row.tenant_id ?? "tenant-demo"),
    action: String(row.action) as PlotChangeAction,
    summary: String(row.summary ?? ""),
    actor: String(row.actor ?? "system"),
    createdAt: toIsoTimestamp(row.created_at),
  };
}

/** PostgreSQL 实现，表结构由迁移 027 管理 */
export class SqlPlotChangeLogRepository implements PlotChangeLogRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async append(_tx: unknown, log: PlotChangeLog): Promise<PlotChangeLog> {
    await this.executor(_tx).$executeRawUnsafe(
      `INSERT INTO plot_change_logs (id, parcel_code, tenant_id, action, summary, actor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      log.id,
      log.parcelCode,
      log.tenantId,
      log.action,
      log.summary,
      log.actor,
      log.createdAt,
    );
    return log;
  }

  async listByPlot(tenantId: string, parcelCode: string): Promise<PlotChangeLog[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${LOG_COLUMNS} FROM plot_change_logs WHERE tenant_id = $1 AND parcel_code = $2 ORDER BY created_at DESC, id DESC`,
      tenantId,
      parcelCode,
    );
    return rows.map(toLog);
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryPlotChangeLogRepository implements PlotChangeLogRepository {
  private readonly rows: PlotChangeLog[] = [];

  constructor(seed: PlotChangeLog[] = []) {
    this.rows.push(...seed.map((row) => structuredClone(row)));
  }

  async append(_tx: unknown, log: PlotChangeLog): Promise<PlotChangeLog> {
    const row = structuredClone(log);
    this.rows.push(row);
    return structuredClone(row);
  }

  async listByPlot(tenantId: string, parcelCode: string): Promise<PlotChangeLog[]> {
    // 与 SQL 的 ORDER BY created_at DESC, id DESC 同序，并深拷贝：留痕里的 before/after 是嵌套对象
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.parcelCode === parcelCode)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((row) => structuredClone(row));
  }
}
