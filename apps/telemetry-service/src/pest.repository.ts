import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/**
 * 虫情识别记录与治理。
 *
 * 识别结果有三个来源：算法侧回调、摄像头侧上报、人工田间核查。三者统一落到本表，
 * 再由 HTTP 层发布 TelemetryPestDetected 事件交给消息中心，保证「识别 → 告警/消息」只有一条链路。
 * 治理（开发方案 6.3）在本表上记录处置流程：防治措施 / 药剂方案 / 派单说明 / 关联植保任务，
 * 状态沿 pending→planned→dispatched→archived 推进；航线规划与无人机派遣依赖硬件，系统只留派单记录。
 * 统计与趋势为只读聚合，供虫情页的区域统计表与趋势曲线使用（农场东八区日历日分桶）。
 */

/** 虫情发生等级：1 轻微、2 中等、3 严重 */
export type PestLevel = 1 | 2 | 3;

/** 治理状态：待处置 / 已定方案 / 已派单 / 已归档 */
export type GovernanceStatus = "pending" | "planned" | "dispatched" | "archived";

export interface PestEvent {
  id: string;
  plotCode: string;
  deviceId: string;
  /** 虫害类型编码，取自虫情字典 */
  pestType: string;
  level: PestLevel;
  /** 识别置信度 0 到 1 */
  confidence: number;
  /** 现场影像文件标识 */
  imageFileId?: string;
  detectedAt: string;
  handled: boolean;
  /** 治理状态 */
  governanceStatus: GovernanceStatus;
  /** 防治措施（人工/生物/化学等描述） */
  measure: string;
  /** 药剂名称 */
  pesticide: string;
  /** 药剂用量 */
  dosage: string;
  /** 派单/归档说明 */
  dispatchNote: string;
  /** 处置人 */
  governedBy: string;
  /** 最近一次治理动作时间 */
  governedAt?: string;
  /** 关联的植保农事任务 id */
  taskId?: string;
}

export interface CreatePestEventInput {
  plotCode: string;
  deviceId: string;
  pestType: string;
  level: PestLevel;
  confidence: number;
  imageFileId?: string;
  detectedAt: string;
}

/** 治理入参：状态只允许向前推进的三档，其余字段按提供值覆盖 */
export interface GovernPestInput {
  status: Exclude<GovernanceStatus, "pending">;
  measure?: string;
  pesticide?: string;
  dosage?: string;
  dispatchNote?: string;
  governedBy?: string;
  taskId?: string;
}

