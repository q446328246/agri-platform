import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 控制指令仓储。
 *
 * 指令有两条来源：操作人二次确认后人工下达（MANUAL），以及事件消费依据
 * 越限/处方事件自动生成（EVENT）。自动指令保留来源事件标识并由唯一索引兜住
 * 重复投递，因此消费侧重放不会推出第二条指令。
 *
 * 生命周期由回执驱动：QUEUED 入队 → SENT 已下发到设备 → ACKED 设备已接收 →
 * DONE 执行到位，任一在途状态都可被 FAILED 收口。跃迁只允许沿 TRANSITIONS 走，
 * 并以 version 乐观锁兜住「设备网关与人工回填同时到达」的并发。
 */

/** 指令类型；ESTOP 是急停，执行完成必须带到位确认 */
export type ControlCommandType = "SEEDING" | "IRRIGATION" | "WEEDING" | "FERTILIZATION" | "ESTOP";

/** 指令状态 */
export const CONTROL_STATUSES = ["QUEUED", "SENT", "ACKED", "DONE", "FAILED"] as const;
export type ControlCommandStatus = (typeof CONTROL_STATUSES)[number];

/** 尚未收到最终回执的状态，超时看板只关心这些 */
export const PENDING_STATUSES: readonly ControlCommandStatus[] = ["QUEUED", "SENT", "ACKED"];

/** 指令来源 */
export type ControlOrigin = "MANUAL" | "EVENT";

/** 合法跃迁表，终态没有出边 */
const TRANSITIONS: Record<ControlCommandStatus, readonly ControlCommandStatus[]> = {
  QUEUED: ["SENT", "FAILED"],
  SENT: ["ACKED", "DONE", "FAILED"],
  ACKED: ["DONE", "FAILED"],
  DONE: [],
  FAILED: [],
};

/**
 * 状态能否跃迁到目标状态。
 * 同一状态不在表内：重复回执由调用方按幂等直接返回现有记录，免得版本被空转推高。
 */
export function canTransition(from: ControlCommandStatus, to: ControlCommandStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

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
  /** 下发到设备的时间 */
  sentAt?: string;
  /** 设备回执「已接收」的时间 */
  ackedAt?: string;
  /** 执行到位或失败的时间，即生命周期结束时间 */
  finishedAt?: string;
  /** 最后一次回执说明：失败原因或设备侧提示 */
  receiptMessage?: string;
  /** 设备回传的结果快照，急停类指令在这里带到位确认 */
  result?: Record<string, unknown>;
  /** 乐观锁版本，每次跃迁 +1 */
  version: number;
  createdAt: string;
}

/** 一次状态跃迁 */
export interface CommandTransition {
  id: string;
  status: ControlCommandStatus;
  /** 跃迁时间，由调用方给出以便与回执报文一致 */
  at: string;
  /** 期望版本，不匹配则不写入 */
  version: number;
  message?: string;
  result?: Record<string, unknown>;
}

/** 指令查询条件 */
export interface ControlCommandQuery {
  plotCode?: string;
  origin?: ControlOrigin;
  type?: ControlCommandType;
  status?: ControlCommandStatus;
  deviceId?: string;
  /** 创建时间区间，由 HTTP 层扩展为完整 ISO 后传入，按字典序比较 */
  from?: string;
  to?: string;
  /** 只看未收到最终回执的指令 */
  pending?: boolean;
  /** 在途时长下限（分钟），配合 pending 筛超时未回执 */
  pendingOverMin?: number;
  page: number;
  size: number;
}

export interface ControlCommandRepository {
  /** 写入指令；来源事件已存在时返回 null */
  create(command: ControlCommand): Promise<ControlCommand | null>;
  page(query: ControlCommandQuery): Promise<PageResult<ControlCommand>>;
  find(id: string): Promise<ControlCommand | null>;
  /** 沿合法跃迁表推进状态；记录不存在、版本过期或跃迁非法时返回 null */
  transition(transition: CommandTransition): Promise<ControlCommand | null>;
}

function toPage(items: ControlCommand[], total: number, page: number, size: number): PageResult<ControlCommand> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

/** 在途时长（分钟），从最后一次状态推进时间起算；已结束的指令返回 undefined */
export function pendingMinutesOf(command: ControlCommand, nowMs: number): number | undefined {
  if (!PENDING_STATUSES.includes(command.status)) return undefined;
  const since = Date.parse(command.ackedAt ?? command.sentAt ?? command.createdAt);
  if (!Number.isFinite(since)) return undefined;
  return Math.max(0, Math.round((nowMs - since) / 60000));
}

const COLUMNS =
  "id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, sent_at, acked_at, finished_at, receipt_message, result_json, version, created_at";

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
    version: Number(row.version ?? 1),
    createdAt: toIsoTimestamp(row.created_at),
  };
  for (const [column, key] of [
    ["confirmed_at", "confirmedAt"],
    ["sent_at", "sentAt"],
    ["acked_at", "ackedAt"],
    ["finished_at", "finishedAt"],
  ] as const) {
    if (row[column] !== null && row[column] !== undefined) record[key] = toIsoTimestamp(row[column]);
  }
  if (row.source_event_id !== null && row.source_event_id !== undefined) record.sourceEventId = String(row.source_event_id);
  if (row.receipt_message !== null && row.receipt_message !== undefined) record.receiptMessage = String(row.receipt_message);
  if (row.result_json !== null && row.result_json !== undefined) record.result = row.result_json as Record<string, unknown>;
  return record;
}

