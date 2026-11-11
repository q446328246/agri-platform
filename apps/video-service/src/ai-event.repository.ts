import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

import type { AiDetection } from "./ai-event.js";

/** 落库的识别事件：转发状态与重试计数随投递结果更新，重启不丢 */
export interface AiEventRecord {
  id: string;
  tenantId: string;
  cameraId: string;
  plotCode: string;
  pestType: string;
  level: 1 | 2 | 3;
  confidence: number;
  imageFileId?: string;
  detectedAt: string;
  receivedAt: string;
  forwarded: boolean;
  forwardStatus: number;
  forwardMessage: string;
  retryCount: number;
  lastError?: string;
  forwardedAt?: string;
}

export interface AiEventQuery {
  page: number;
  size: number;
  plotCode?: string;
  forwarded?: boolean;
}

export interface AiEventRepository {
  create(event: AiEventRecord): Promise<AiEventRecord>;
  page(tenantId: string, query: AiEventQuery): Promise<PageResult<AiEventRecord>>;
  find(tenantId: string, id: string): Promise<AiEventRecord | null>;
  markForwarded(tenantId: string, id: string, at: string, status: number, message: string): Promise<AiEventRecord | null>;
  markFailed(tenantId: string, id: string, status: number, message: string): Promise<AiEventRecord | null>;
  /** 未转发且未超重试上限的事件，按接收时间升序补投 */
  listRetryable(limit: number, maxRetries: number): Promise<AiEventRecord[]>;
}

export function toDetection(event: AiEventRecord): AiDetection {
  return {
    cameraId: event.cameraId,
    plotCode: event.plotCode,
    pestType: event.pestType,
    level: event.level,
    confidence: event.confidence,
    detectedAt: event.detectedAt,
    ...(event.imageFileId ? { imageFileId: event.imageFileId } : {}),
  };
}

export class InMemoryAiEventRepository implements AiEventRepository {
  private readonly events = new Map<string, AiEventRecord>();

  async create(event: AiEventRecord): Promise<AiEventRecord> {
    this.events.set(event.id, structuredClone(event));
    return structuredClone(event);
  }

  async page(tenantId: string, query: AiEventQuery): Promise<PageResult<AiEventRecord>> {
    const filtered = [...this.events.values()]
      .filter((event) => event.tenantId === tenantId
        && (query.plotCode === undefined || event.plotCode === query.plotCode)
        && (query.forwarded === undefined || event.forwarded === query.forwarded))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const start = (query.page - 1) * query.size;
    return { items: filtered.slice(start, start + query.size).map((event) => structuredClone(event)), total: filtered.length, page: query.page, size: query.size, pages: Math.ceil(filtered.length / query.size) };
  }

  async find(tenantId: string, id: string): Promise<AiEventRecord | null> {
    const event = this.events.get(id);
    return event && event.tenantId === tenantId ? structuredClone(event) : null;
  }

  async markForwarded(tenantId: string, id: string, at: string, status: number, message: string): Promise<AiEventRecord | null> {
    const event = this.events.get(id);
    if (!event || event.tenantId !== tenantId) return null;
    event.forwarded = true;
    event.forwardStatus = status;
    event.forwardMessage = message;
    event.forwardedAt = at;
    delete event.lastError;
    return structuredClone(event);
  }

  async markFailed(tenantId: string, id: string, status: number, message: string): Promise<AiEventRecord | null> {
    const event = this.events.get(id);
    if (!event || event.tenantId !== tenantId) return null;
    event.forwarded = false;
    event.forwardStatus = status;
    event.forwardMessage = message;
    event.retryCount += 1;
    event.lastError = message;
    delete event.forwardedAt;
    return structuredClone(event);
  }

  async listRetryable(limit: number, maxRetries: number): Promise<AiEventRecord[]> {
    return [...this.events.values()]
      .filter((event) => !event.forwarded && event.retryCount < maxRetries)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((event) => structuredClone(event));
  }
}

const columns = "id, tenant_id, camera_id, plot_code, pest_type, level, confidence, image_file_id, detected_at, received_at, forwarded, forward_status, forward_message, retry_count, last_error, forwarded_at";

function fromRow(row: Record<string, unknown>): AiEventRecord {
  const event: AiEventRecord = {
    id: String(row.id), tenantId: String(row.tenant_id), cameraId: String(row.camera_id), plotCode: String(row.plot_code),
    pestType: String(row.pest_type), level: Number(row.level) as 1 | 2 | 3, confidence: Number(row.confidence),
    detectedAt: toIsoTimestamp(row.detected_at), receivedAt: toIsoTimestamp(row.received_at),
    forwarded: Boolean(row.forwarded), forwardStatus: Number(row.forward_status), forwardMessage: String(row.forward_message),
    retryCount: Number(row.retry_count),
  };
  if (row.image_file_id != null) event.imageFileId = String(row.image_file_id);
  if (row.last_error != null) event.lastError = String(row.last_error);
  if (row.forwarded_at != null) event.forwardedAt = toIsoTimestamp(row.forwarded_at);
  return event;
}

export class SqlAiEventRepository implements AiEventRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(event: AiEventRecord): Promise<AiEventRecord> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO video_ai_events (${columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${columns}`,
      event.id, event.tenantId, event.cameraId, event.plotCode, event.pestType, event.level, event.confidence,
      event.imageFileId ?? null, event.detectedAt, event.receivedAt, event.forwarded, event.forwardStatus,
      event.forwardMessage, event.retryCount, event.lastError ?? null, event.forwardedAt ?? null,
    );
    return fromRow(rows[0]!);
  }

  async page(tenantId: string, query: AiEventQuery): Promise<PageResult<AiEventRecord>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (query.plotCode !== undefined) { values.push(query.plotCode); where.push(`plot_code = $${values.length}`); }
    if (query.forwarded !== undefined) { values.push(query.forwarded); where.push(`forwarded = $${values.length}`); }
    const filter = where.join(" AND ");
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM video_ai_events WHERE ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM video_ai_events WHERE ${filter} ORDER BY received_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values,
    );
    return { items: rows.map(fromRow), total, page: query.page, size: query.size, pages: Math.ceil(total / query.size) };
  }

  async find(tenantId: string, id: string): Promise<AiEventRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${columns} FROM video_ai_events WHERE tenant_id = $1 AND id = $2`, tenantId, id);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async markForwarded(tenantId: string, id: string, at: string, status: number, message: string): Promise<AiEventRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE video_ai_events SET forwarded = TRUE, forward_status = $3, forward_message = $4, forwarded_at = $5::timestamptz, last_error = NULL
       WHERE tenant_id = $1 AND id = $2 RETURNING ${columns}`, tenantId, id, status, message, at,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async markFailed(tenantId: string, id: string, status: number, message: string): Promise<AiEventRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE video_ai_events SET forwarded = FALSE, forward_status = $3, forward_message = $4, retry_count = retry_count + 1, last_error = $4, forwarded_at = NULL
       WHERE tenant_id = $1 AND id = $2 RETURNING ${columns}`, tenantId, id, status, message,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listRetryable(limit: number, maxRetries: number): Promise<AiEventRecord[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM video_ai_events WHERE forwarded = FALSE AND retry_count < $1 ORDER BY received_at, id LIMIT $2`, maxRetries, limit,
    );
    return rows.map(fromRow);
  }
}