/** 统计/趋势时间窗过滤（各维度选填，允许显式传 undefined 表示不参与筛选） */
export interface PestAggregateFilter {
  plotCode?: string | undefined;
  pestType?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface PestStats {
  total: number;
  pending: number;
  byLevel: Array<{ level: PestLevel; count: number }>;
  byType: Array<{ pestType: string; count: number }>;
  byPlot: Array<{ plotCode: string; count: number }>;
}

export interface PestTrendPoint {
  date: string;
  count: number;
}

export interface PestEventRepository {
  create(tx: unknown, input: CreatePestEventInput): Promise<PestEvent>;
  list(filter?: { plotCode?: string; limit?: number; pendingOnly?: boolean }): Promise<PestEvent[]>;
  markHandled(id: string): Promise<boolean>;
  /** 记录治理动作，返回更新后的事件；不存在返回 null */
  govern(id: string, input: GovernPestInput): Promise<PestEvent | null>;
  find(id: string): Promise<PestEvent | null>;
  stats(filter: PestAggregateFilter): Promise<PestStats>;
  trend(filter: PestAggregateFilter & { days: number }): Promise<PestTrendPoint[]>;
  count(): Promise<number>;
}

const FARM_OFFSET_MS = 8 * 3600 * 1000;

/** ISO 时刻 → 农场东八区日历日 YYYY-MM-DD（不受浏览器时区影响） */
function toFarmDate(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  return new Date(time + FARM_OFFSET_MS).toISOString().slice(0, 10);
}

/** 农场日历日往前推 (days-1) 天后的当日零点，转成真实 UTC 时刻作为时间窗起点 */
function farmWindowStartIso(days: number): string {
  const shifted = new Date(Date.now() + FARM_OFFSET_MS);
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(base - (days - 1) * 86_400_000 - FARM_OFFSET_MS).toISOString();
}

/** 生成连续 days 天的农场日历日标签（升序） */
function farmDayLabels(days: number): string[] {
  const shifted = new Date(Date.now() + FARM_OFFSET_MS);
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return Array.from({ length: days }, (_, index) => new Date(base + index * 86_400_000).toISOString().slice(0, 10));
}

function toPestEvent(row: Record<string, unknown>): PestEvent {
  const level = Number(row.level);
  const event: PestEvent = {
    id: String(row.id),
    plotCode: String(row.plot_code ?? ""),
    deviceId: String(row.device_id ?? ""),
    pestType: String(row.pest_type),
    level: (level === 3 ? 3 : level === 2 ? 2 : 1) as PestLevel,
    confidence: Number(row.confidence),
    detectedAt: toIsoTimestamp(row.detected_at),
    handled: Boolean(row.handled),
    governanceStatus: normalizeStatus(row.governance_status),
    measure: String(row.measure ?? ""),
    pesticide: String(row.pesticide ?? ""),
    dosage: String(row.dosage ?? ""),
    dispatchNote: String(row.dispatch_note ?? ""),
    governedBy: String(row.governed_by ?? ""),
  };
  if (row.image_file_id !== null && row.image_file_id !== undefined) event.imageFileId = String(row.image_file_id);
  const governedAt = toIsoTimestamp(row.governed_at);
  if (governedAt) event.governedAt = governedAt;
  if (row.task_id !== null && row.task_id !== undefined) event.taskId = String(row.task_id);
  return event;
}

function normalizeStatus(value: unknown): GovernanceStatus {
  return value === "planned" || value === "dispatched" || value === "archived" ? value : "pending";
}

const SELECT_COLUMNS = `id, plot_code, device_id, pest_type, level, confidence, image_file_id, detected_at, handled,
  governance_status, measure, pesticide, dosage, dispatch_note, governed_by, governed_at, task_id`;

/** PostgreSQL 实现，表结构由迁移 008 建立、022 扩展治理与流程字段 */
export class SqlPestEventRepository implements PestEventRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(tx: unknown, input: CreatePestEventInput): Promise<PestEvent> {
    const id = ulid();
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO telemetry_pest_events (id, plot_code, device_id, pest_type, level, confidence, image_file_id, detected_at, handled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)`,
      id,
      input.plotCode,
      input.deviceId,
      input.pestType,
      input.level,
      input.confidence,
      input.imageFileId ?? null,
      input.detectedAt,
    );
    const event: PestEvent = {
      id, ...input, handled: false,
      governanceStatus: "pending", measure: "", pesticide: "", dosage: "", dispatchNote: "", governedBy: "",
    };
    return event;
  }

  async list(filter: { plotCode?: string; limit?: number; pendingOnly?: boolean } = {}): Promise<PestEvent[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.plotCode) { values.push(filter.plotCode); conditions.push(`plot_code = $${values.length}`); }
    if (filter.pendingOnly) conditions.push(`handled = FALSE`);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    values.push(limit);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SELECT_COLUMNS} FROM telemetry_pest_events ${where} ORDER BY detected_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toPestEvent);
  }

  async find(id: string): Promise<PestEvent | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SELECT_COLUMNS} FROM telemetry_pest_events WHERE id = $1 LIMIT 1`,
      id,
    );
    const row = rows[0];
    return row ? toPestEvent(row) : null;
  }

  async markHandled(id: string): Promise<boolean> {
    return (await this.client.$executeRawUnsafe(`UPDATE telemetry_pest_events SET handled = TRUE WHERE id = $1 AND handled = FALSE`, id)) > 0;
  }

  async govern(id: string, input: GovernPestInput): Promise<PestEvent | null> {
    const existing = await this.find(id);
    if (!existing) return null;
    const governedAt = new Date().toISOString();
    const handled = input.status === "dispatched" || input.status === "archived" ? true : existing.handled;
    const updated: PestEvent = {
      ...existing,
      governanceStatus: input.status,
      measure: input.measure ?? existing.measure,
      pesticide: input.pesticide ?? existing.pesticide,
      dosage: input.dosage ?? existing.dosage,
      dispatchNote: input.dispatchNote ?? existing.dispatchNote,
      governedBy: input.governedBy ?? existing.governedBy,
      governedAt,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      handled,
    };
    await this.client.$executeRawUnsafe(
      `UPDATE telemetry_pest_events SET governance_status = $2, measure = $3, pesticide = $4, dosage = $5,
         dispatch_note = $6, governed_by = $7, governed_at = $8, task_id = $9, handled = $10 WHERE id = $1`,
      id,
      updated.governanceStatus,
      updated.measure,
      updated.pesticide,
      updated.dosage,
      updated.dispatchNote,
      updated.governedBy,
      governedAt,
      updated.taskId ?? null,
      updated.handled,
    );
    return updated;
  }

  private aggregateWhere(filter: PestAggregateFilter): { where: string; values: unknown[] } {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.plotCode) { values.push(filter.plotCode); conditions.push(`plot_code = $${values.length}`); }
    if (filter.pestType) { values.push(filter.pestType); conditions.push(`pest_type = $${values.length}`); }
    if (filter.from) { values.push(filter.from); conditions.push(`detected_at >= $${values.length}`); }
    if (filter.to) { values.push(filter.to); conditions.push(`detected_at <= $${values.length}`); }
    return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", values };
  }

  async stats(filter: PestAggregateFilter): Promise<PestStats> {
    const { where, values } = this.aggregateWhere(filter);
    const [totals, byLevel, byType, byPlot] = await Promise.all([
      this.client.$queryRawUnsafe<Array<{ total: number; pending: number }>>(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE handled = FALSE)::int AS pending FROM telemetry_pest_events ${where}`,
        ...values,
      ),
      this.client.$queryRawUnsafe<Array<{ level: number; count: number }>>(
        `SELECT level, COUNT(*)::int AS count FROM telemetry_pest_events ${where} GROUP BY level ORDER BY level`,
        ...values,
      ),
      this.client.$queryRawUnsafe<Array<{ pest_type: string; count: number }>>(
        `SELECT pest_type, COUNT(*)::int AS count FROM telemetry_pest_events ${where} GROUP BY pest_type ORDER BY count DESC`,
        ...values,
      ),
      this.client.$queryRawUnsafe<Array<{ plot_code: string; count: number }>>(
        `SELECT plot_code, COUNT(*)::int AS count FROM telemetry_pest_events ${where} GROUP BY plot_code ORDER BY count DESC`,
        ...values,
      ),
    ]);
    return {
      total: Number(totals[0]?.total ?? 0),
      pending: Number(totals[0]?.pending ?? 0),
      byLevel: byLevel.map((row) => ({ level: (Number(row.level) === 3 ? 3 : Number(row.level) === 2 ? 2 : 1) as PestLevel, count: Number(row.count) })),
      byType: byType.map((row) => ({ pestType: String(row.pest_type), count: Number(row.count) })),
      byPlot: byPlot.map((row) => ({ plotCode: String(row.plot_code), count: Number(row.count) })),
    };
  }

  async trend(filter: PestAggregateFilter & { days: number }): Promise<PestTrendPoint[]> {
    const days = Math.min(365, Math.max(1, filter.days));
    const scoped: PestAggregateFilter = { plotCode: filter.plotCode, pestType: filter.pestType, from: farmWindowStartIso(days), to: filter.to };
    const { where, values } = this.aggregateWhere(scoped);
    const rows = await this.client.$queryRawUnsafe<Array<{ date: string; count: number }>>(
      `SELECT to_char(detected_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
       FROM telemetry_pest_events ${where} GROUP BY date ORDER BY date`,
      ...values,
    );
    const counts = new Map(rows.map((row) => [String(row.date), Number(row.count)]));
    return farmDayLabels(days).map((date) => ({ date, count: counts.get(date) ?? 0 }));
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM telemetry_pest_events WHERE handled = FALSE`);
    return Number(rows[0]?.total ?? 0);
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryPestEventRepository implements PestEventRepository {
  private readonly rows: PestEvent[] = [];

  constructor(seed: PestEvent[] = []) {
    this.rows.push(...seed);
  }

  async create(_tx: unknown, input: CreatePestEventInput): Promise<PestEvent> {
    const event: PestEvent = {
      id: ulid(), ...input, handled: false,
      governanceStatus: "pending", measure: "", pesticide: "", dosage: "", dispatchNote: "", governedBy: "",
    };
    this.rows.push(event);
    return event;
  }

  async list(filter: { plotCode?: string; limit?: number; pendingOnly?: boolean } = {}): Promise<PestEvent[]> {
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    return this.rows
      .filter((row) => (filter.plotCode ? row.plotCode === filter.plotCode : true))
      .filter((row) => (filter.pendingOnly ? !row.handled : true))
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
      .slice(0, limit);
  }

  async find(id: string): Promise<PestEvent | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async markHandled(id: string): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id && !item.handled);
    if (!row) return false;
    row.handled = true;
    return true;
  }

  async govern(id: string, input: GovernPestInput): Promise<PestEvent | null> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return null;
    row.governanceStatus = input.status;
    if (input.measure !== undefined) row.measure = input.measure;
    if (input.pesticide !== undefined) row.pesticide = input.pesticide;
    if (input.dosage !== undefined) row.dosage = input.dosage;
    if (input.dispatchNote !== undefined) row.dispatchNote = input.dispatchNote;
    if (input.governedBy !== undefined) row.governedBy = input.governedBy;
    if (input.taskId !== undefined) row.taskId = input.taskId;
    row.governedAt = new Date().toISOString();
    if (input.status === "dispatched" || input.status === "archived") row.handled = true;
    return row;
  }

  private match(row: PestEvent, filter: PestAggregateFilter): boolean {
    if (filter.plotCode && row.plotCode !== filter.plotCode) return false;
    if (filter.pestType && row.pestType !== filter.pestType) return false;
    if (filter.from && row.detectedAt < filter.from) return false;
    if (filter.to && row.detectedAt > filter.to) return false;
    return true;
  }

  async stats(filter: PestAggregateFilter): Promise<PestStats> {
    const matched = this.rows.filter((row) => this.match(row, filter));
    const tally = <T,>(items: T[]): Array<{ key: T; count: number }> => {
      const map = new Map<T, number>();
      for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
      return [...map.entries()].map(([key, count]) => ({ key, count }));
    };
    return {
      total: matched.length,
      pending: matched.filter((row) => !row.handled).length,
      byLevel: tally(matched.map((row) => row.level)).sort((a, b) => a.key - b.key).map((entry) => ({ level: entry.key, count: entry.count })),
      byType: tally(matched.map((row) => row.pestType)).sort((a, b) => b.count - a.count).map((entry) => ({ pestType: entry.key, count: entry.count })),
      byPlot: tally(matched.map((row) => row.plotCode)).sort((a, b) => b.count - a.count).map((entry) => ({ plotCode: entry.key, count: entry.count })),
    };
  }

  async trend(filter: PestAggregateFilter & { days: number }): Promise<PestTrendPoint[]> {
    const days = Math.min(365, Math.max(1, filter.days));
    const scoped: PestAggregateFilter = { plotCode: filter.plotCode, pestType: filter.pestType, from: farmWindowStartIso(days), to: filter.to };
    const counts = new Map<string, number>();
    for (const row of this.rows) {
      if (!this.match(row, scoped)) continue;
      const date = toFarmDate(row.detectedAt);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return farmDayLabels(days).map((date) => ({ date, count: counts.get(date) ?? 0 }));
  }

  async count(): Promise<number> {
    return this.rows.filter((row) => !row.handled).length;
  }
}