/** PostgreSQL 实现，表结构由迁移 005 建立、031 扩展回执列 */
export class SqlControlCommandRepository implements ControlCommandRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(command: ControlCommand): Promise<ControlCommand | null> {
    // 唯一索引冲突说明同一来源事件已生成指令，返回空表示无需重复写入
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO control_commands (id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
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
    if (query.type) {
      values.push(query.type);
      conditions.push(`type = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    if (query.deviceId) {
      values.push(query.deviceId);
      conditions.push(`device_id = $${values.length}`);
    }
    if (query.from) {
      values.push(query.from);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      conditions.push(`created_at <= $${values.length}`);
    }
    // 超时口径必须连带排掉终态行：终态没有在途时长，只看时间差会把历史指令也算成「未回执」。
    if (query.pending || query.pendingOverMin !== undefined) {
      conditions.push("status IN ('QUEUED', 'SENT', 'ACKED')");
    }
    if (query.pendingOverMin !== undefined) {
      values.push(query.pendingOverMin);
      conditions.push(`now() - COALESCE(acked_at, sent_at, created_at) > make_interval(mins => $${values.length}::int)`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(
      `SELECT COUNT(*)::int AS total FROM control_commands ${where}`,
      ...values,
    );
    const total = Number(totalRows[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS}
       FROM control_commands ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      ...values,
    );
    return toPage(rows.map(toRecord), total, query.page, query.size);
  }

  async find(id: string): Promise<ControlCommand | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS} FROM control_commands WHERE id = $1`,
      id,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async transition(transition: CommandTransition): Promise<ControlCommand | null> {
    // 跃迁合法性按库内当前状态判定，调用方拿着陈旧记录也绕不过状态机；
    // 并发写入由 UPDATE 上的 version 条件拦住，两种失败都收敛成 null（HTTP 侧回 409）。
    const current = await this.statusOf(transition.id);
    if (current === null || !canTransition(current, transition.status)) return null;
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `UPDATE control_commands
          SET status = $3,
              version = version + 1,
              sent_at = CASE WHEN $3 = 'SENT' THEN $4::timestamptz ELSE sent_at END,
              acked_at = CASE WHEN $3 = 'ACKED' THEN $4::timestamptz ELSE acked_at END,
              finished_at = CASE WHEN $3 IN ('DONE', 'FAILED') THEN $4::timestamptz ELSE finished_at END,
              receipt_message = COALESCE($5::text, receipt_message),
              result_json = COALESCE($6::jsonb, result_json)
        WHERE id = $1 AND version = $2
        RETURNING ${COLUMNS}`,
      transition.id,
      transition.version,
      transition.status,
      transition.at,
      transition.message ?? null,
      transition.result === undefined ? null : JSON.stringify(transition.result),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  private async statusOf(id: string): Promise<ControlCommandStatus | null> {
    const rows = await this.client.$queryRawUnsafe<Array<{ status: string }>>(
      "SELECT status FROM control_commands WHERE id = $1",
      id,
    );
    const status = rows[0]?.status;
    return status && (CONTROL_STATUSES as readonly string[]).includes(status) ? (status as ControlCommandStatus) : null;
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
    const nowMs = Date.now();
    const filtered = this.rows
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .filter((row) => (query.origin ? row.origin === query.origin : true))
      .filter((row) => (query.type ? row.type === query.type : true))
      .filter((row) => (query.status ? row.status === query.status : true))
      .filter((row) => (query.deviceId ? row.deviceId === query.deviceId : true))
      .filter((row) => (query.from ? row.createdAt >= query.from : true))
      .filter((row) => (query.to ? row.createdAt <= query.to : true))
      .filter((row) => (query.pending ? PENDING_STATUSES.includes(row.status) : true))
      .filter((row) => {
        if (query.pendingOverMin === undefined) return true;
        const waited = pendingMinutesOf(row, nowMs);
        return waited !== undefined && waited >= query.pendingOverMin;
      });
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size), filtered.length, query.page, query.size);
  }

  async find(id: string): Promise<ControlCommand | null> {
    const row = this.rows.find((item) => item.id === id);
    return row ? structuredClone(row) : null;
  }

  async transition(transition: CommandTransition): Promise<ControlCommand | null> {
    const row = this.rows.find((item) => item.id === transition.id);
    if (!row || row.version !== transition.version || !canTransition(row.status, transition.status)) return null;
    row.status = transition.status;
    row.version += 1;
    if (transition.status === "SENT") row.sentAt = transition.at;
    if (transition.status === "ACKED") row.ackedAt = transition.at;
    if (transition.status === "DONE" || transition.status === "FAILED") row.finishedAt = transition.at;
    if (transition.message !== undefined) row.receiptMessage = transition.message;
    if (transition.result !== undefined) row.result = structuredClone(transition.result);
    return structuredClone(row);
  }

  /** 全部指令，供测试断言 */
  all(): ControlCommand[] {
    return [...this.rows];
  }
}
