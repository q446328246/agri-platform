import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

export const ARCHIVE_SOURCES = ["AI_EVENT", "ALERT", "MANUAL"] as const;
export type ArchiveSource = typeof ARCHIVE_SOURCES[number];
export const ARCHIVE_STATUSES = ["PENDING", "ARCHIVED", "FAILED"] as const;
export type ArchiveStatus = typeof ARCHIVE_STATUSES[number];

/**
 * 录像留档档案（A13）：告警时刻前后窗口的片段登记。
 * 片段本体由 B 类流媒体服务切片上传后经内部接口回填 storageKey/playbackUrl；
 * 未接入时保持 PENDING，不伪造回放地址。
 */
export interface RecordingArchive {
  id: string;
  tenantId: string;
  cameraId: string;
  plotCode: string;
  source: ArchiveSource;
  /** 触发留档的识别事件/告警标识，人工补登为空串 */
  eventId: string;
  eventType: string;
  eventAt: string;
  preSeconds: number;
  postSeconds: number;
  startedAt: string;
  endedAt: string;
  storageKey: string;
  playbackUrl: string;
  status: ArchiveStatus;
  message: string;
  note: string;
  createdAt: string;
  settledAt?: string;
}

export interface ArchiveQuery {
  page: number;
  size: number;
  cameraId?: string;
  plotCode?: string;
  source?: ArchiveSource;
  status?: ArchiveStatus;
  from?: string;
  to?: string;
}

export interface RecordingArchiveRepository {
  create(archive: RecordingArchive): Promise<RecordingArchive>;
  page(tenantId: string, query: ArchiveQuery): Promise<PageResult<RecordingArchive>>;
  find(tenantId: string, id: string): Promise<RecordingArchive | null>;
  settle(tenantId: string, id: string, patch: { status: ArchiveStatus; storageKey?: string; playbackUrl?: string; message?: string }, at?: string): Promise<RecordingArchive | null>;
}

/** 留档窗口：事件时刻向前 preSeconds、向后 postSeconds，与迁移 057 的 CHECK 同界 */
export function archiveWindow(eventAt: string, preSeconds: number, postSeconds: number): { startedAt: string; endedAt: string } {
  const at = Date.parse(eventAt);
  return { startedAt: new Date(at - preSeconds * 1000).toISOString(), endedAt: new Date(at + postSeconds * 1000).toISOString() };
}

export class InMemoryRecordingArchiveRepository implements RecordingArchiveRepository {
  private readonly archives = new Map<string, RecordingArchive>();

  async create(archive: RecordingArchive): Promise<RecordingArchive> {
    this.archives.set(archive.id, structuredClone(archive));
    return structuredClone(archive);
  }

  async page(tenantId: string, query: ArchiveQuery): Promise<PageResult<RecordingArchive>> {
    const filtered = [...this.archives.values()]
      .filter((archive) => archive.tenantId === tenantId
        && (query.cameraId === undefined || archive.cameraId === query.cameraId)
        && (query.plotCode === undefined || archive.plotCode === query.plotCode)
        && (query.source === undefined || archive.source === query.source)
        && (query.status === undefined || archive.status === query.status)
        && (query.from === undefined || archive.eventAt >= query.from)
        && (query.to === undefined || archive.eventAt <= query.to))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const start = (query.page - 1) * query.size;
    return { items: filtered.slice(start, start + query.size).map((archive) => structuredClone(archive)), total: filtered.length, page: query.page, size: query.size, pages: Math.ceil(filtered.length / query.size) };
  }

  async find(tenantId: string, id: string): Promise<RecordingArchive | null> {
    const archive = this.archives.get(id);
    return archive && archive.tenantId === tenantId ? structuredClone(archive) : null;
  }

