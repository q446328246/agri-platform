import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

export const PTZ_ACTIONS = ["LEFT", "RIGHT", "UP", "DOWN", "ZOOM_IN", "ZOOM_OUT", "STOP"] as const;
export type PtzAction = typeof PTZ_ACTIONS[number];
export type PtzStatus = "QUEUED" | "SENT" | "FAILED";

/** 云台指令台账：记录操作意图与真实投递结果，未接入硬件通道时留存为 QUEUED */
export interface PtzCommand {
  id: string;
  tenantId: string;
  cameraId: string;
  action: PtzAction;
  speed?: number;
  status: PtzStatus;
  message: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface PtzQuery {
  page: number;
  size: number;
  cameraId?: string;
}

export interface PtzRepository {
  create(command: PtzCommand): Promise<PtzCommand>;
  page(tenantId: string, query: PtzQuery): Promise<PageResult<PtzCommand>>;
  find(tenantId: string, id: string): Promise<PtzCommand | null>;
  settle(tenantId: string, id: string, status: PtzStatus, message: string, at?: string): Promise<PtzCommand | null>;
}

export class InMemoryPtzRepository implements PtzRepository {
  private readonly commands = new Map<string, PtzCommand>();

  async create(command: PtzCommand): Promise<PtzCommand> {
    this.commands.set(command.id, structuredClone(command));
    return structuredClone(command);
  }

  async page(tenantId: string, query: PtzQuery): Promise<PageResult<PtzCommand>> {
    const filtered = [...this.commands.values()]
      .filter((command) => command.tenantId === tenantId && (query.cameraId === undefined || command.cameraId === query.cameraId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const start = (query.page - 1) * query.size;
    return { items: filtered.slice(start, start + query.size).map((command) => structuredClone(command)), total: filtered.length, page: query.page, size: query.size, pages: Math.ceil(filtered.length / query.size) };
  }

  async find(tenantId: string, id: string): Promise<PtzCommand | null> {
    const command = this.commands.get(id);
    return command && command.tenantId === tenantId ? structuredClone(command) : null;
  }

  async settle(tenantId: string, id: string, status: PtzStatus, message: string, at?: string): Promise<PtzCommand | null> {
    const command = this.commands.get(id);
    if (!command || command.tenantId !== tenantId) return null;
    command.status = status;
    command.message = message;
    if (status === "QUEUED") delete command.deliveredAt;
    else command.deliveredAt = at ?? new Date().toISOString();
    return structuredClone(command);
  }
}

const columns = "id, tenant_id, camera_id, action, speed, status, message, created_at, delivered_at";

function fromRow(row: Record<string, unknown>): PtzCommand {
  const command: PtzCommand = {
    id: String(row.id), tenantId: String(row.tenant_id), cameraId: String(row.camera_id),
    action: row.action as PtzAction, status: row.status as PtzStatus, message: String(row.message),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.speed != null) command.speed = Number(row.speed);
  if (row.delivered_at != null) command.deliveredAt = toIsoTimestamp(row.delivered_at);
  return command;
}

export class SqlPtzRepository implements PtzRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(command: PtzCommand): Promise<PtzCommand> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO video_ptz_commands (${columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${columns}`,
      command.id, command.tenantId, command.cameraId, command.action, command.speed ?? null,
      command.status, command.message, command.createdAt, command.deliveredAt ?? null,
    );
    return fromRow(rows[0]!);
  }

  async page(tenantId: string, query: PtzQuery): Promise<PageResult<PtzCommand>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (query.cameraId !== undefined) { values.push(query.cameraId); where.push(`camera_id = $${values.length}`); }
    const filter = where.join(" AND ");
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM video_ptz_commands WHERE ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM video_ptz_commands WHERE ${filter} ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values,
    );
    return { items: rows.map(fromRow), total, page: query.page, size: query.size, pages: Math.ceil(total / query.size) };
  }

  async find(tenantId: string, id: string): Promise<PtzCommand | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${columns} FROM video_ptz_commands WHERE tenant_id = $1 AND id = $2`, tenantId, id);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async settle(tenantId: string, id: string, status: PtzStatus, message: string, at?: string): Promise<PtzCommand | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE video_ptz_commands SET status = $3, message = $4,
         delivered_at = CASE WHEN $3 = 'QUEUED' THEN NULL ELSE $5::timestamptz END
       WHERE tenant_id = $1 AND id = $2 RETURNING ${columns}`,
      tenantId, id, status, message, at ?? new Date().toISOString(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
}