import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/** 安全事件类型：作业前预检失败 / 围栏越界 / RTK 质量劣化 / 通信失联 / 急停 */
export type TractorSafetyKind = "PRECHECK_FAIL" | "GEOFENCE_BREACH" | "RTK_QUALITY" | "COMM_LOSS" | "ESTOP";

export const TRACTOR_SAFETY_KINDS: TractorSafetyKind[] = ["PRECHECK_FAIL", "GEOFENCE_BREACH", "RTK_QUALITY", "COMM_LOSS", "ESTOP"];

export interface TractorSafetyEvent {
  id: string;
  tenantId: string;
  jobId?: string;
  plotCode: string;
  deviceId: string;
  kind: TractorSafetyKind;
  level: "WARNING" | "CRITICAL";
  message: string;
  lng?: number;
  lat?: number;
  createdAt: string;
}

export interface CreateTractorSafetyEventInput {
  tenantId: string;
  jobId?: string;
  plotCode: string;
  deviceId: string;
  kind: TractorSafetyKind;
  level: "WARNING" | "CRITICAL";
  message: string;
  lng?: number;
  lat?: number;
}

export interface TractorSafetyEventQuery {
  jobId?: string;
  plotCode?: string;
  kind?: TractorSafetyKind;
  limit?: number;
}

export interface TractorSafetyEventRepository {
  create(tx: Tx | undefined, input: CreateTractorSafetyEventInput): Promise<TractorSafetyEvent>;
  list(query: TractorSafetyEventQuery): Promise<TractorSafetyEvent[]>;
}

function toEvent(row: Record<string, unknown>): TractorSafetyEvent {
  const event: TractorSafetyEvent = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    plotCode: String(row.plot_code ?? ""),
    deviceId: String(row.device_id ?? ""),
    kind: String(row.kind) as TractorSafetyKind,
    level: String(row.level) as "WARNING" | "CRITICAL",
    message: String(row.message ?? ""),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.job_id !== null && row.job_id !== undefined) event.jobId = String(row.job_id);
  if (row.lng !== null && row.lng !== undefined) event.lng = Number(row.lng);
  if (row.lat !== null && row.lat !== undefined) event.lat = Number(row.lat);
  return event;
}

/** 内存实现：仅供测试与降级路径，构造默认空库 */
export class InMemoryTractorSafetyEventRepository implements TractorSafetyEventRepository {
  private readonly events = new Map<string, TractorSafetyEvent>();

  async create(_tx: Tx | undefined, input: CreateTractorSafetyEventInput): Promise<TractorSafetyEvent> {
    const event: TractorSafetyEvent = {
      id: ulid(),
      tenantId: input.tenantId,
      plotCode: input.plotCode,
      deviceId: input.deviceId,
      kind: input.kind,
      level: input.level,
      message: input.message,
      createdAt: new Date().toISOString(),
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      ...(input.lng !== undefined ? { lng: input.lng } : {}),
      ...(input.lat !== undefined ? { lat: input.lat } : {}),
    };
    this.events.set(event.id, structuredClone(event));
    return structuredClone(event);
  }

  async list(query: TractorSafetyEventQuery): Promise<TractorSafetyEvent[]> {
    return [...this.events.values()]
      .filter((event) => (query.jobId === undefined || event.jobId === query.jobId)
        && (query.plotCode === undefined || event.plotCode === query.plotCode)
        && (query.kind === undefined || event.kind === query.kind))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, query.limit ?? 50)
      .map((event) => structuredClone(event));
  }
}

/** SQL 实现：迁移 065 的 tractor_safety_events */
export class SqlTractorSafetyEventRepository implements TractorSafetyEventRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(tx: Tx | undefined, input: CreateTractorSafetyEventInput): Promise<TractorSafetyEvent> {
    const client = tx ?? this.client;
    const rows = await client.$queryRawUnsafe(
      `INSERT INTO tractor_safety_events (id, tenant_id, job_id, plot_code, device_id, kind, level, message, lng, lat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      ulid(), input.tenantId, input.jobId ?? null, input.plotCode, input.deviceId, input.kind, input.level, input.message,
      input.lng ?? null, input.lat ?? null,
    ) as Record<string, unknown>[];
    return toEvent(rows[0]!);
  }

  async list(query: TractorSafetyEventQuery): Promise<TractorSafetyEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (query.jobId !== undefined) add("job_id = ?", query.jobId);
    if (query.plotCode !== undefined) add("plot_code = ?", query.plotCode);
    if (query.kind !== undefined) add("kind = ?", query.kind);
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(200, Math.max(1, query.limit ?? 50)));
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM tractor_safety_events${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      ...params,
    ) as Record<string, unknown>[];
    return rows.map(toEvent);
  }
}
