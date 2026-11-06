import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/**
 * 虫情识别记录。
 *
 * 识别结果有三个来源：算法侧回调、摄像头侧上报、人工田间核查。
 * 三者统一落到本表，再由 HTTP 层发布 TelemetryPestDetected 事件交给消息中心，
 * 保证「识别 → 告警/消息」只有一条链路，不会因为来源不同产生重复告警。
 */

/** 虫情发生等级：1 轻微、2 中等、3 严重 */
export type PestLevel = 1 | 2 | 3;

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

export interface PestEventRepository {
  create(tx: unknown, input: CreatePestEventInput): Promise<PestEvent>;
  list(filter?: { plotCode?: string; limit?: number; pendingOnly?: boolean }): Promise<PestEvent[]>;
  markHandled(id: string): Promise<boolean>;
  count(): Promise<number>;
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
  };
  if (row.image_file_id !== null && row.image_file_id !== undefined) event.imageFileId = String(row.image_file_id);
  return event;
}

/** PostgreSQL 实现，表结构由迁移 008 管理 */
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
    const event: PestEvent = { id, ...input, handled: false };
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
      `SELECT id, plot_code, device_id, pest_type, level, confidence, image_file_id, detected_at, handled
       FROM telemetry_pest_events ${where} ORDER BY detected_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toPestEvent);
  }

  async markHandled(id: string): Promise<boolean> {
    return (await this.client.$executeRawUnsafe(`UPDATE telemetry_pest_events SET handled = TRUE WHERE id = $1 AND handled = FALSE`, id)) > 0;
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
    const event: PestEvent = { id: ulid(), ...input, handled: false };
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

  async markHandled(id: string): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id && !item.handled);
    if (!row) return false;
    row.handled = true;
    return true;
  }

  async count(): Promise<number> {
    return this.rows.filter((row) => !row.handled).length;
  }
}