  async settle(tenantId: string, id: string, patch: { status: ArchiveStatus; storageKey?: string; playbackUrl?: string; message?: string }, at?: string): Promise<RecordingArchive | null> {
    const archive = this.archives.get(id);
    if (!archive || archive.tenantId !== tenantId) return null;
    archive.status = patch.status;
    if (patch.storageKey !== undefined) archive.storageKey = patch.storageKey;
    if (patch.playbackUrl !== undefined) archive.playbackUrl = patch.playbackUrl;
    if (patch.message !== undefined) archive.message = patch.message;
    archive.settledAt = at ?? new Date().toISOString();
    return structuredClone(archive);
  }
}

const columns = "id, tenant_id, camera_id, plot_code, source, event_id, event_type, event_at, pre_seconds, post_seconds, started_at, ended_at, storage_key, playback_url, status, message, note, created_at, settled_at";

function fromRow(row: Record<string, unknown>): RecordingArchive {
  const archive: RecordingArchive = {
    id: String(row.id), tenantId: String(row.tenant_id), cameraId: String(row.camera_id), plotCode: String(row.plot_code),
    source: row.source as ArchiveSource, eventId: String(row.event_id), eventType: String(row.event_type),
    eventAt: toIsoTimestamp(row.event_at), preSeconds: Number(row.pre_seconds), postSeconds: Number(row.post_seconds),
    startedAt: toIsoTimestamp(row.started_at), endedAt: toIsoTimestamp(row.ended_at),
    storageKey: String(row.storage_key), playbackUrl: String(row.playback_url),
    status: row.status as ArchiveStatus, message: String(row.message), note: String(row.note),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.settled_at != null) archive.settledAt = toIsoTimestamp(row.settled_at);
  return archive;
}

export class SqlRecordingArchiveRepository implements RecordingArchiveRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(archive: RecordingArchive): Promise<RecordingArchive> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO video_recording_archives (${columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING ${columns}`,
      archive.id, archive.tenantId, archive.cameraId, archive.plotCode, archive.source, archive.eventId, archive.eventType,
      archive.eventAt, archive.preSeconds, archive.postSeconds, archive.startedAt, archive.endedAt,
      archive.storageKey, archive.playbackUrl, archive.status, archive.message, archive.note, archive.createdAt, archive.settledAt ?? null,
    );
    return fromRow(rows[0]!);
  }

  async page(tenantId: string, query: ArchiveQuery): Promise<PageResult<RecordingArchive>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (query.cameraId !== undefined) { values.push(query.cameraId); where.push(`camera_id = $${values.length}`); }
    if (query.plotCode !== undefined) { values.push(query.plotCode); where.push(`plot_code = $${values.length}`); }
    if (query.source !== undefined) { values.push(query.source); where.push(`source = $${values.length}`); }
    if (query.status !== undefined) { values.push(query.status); where.push(`status = $${values.length}`); }
    if (query.from !== undefined) { values.push(query.from); where.push(`event_at >= $${values.length}::timestamptz`); }
    if (query.to !== undefined) { values.push(query.to); where.push(`event_at <= $${values.length}::timestamptz`); }
    const filter = where.join(" AND ");
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM video_recording_archives WHERE ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM video_recording_archives WHERE ${filter} ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values,
    );
    return { items: rows.map(fromRow), total, page: query.page, size: query.size, pages: Math.ceil(total / query.size) };
  }

  async find(tenantId: string, id: string): Promise<RecordingArchive | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${columns} FROM video_recording_archives WHERE tenant_id = $1 AND id = $2`, tenantId, id);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async settle(tenantId: string, id: string, patch: { status: ArchiveStatus; storageKey?: string; playbackUrl?: string; message?: string }, at?: string): Promise<RecordingArchive | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE video_recording_archives SET status = $3,
         storage_key = COALESCE($4, storage_key), playback_url = COALESCE($5, playback_url), message = COALESCE($6, message),
         settled_at = $7::timestamptz
       WHERE tenant_id = $1 AND id = $2 RETURNING ${columns}`,
      tenantId, id, patch.status, patch.storageKey ?? null, patch.playbackUrl ?? null, patch.message ?? null, at ?? new Date().toISOString(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
}