import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 控制指令仓储。
 *
 * 指令有两条来源：操作人二次确认后人工下达（MANUAL），以及事件消费依据
 * 越限/处方事件自动生成（EVENT）。自动指令保留来源事件标识并由唯一索引兜住
 * 重复投递，因此消费侧重放不会推出第二条指令。
 */

/** 指令类型 */
export type ControlCommandType = "SEEDING" | "IRRIGATION" | "WEEDING" | "FERTILIZATION";

/** 指令状态：QUEUED 已入队、SENT 已下发、FAILED 下发失败 */
export type ControlCommandStatus = "QUEUED" | "SENT" | "FAILED";

/** 指令来源 */
export type ControlOrigin = "MANUAL" | "EVENT";

/** 指令记录 */
export interface ControlCommand {
  id: string;
  deviceId: string;
  plotCode: string;
  operatorId: string;
  /** 人工确认时间；自动指令为空，表示无需二次确认 */
  confirmedAt?: string;
  type: ControlCommandType;
  parameters: Record<string, unknown>;
  status: ControlCommandStatus;
  origin: ControlOrigin;
  /** 来源事件标识，同一事件的重复投递只会生成一条指令 */
  sourceEventId?: string;
  /** 指令缘由，用于列表展示与追溯 */
  reason: string;
  createdAt: string;
}

/** 指令查询条件 */
export interface ControlCommandQuery {
  plotCode?: string;
  origin?: ControlOrigin;
  page: number;
  size: number;
}

export interface ControlCommandRepository {
  /** 写入指令；来源事件已存在时返回 null */
  create(command: ControlCommand): Promise<ControlCommand | null>;
  page(query: ControlCommandQuery): Promise<PageResult<ControlCommand>>;
}

function toPage(items: ControlCommand[], total: number, page: number, size: number): PageResult<ControlCommand> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

function toRecord(row: Record<string, unknown>): ControlCommand {
  const record: ControlCommand = {
    id: String(row.id),
    deviceId: String(row.device_id),
    plotCode: String(row.plot_code ?? ""),
    operatorId: String(row.operator_id),
    type: row.type as ControlCommandType,
    parameters: (row.parameters ?? {}) as Record<string, unknown>,
    status: row.status as ControlCommandStatus,
    origin: row.origin === "EVENT" ? "EVENT" : "MANUAL",
    reason: String(row.reason ?? ""),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.confirmed_at !== null && row.confirmed_at !== undefined) record.confirmedAt = toIsoTimestamp(row.confirmed_at);
  if (row.source_event_id !== null && row.source_event_id !== undefined) record.sourceEventId = String(row.source_event_id);
  return record;
}

/** PostgreSQL 实现，表结构由迁移 005 管理 */
export class SqlControlCommandRepository implements ControlCommandRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(command: ControlCommand): Promise<ControlCommand | null> {
    // 唯一索引冲突说明同一来源事件已生成指令，返回空表示无需重复写入
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO control_commands (id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, created_at`,
      command.id,
      command.deviceId,
      command.plotCode,
      command.operatorId,
      command.confirmedAt ?? null,
      command.type,
      JSON.stringify(command.parameters),
      command.status,
      command.origin,
      command.sourceEventId ?? null,
      command.reason,
      command.createdAt,
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async page(query: ControlCommandQuery): Promise<PageResult<ControlCommand>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.plotCode !== undefined && query.plotCode !== "") {
      values.push(query.plotCode);
      conditions.push(`plot_code = $${values.length}`);
    }
    if (query.origin) {
      values.push(query.origin);
      conditions.push(`origin = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(
      `SELECT COUNT(*)::int AS total FROM control_commands ${where}`,
      ...values,
    );
    const total = Number(totalRows[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, created_at
       FROM control_commands ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      ...values,
    );
    return toPage(rows.map(toRecord), total, query.page, query.size);
  }
}

/** 内存实现：未接入数据库的本地模式与测试使用 */
export class InMemoryControlCommandRepository implements ControlCommandRepository {
  private readonly rows: ControlCommand[] = [];

  constructor(seed: ControlCommand[] = []) {
    this.rows.push(...seed);
  }

  async create(command: ControlCommand): Promise<ControlCommand | null> {
    if (this.rows.some((row) => row.id === command.id)) return null;
    if (command.sourceEventId !== undefined && this.rows.some((row) => row.sourceEventId === command.sourceEventId)) {
      return null;
    }
    const record: ControlCommand = { ...command, parameters: { ...command.parameters } };
    this.rows.unshift(record);
    return record;
  }

  async page(query: ControlCommandQuery): Promise<PageResult<ControlCommand>> {
    const filtered = this.rows
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .filter((row) => (query.origin ? row.origin === query.origin : true));
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size), filtered.length, query.page, query.size);
  }

  /** 全部指令，供测试断言 */
  all(): ControlCommand[] {
    return [...this.rows];
  }
}
