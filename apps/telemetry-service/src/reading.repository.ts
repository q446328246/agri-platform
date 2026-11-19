import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

import type { QualityFlag } from "./quality.js";

/** 遥测读数 */
export interface Reading {
  id: string;
  deviceId: string;
  plotCode: string;
  metric: string;
  value: number;
  unit: string;
  recordedAt: string;
  /** 土壤分层深度（厘米）；非分层指标缺省 */
  depthCm?: number;
  /** 质量标记（迁移 049）；干净读数缺省，带标记表示可疑 */
  qualityFlags?: QualityFlag[];
}

/** 遥测告警 */
export interface TelemetryAlert {
  id: string;
  deviceId: string;
  plotCode: string;
  level: string;
  metric: string;
  message: string;
  createdAt: string;
  handled: boolean;
  handledAt?: string;
}

/** 新增读数入参 */
export interface CreateReadingInput {
  deviceId: string;
  plotCode: string;
  metric: string;
  value: number;
  unit: string;
  recordedAt: string;
  depthCm?: number;
  qualityFlags?: QualityFlag[];
}

/** 历史查询条件 */
export interface HistoryQuery {
  deviceId?: string;
  metric?: string;
  from?: string;
  to?: string;
  limit?: number;
  plotCode?: string;
  depthCm?: number;
  /** 曲线是否包含可疑读数；缺省剔除，原始 history 不受此开关影响 */
  includeSuspicious?: boolean;
}

/** 历史读数点：图表直接可用 */
export interface ReadingPoint {
  recordedAt: string;
  value: number;
}

/** SqlReadingRepository 的可选装配口径 */
export interface SqlReadingRepositoryOptions {
  /**
   * latest 的读取路径：
   * - `raw`（默认）：直查 telemetry_readings，靠 hypertable 分块裁剪 + 索引，结果实时；
   * - `timescale`：读连续聚合 telemetry_readings_latest，数据量大时更快，但聚合刷新周期内可能滞后。
   * 由 `TELEMETRY_LATEST_MODE=timescale` 开启，可随时回退。
   */
  latestMode?: "raw" | "timescale";
}

export interface ReadingRepository {
  create(tx: unknown, input: CreateReadingInput): Promise<Reading>;
  /** 幂等落库：同 (deviceId, metric, depthCm, recordedAt) 只保留一条，返回是否真正新增（迁移 060 唯一索引兜底） */
  createIdempotent(tx: unknown, input: CreateReadingInput): Promise<{ reading: Reading; inserted: boolean }>;
  latest(deviceId?: string): Promise<Reading[]>;
  history(query: HistoryQuery): Promise<Reading[]>;
  /** 按时间升序返回 (时间, 数值) 序列，供趋势图直接使用；默认剔除可疑读数 */
  historySeries(query: HistoryQuery): Promise<ReadingPoint[]>;
  /** 同设备同指标（同深度）最近的历史数值，按时间倒序，供连续同值判定 */
  recentValues(deviceId: string, metric: string, depthCm: number | undefined, limit: number): Promise<number[]>;
  count(): Promise<number>;
}

export interface AlertRepository {
  create(tx: unknown, alert: TelemetryAlert): Promise<TelemetryAlert>;
  pending(): Promise<TelemetryAlert[]>;
  markHandled(id: string): Promise<boolean>;
  count(): Promise<number>;
}

function toReading(row: Record<string, unknown>): Reading {
  const reading: Reading = {
    id: String(row.id),
    deviceId: String(row.device_id),
    plotCode: String(row.plot_code),
    metric: String(row.metric),
    value: Number(row.value),
    unit: String(row.unit),
    recordedAt: toIsoTimestamp(row.recorded_at),
  };
  if (row.depth_cm !== null && row.depth_cm !== undefined) reading.depthCm = Number(row.depth_cm);
  // 干净读数不带标记字段，保持与存量响应/测试断言同形
  if (Array.isArray(row.quality_flags) && row.quality_flags.length > 0) reading.qualityFlags = row.quality_flags.map(String) as QualityFlag[];
  return reading;
}

