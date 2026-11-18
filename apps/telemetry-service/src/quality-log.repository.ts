import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

import type { QualityFlag } from "./quality.js";

/**
 * 遥测质量异常日志仓储（A11，迁移 049）。
 *
 * 可疑读数仍落 telemetry_readings 保留现场原始值，这里只追加留痕：
 * 每条带标记的读数对应一条日志，供异常日志端点按设备/指标/标记回查。
 */

/** 质量异常日志记录 */
export interface QualityLog {
  id: string;
  readingId: string;
  deviceId: string;
  plotCode: string;
  metric: string;
  value: number;
  unit: string;
  recordedAt: string;
  flags: QualityFlag[];
  createdAt: string;
}

/** 日志查询条件 */
export interface QualityLogQuery {
  deviceId?: string;
  metric?: string;
  flag?: QualityFlag;
  limit?: number;
}

export interface QualityLogRepository {
  append(tx: unknown, log: QualityLog): Promise<QualityLog>;
  list(query: QualityLogQuery): Promise<QualityLog[]>;
  count(): Promise<number>;
}

function toLog(row: Record<string, unknown>): QualityLog {
  return {
    id: String(row.id),
    readingId: String(row.reading_id),
    deviceId: String(row.device_id),
    plotCode: String(row.plot_code ?? ""),
    metric: String(row.metric),
    value: Number(row.value),
    unit: String(row.unit ?? ""),
    recordedAt: toIsoTimestamp(row.recorded_at),
    flags: (Array.isArray(row.flags) ? row.flags.map(String) : []) as QualityFlag[],
    createdAt: toIsoTimestamp(row.created_at),
  };
}

/** PostgreSQL 实现，表结构由迁移 049 管理 */
export class SqlQualityLogRepository implements QualityLogRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async append(tx: unknown, log: QualityLog): Promise<QualityLog> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO telemetry_quality_logs (id, reading_id, device_id, plot_code, metric, value, unit, recorded_at, flags, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      log.id,
      log.readingId,
      log.deviceId,
      log.plotCode,
      log.metric,
      log.value,
      log.unit,
      log.recordedAt,
      JSON.stringify(log.flags),
      log.createdAt,
    );
    return log;
  }

  async list(query: QualityLogQuery): Promise<QualityLog[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.deviceId) { values.push(query.deviceId); conditions.push(`device_id = $${values.length}`); }
    if (query.metric) { values.push(query.metric); conditions.push(`metric = $${values.length}`); }
    if (query.flag) { values.push(JSON.stringify([query.flag])); conditions.push(`flags @> $${values.length}::jsonb`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    values.push(limit);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, reading_id, device_id, plot_code, metric, value, unit, recorded_at, flags, created_at
       FROM telemetry_quality_logs ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toLog);
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM telemetry_quality_logs`);
    return Number(rows[0]?.total ?? 0);
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryQualityLogRepository implements QualityLogRepository {
  private readonly rows: QualityLog[] = [];

  async append(_tx: unknown, log: QualityLog): Promise<QualityLog> {
    const row = structuredClone(log);
    this.rows.push(row);
    return structuredClone(row);
  }

  async list(query: QualityLogQuery): Promise<QualityLog[]> {
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    // 与 SQL 的 ORDER BY created_at DESC 同序同量
    return this.rows
      .filter((row) => (query.deviceId ? row.deviceId === query.deviceId : true))
      .filter((row) => (query.metric ? row.metric === query.metric : true))
      .filter((row) => (query.flag ? row.flags.includes(query.flag) : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}