import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

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
}

/** 历史读数点：图表直接可用 */
export interface ReadingPoint {
  recordedAt: string;
  value: number;
}

export interface ReadingRepository {
  create(tx: unknown, input: CreateReadingInput): Promise<Reading>;
  latest(deviceId?: string): Promise<Reading[]>;
  history(query: HistoryQuery): Promise<Reading[]>;
  /** 按时间升序返回 (时间, 数值) 序列，供趋势图直接使用 */
  historySeries(query: HistoryQuery): Promise<ReadingPoint[]>;
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

/** PostgreSQL 实现，表结构由迁移 002_decision_telemetry.sql 管理 */
export class SqlReadingRepository implements ReadingRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(tx: unknown, input: CreateReadingInput): Promise<Reading> {
    const id = ulid();
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      id,
      input.deviceId,
      input.plotCode,
      input.metric,
      input.value,
      input.unit,
      input.recordedAt,
      input.depthCm ?? null,
    );
    return { id, ...input };
  }

  /** 每个设备每个指标（含深度分层）的最近一次读数；不传设备则返回全部设备 */
  async latest(deviceId?: string): Promise<Reading[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `WITH ranked AS (
         SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm,
                ROW_NUMBER() OVER (PARTITION BY device_id, metric, depth_cm ORDER BY recorded_at DESC) AS rn
         FROM telemetry_readings
       )
       SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm FROM ranked WHERE rn = 1` +
        (deviceId ? ` AND device_id = $1 ORDER BY metric` : ` ORDER BY device_id, metric`),
      ...(deviceId ? [deviceId] : []),
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
      `SELECT id, device_id, plot_code, metric, value, unit, recorded_at, depth_cm FROM telemetry_readings ${where}
       ORDER BY recorded_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toReading);
  }

  async historySeries(query: HistoryQuery): Promise<ReadingPoint[]> {
    const rows = await this.history({ ...query, limit: query.limit ?? 200 });
    return rows.reverse().map((row) => ({ recordedAt: row.recordedAt, value: row.value }));
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
    return reading;
  }

  async latest(deviceId?: string): Promise<Reading[]> {
    const rows = deviceId ? this.rows.filter((row) => row.deviceId === deviceId) : this.rows;
    const byKey = new Map<string, Reading>();
    for (const row of [...rows].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) byKey.set(`${row.deviceId}::${row.metric}::${row.depthCm ?? ""}`, row);
    return [...byKey.values()];
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
      .slice(0, limit);
  }

  async historySeries(query: HistoryQuery): Promise<ReadingPoint[]> {
    const rows = await this.history({ ...query, limit: query.limit ?? 200 });
    return rows.reverse().map((row) => ({ recordedAt: row.recordedAt, value: row.value }));
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  all(): Reading[] {
    return [...this.rows];
  }
}

export class InMemoryAlertRepository implements AlertRepository {
  private readonly rows: TelemetryAlert[] = [];

  async create(_tx: unknown, alert: TelemetryAlert): Promise<TelemetryAlert> {
    this.rows.push(alert);
    return alert;
  }

  async pending(): Promise<TelemetryAlert[]> {
    return this.rows.filter((row) => !row.handled);
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
    return [...this.rows];
  }
}

/** 生成读数与告警标识 */
export function newReadingId(): string {
  return ulid();
}