function toAlert(row: Record<string, unknown>): TelemetryAlert {
  const alert: TelemetryAlert = {
    id: String(row.id),
    deviceId: String(row.device_id),
    plotCode: String(row.plot_code),
    level: String(row.level),
    metric: String(row.metric),
    message: String(row.message),
    createdAt: toIsoTimestamp(row.created_at),
    handled: Boolean(row.handled),
  };
  if (row.handled_at !== null && row.handled_at !== undefined) alert.handledAt = toIsoTimestamp(row.handled_at);
  return alert;
}

/** PostgreSQL 实现，表结构由迁移 002_decision_telemetry.sql 管理，质量标记列由迁移 049 追加 */
export class SqlReadingRepository implements ReadingRepository {
  private readonly latestMode: "raw" | "timescale";

  constructor(private readonly client: PrismaClientLike, options: SqlReadingRepositoryOptions = {}) {
    this.latestMode = options.latestMode ?? "raw";
  }

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(tx: unknown, input: CreateReadingInput): Promise<Reading> {
    const id = ulid();
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm, quality_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      id,
      input.deviceId,
      input.plotCode,
      input.metric,
      input.value,
      input.unit,
      input.recordedAt,
      input.depthCm ?? null,
      JSON.stringify(input.qualityFlags ?? []),
    );
    return { id, ...input };
  }

  /**
   * 幂等落库：按 (deviceId, metric, depthCm, recordedAt) 去重。
   * 分层与非分层分别命中迁移 060 的两个部分唯一索引，冲突时不写入、回查既有读数，
   * 上层据此跳过重复告警与事件发布。
   */
  async createIdempotent(tx: unknown, input: CreateReadingInput): Promise<{ reading: Reading; inserted: boolean }> {
    const id = ulid();
    const hasDepth = input.depthCm !== undefined && input.depthCm !== null;
    const conflict = hasDepth
      ? `ON CONFLICT (device_id, metric, depth_cm, recorded_at) WHERE depth_cm IS NOT NULL DO NOTHING`
      : `ON CONFLICT (device_id, metric, recorded_at) WHERE depth_cm IS NULL DO NOTHING`;
    const inserted = await this.executor(tx).$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm, quality_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ${conflict}
       RETURNING id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm, quality_flags`,
      id,
      input.deviceId,
      input.plotCode,
      input.metric,
      input.value,
      input.unit,
      input.recordedAt,
      input.depthCm ?? null,
      JSON.stringify(input.qualityFlags ?? []),
    );
    if (inserted.length > 0) return { reading: toReading(inserted[0]!), inserted: true };
    const existing = await this.executor(tx).$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm, quality_flags
       FROM telemetry_readings
       WHERE device_id = $1 AND metric = $2 AND depth_cm IS NOT DISTINCT FROM $3 AND recorded_at = $4
       LIMIT 1`,
      input.deviceId,
      input.metric,
      input.depthCm ?? null,
      input.recordedAt,
    );
    return { reading: existing[0] ? toReading(existing[0]) : { id, ...input }, inserted: false };
  }

  /** 每个设备每个指标（含深度分层）的最近一次干净读数；可疑读数不参与汇总，不传设备则返回全部设备 */
  async latest(deviceId?: string): Promise<Reading[]> {
    if (this.latestMode === "timescale") return this.latestFromContinuousAggregate(deviceId);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `WITH ranked AS (
         SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm, quality_flags,
                ROW_NUMBER() OVER (PARTITION BY device_id, metric, depth_cm ORDER BY recorded_at DESC) AS rn
         FROM telemetry_readings
         WHERE quality_flags = '[]'::jsonb
       )
       SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm, quality_flags FROM ranked WHERE rn = 1` +
        (deviceId ? ` AND device_id = $1 ORDER BY metric` : ` ORDER BY device_id, metric`),
      ...(deviceId ? [deviceId] : []),
    );
    return rows.map(toReading);
  }

  /** 读连续聚合 telemetry_readings_latest（迁移 059）；只含干净读数，聚合刷新周期内可能滞后 */
  private async latestFromContinuousAggregate(deviceId?: string): Promise<Reading[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (deviceId) { values.push(deviceId); conditions.push(`device_id = $${values.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `WITH ranked AS (
         SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm,
                ROW_NUMBER() OVER (PARTITION BY device_id, metric, depth_cm ORDER BY recorded_at DESC) AS rn
         FROM telemetry_readings_latest
         ${where}
       )
       SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm FROM ranked WHERE rn = 1
       ORDER BY device_id, metric, depth_cm`,
      ...values,
    );
    return rows.map(toReading);
  }

  async history(query: HistoryQuery): Promise<Reading[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.deviceId) { values.push(query.deviceId); conditions.push(`device_id = $${values.length}`); }
    if (query.plotCode) { values.push(query.plotCode); conditions.push(`plot_code = $${values.length}`); }
    if (query.metric) { values.push(query.metric); conditions.push(`metric = $${values.length}`); }
    if (query.depthCm !== undefined) { values.push(query.depthCm); conditions.push(`depth_cm = $${values.length}`); }
    if (query.from) { values.push(query.from); conditions.push(`recorded_at >= $${values.length}`); }
    if (query.to) { values.push(query.to); conditions.push(`recorded_at <= $${values.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(2000, Math.max(1, query.limit ?? 200));
    values.push(limit);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm, quality_flags FROM telemetry_readings ${where}
       ORDER BY recorded_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toReading);
  }

  async historySeries(query: HistoryQuery): Promise<ReadingPoint[]> {
    const rows = await this.history({ ...query, limit: query.limit ?? 200 });
    // 曲线默认剔除可疑读数，includeSuspicious=true 时回查全量
    return rows
      .filter((row) => query.includeSuspicious || !(row.qualityFlags && row.qualityFlags.length > 0))
      .reverse()
      .map((row) => ({ recordedAt: row.recordedAt, value: row.value }));
  }

  async recentValues(deviceId: string, metric: string, depthCm: number | undefined, limit: number): Promise<number[]> {
    const rows = await this.client.$queryRawUnsafe<Array<{ value: unknown }>>(
      `SELECT value FROM telemetry_readings
       WHERE device_id = $1 AND metric = $2 AND depth_cm IS NOT DISTINCT FROM $3
       ORDER BY recorded_at DESC LIMIT $4`,
      deviceId,
      metric,
      depthCm ?? null,
      Math.min(50, Math.max(1, limit)),
    );
    return rows.map((row) => Number(row.value));
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM telemetry_readings`);
    return Number(rows[0]?.total ?? 0);
  }
}

export class SqlAlertRepository implements AlertRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(tx: unknown, alert: TelemetryAlert): Promise<TelemetryAlert> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO telemetry_alerts (id, device_id, plot_code, level, metric, message, created_at, handled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
      alert.id,
      alert.deviceId,
      alert.plotCode,
      alert.level,
      alert.metric,
      alert.message,
      alert.createdAt,
    );
    return alert;
  }

  async pending(): Promise<TelemetryAlert[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, device_id, plot_code, level, metric, message, created_at, handled, handled_at
       FROM telemetry_alerts WHERE handled = FALSE ORDER BY created_at DESC LIMIT 200`,
    );
    return rows.map(toAlert);
  }

  async markHandled(id: string): Promise<boolean> {
    return (await this.client.$executeRawUnsafe(`UPDATE telemetry_alerts SET handled = TRUE, handled_at = now() WHERE id = $1 AND handled = FALSE`, id)) > 0;
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM telemetry_alerts WHERE handled = FALSE`);
    return Number(rows[0]?.total ?? 0);
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryReadingRepository implements ReadingRepository {
  private readonly rows: Reading[] = [];

  constructor(seed: Reading[] = []) {
    this.rows.push(...seed);
  }

  async create(_tx: unknown, input: CreateReadingInput): Promise<Reading> {
    const reading: Reading = { id: ulid(), ...input };
    this.rows.push(reading);
    // SQL 模式返回的是新构造的对象，内存模式若直接交出同一份引用，调用方改手写读数就能污染存储
    return structuredClone(reading);
  }

  async createIdempotent(_tx: unknown, input: CreateReadingInput): Promise<{ reading: Reading; inserted: boolean }> {
    const existing = this.rows.find(
      (row) => row.deviceId === input.deviceId && row.metric === input.metric && row.depthCm === input.depthCm && row.recordedAt === input.recordedAt,
    );
    if (existing) return { reading: structuredClone(existing), inserted: false };
    const reading: Reading = { id: ulid(), ...input };
    this.rows.push(reading);
    return { reading: structuredClone(reading), inserted: true };
  }

  async latest(deviceId?: string): Promise<Reading[]> {
    // 与 SQL 同口径：可疑读数不参与汇总
    const clean = this.rows.filter((row) => !(row.qualityFlags && row.qualityFlags.length > 0));
    const rows = deviceId ? clean.filter((row) => row.deviceId === deviceId) : clean;
    const byKey = new Map<string, Reading>();
    for (const row of [...rows].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) byKey.set(`${row.deviceId}::${row.metric}::${row.depthCm ?? ""}`, row);
    // 与 SQL 的 ORDER BY device_id, metric 同序，否则两套模式返回的列表顺序不同
    return [...byKey.values()]
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.metric.localeCompare(b.metric) || (a.depthCm ?? 0) - (b.depthCm ?? 0))
      .map((row) => structuredClone(row));
  }

  async history(query: HistoryQuery): Promise<Reading[]> {
    const limit = Math.min(2000, Math.max(1, query.limit ?? 200));
    return this.rows
      .filter((row) => (query.deviceId ? row.deviceId === query.deviceId : true))
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .filter((row) => (query.metric ? row.metric === query.metric : true))
      .filter((row) => (query.depthCm !== undefined ? row.depthCm === query.depthCm : true))
      .filter((row) => (query.from ? row.recordedAt >= query.from : true))
      .filter((row) => (query.to ? row.recordedAt <= query.to : true))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async historySeries(query: HistoryQuery): Promise<ReadingPoint[]> {
    const rows = await this.history({ ...query, limit: query.limit ?? 200 });
    // 曲线默认剔除可疑读数，includeSuspicious=true 时回查全量
    return rows
      .filter((row) => query.includeSuspicious || !(row.qualityFlags && row.qualityFlags.length > 0))
      .reverse()
      .map((row) => ({ recordedAt: row.recordedAt, value: row.value }));
  }

  async recentValues(deviceId: string, metric: string, depthCm: number | undefined, limit: number): Promise<number[]> {
    return this.rows
      .filter((row) => row.deviceId === deviceId && row.metric === metric && row.depthCm === depthCm)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, Math.min(50, Math.max(1, limit)))
      .map((row) => row.value);
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  all(): Reading[] {
    return this.rows.map((row) => structuredClone(row));
  }
}

export class InMemoryAlertRepository implements AlertRepository {
  private readonly rows: TelemetryAlert[] = [];

  async create(_tx: unknown, alert: TelemetryAlert): Promise<TelemetryAlert> {
    // SQL 的 INSERT 写死 handled=FALSE 且没有 handled_at 列，内存模式不能照单全收调用方传来的这两个字段
    const row: TelemetryAlert = { ...alert, handled: false };
    delete row.handledAt;
    this.rows.push(row);
    return structuredClone(row);
  }

  async pending(): Promise<TelemetryAlert[]> {
    // 与 SQL 的 ORDER BY created_at DESC LIMIT 200 同序同量
    return this.rows
      .filter((row) => !row.handled)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200)
      .map((row) => structuredClone(row));
  }

  async markHandled(id: string): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id && !item.handled);
    if (!row) return false;
    row.handled = true;
    row.handledAt = new Date().toISOString();
    return true;
  }

  async count(): Promise<number> {
    return this.rows.filter((row) => !row.handled).length;
  }

  all(): TelemetryAlert[] {
    return this.rows.map((row) => structuredClone(row));
  }
}

/** 生成读数与告警标识 */
export function newReadingId(): string {
  return ulid();
}
