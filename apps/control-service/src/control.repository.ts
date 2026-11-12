import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
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
 *
 * 指令按租户隔离（迁移 032）：读、写、跃迁都要带 tenantId，跨租户的 id 一律当作不存在，
 * 与 operation_tasks / video_ptz_commands 同一口径。
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
  /** 所属租户，由网关透传的可信身份或事件信封决定，不接受请求体自报 */
  tenantId: string;
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
  page(tenantId: string, query: ControlCommandQuery): Promise<PageResult<ControlCommand>>;
  find(tenantId: string, id: string): Promise<ControlCommand | null>;
  /** 沿合法跃迁表推进状态；记录不存在、不属于该租户、版本过期或跃迁非法时返回 null。
   *  传入 tx 时读写都走该事务，供「跃迁 + 事件入队」原子提交。 */
  transition(tenantId: string, transition: CommandTransition, tx?: Tx): Promise<ControlCommand | null>;
  /** 跨租户捞出超时未回执的在途指令，按等待时长从久到新排序；调用方按行内 tenantId 收口 */
  listOverdue(timeoutMin: number, nowMs: number, limit: number): Promise<ControlCommand[]>;
}

function toPage(items: ControlCommand[], total: number, page: number, size: number): PageResult<ControlCommand> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

/** 指令在途起点：最后一次状态推进时间，没有推进过就是入队时间 */
function overdueSinceMs(command: ControlCommand): number {
  return Date.parse(command.ackedAt ?? command.sentAt ?? command.createdAt);
}

/** 在途时长（分钟），从最后一次状态推进时间起算；已结束的指令返回 undefined */
export function pendingMinutesOf(command: ControlCommand, nowMs: number): number | undefined {
  if (!PENDING_STATUSES.includes(command.status)) return undefined;
  const since = overdueSinceMs(command);
  if (!Number.isFinite(since)) return undefined;
  return Math.max(0, Math.round((nowMs - since) / 60000));
}

/**
 * 是否已超时未回执：在途且等待时长超过阈值。
 * 列表筛选与定时收口必须同一个判断，否则「页面上标红」和「后台真正收口」会变成两套口径。
 * 这里按毫秒精确比较、用严格大于，与 SQL 侧 `now() - … > make_interval(mins => n)` 对齐：
 * 先四舍五入再比大小会让内存模式把只差半分钟的行也算成超时。
 */
function isOverdue(command: ControlCommand, nowMs: number, timeoutMin: number | undefined): boolean {
  if (timeoutMin === undefined) return true;
  if (!PENDING_STATUSES.includes(command.status)) return false;
  const since = overdueSinceMs(command);
  if (!Number.isFinite(since)) return false;
  return nowMs - since > timeoutMin * 60_000;
}

const COLUMNS =
  "id, tenant_id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, sent_at, acked_at, finished_at, receipt_message, result_json, version, created_at";

function toRecord(row: Record<string, unknown>): ControlCommand {
  const record: ControlCommand = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
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

/** PostgreSQL 实现，表结构由迁移 005 建立、031 扩展回执列、032 补租户归属 */
export class SqlControlCommandRepository implements ControlCommandRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(command: ControlCommand): Promise<ControlCommand | null> {
    // 唯一索引冲突说明同一来源事件已生成指令，返回空表示无需重复写入
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO control_commands (id, tenant_id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      command.id,
      command.tenantId,
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

  async page(tenantId: string, query: ControlCommandQuery): Promise<PageResult<ControlCommand>> {
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
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

  async find(tenantId: string, id: string): Promise<ControlCommand | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS} FROM control_commands WHERE tenant_id = $1 AND id = $2`,
      tenantId,
      id,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async transition(tenantId: string, transition: CommandTransition, tx?: Tx): Promise<ControlCommand | null> {
    // 跃迁合法性按库内当前状态判定，调用方拿着陈旧记录也绕不过状态机；
    // 并发写入由 UPDATE 上的 version 条件拦住，跨租户按「不存在」处理，
    // 三种失败都收敛成 null（HTTP 侧分别回 409 / 409 / 404）。
    // 带 tx 时读写都走同一事务，状态与 outbox 事件要么同时成功要么同时回滚。
    const executor = tx ?? this.client;
    const current = await this.statusOf(tenantId, transition.id, executor);
    if (current === null || !canTransition(current, transition.status)) return null;
    const rows = await executor.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `UPDATE control_commands
          SET status = $4,
              version = version + 1,
              sent_at = CASE WHEN $4 = 'SENT' THEN $5::timestamptz ELSE sent_at END,
              acked_at = CASE WHEN $4 = 'ACKED' THEN $5::timestamptz ELSE acked_at END,
              finished_at = CASE WHEN $4 IN ('DONE', 'FAILED') THEN $5::timestamptz ELSE finished_at END,
              receipt_message = COALESCE($6::text, receipt_message),
              result_json = COALESCE($7::jsonb, result_json)
        WHERE tenant_id = $1 AND id = $2 AND version = $3
        RETURNING ${COLUMNS}`,
      tenantId,
      transition.id,
      transition.version,
      transition.status,
      transition.at,
      transition.message ?? null,
      transition.result === undefined ? null : JSON.stringify(transition.result),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  private async statusOf(tenantId: string, id: string, executor: PrismaClientLike | Tx = this.client): Promise<ControlCommandStatus | null> {
    const rows = await executor.$queryRawUnsafe<Array<{ status: string }>>(
      "SELECT status FROM control_commands WHERE tenant_id = $1 AND id = $2",
      tenantId,
      id,
    );
    const status = rows[0]?.status;
    return status && (CONTROL_STATUSES as readonly string[]).includes(status) ? (status as ControlCommandStatus) : null;
  }

  async listOverdue(timeoutMin: number, nowMs: number, limit: number): Promise<ControlCommand[]> {
    // 与列表筛选 overdue=true 同一个 SQL 口径，只是跨租户、且只取本轮要收口的那么几条；
    // 排序按在途起点（最后一次状态推进时间）从久到新，最该收口的先处理。
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS}
       FROM control_commands
       WHERE status IN ('QUEUED', 'SENT', 'ACKED')
         AND now() - COALESCE(acked_at, sent_at, created_at) > make_interval(mins => $1::int)
       ORDER BY COALESCE(acked_at, sent_at, created_at), id
       LIMIT $2`,
      timeoutMin,
      limit,
    );
    return rows.map(toRecord);
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
    // 建档只写 SQL 侧 INSERT 的那几列：版本从 1 起算，在途时间戳与回执一律由跃迁写入。
    // 照单全收调用方塞来的 version/sentAt 会让内存模式凭空铺出「已下发」的假记录，
    // 而 SQL 模式把这类列留给默认值，同一个夹具两套模式跑出不同的行。
    const record: ControlCommand = {
      ...command,
      parameters: { ...command.parameters },
      version: 1,
      status: command.status,
    };
    delete record.sentAt;
    delete record.ackedAt;
    delete record.finishedAt;
    delete record.receiptMessage;
    delete record.result;
    this.rows.unshift(record);
    return structuredClone(record);
  }

  async page(tenantId: string, query: ControlCommandQuery): Promise<PageResult<ControlCommand>> {
    const nowMs = Date.now();
    const filtered = this.rows
      .filter((row) => row.tenantId === tenantId)
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .filter((row) => (query.origin ? row.origin === query.origin : true))
      .filter((row) => (query.type ? row.type === query.type : true))
      .filter((row) => (query.status ? row.status === query.status : true))
      .filter((row) => (query.deviceId ? row.deviceId === query.deviceId : true))
      .filter((row) => (query.from ? row.createdAt >= query.from : true))
      .filter((row) => (query.to ? row.createdAt <= query.to : true))
      .filter((row) => (query.pending ? PENDING_STATUSES.includes(row.status) : true))
      .filter((row) => isOverdue(row, nowMs, query.pendingOverMin));
    // 排序与 SQL 侧一致（created_at DESC, id DESC）：内存里靠插入顺序，一旦有回填的
    // 历史指令就会翻页，同一页两套模式拿到不同的行。
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size), filtered.length, query.page, query.size);
  }

  async find(tenantId: string, id: string): Promise<ControlCommand | null> {
    const row = this.rows.find((item) => item.tenantId === tenantId && item.id === id);
    return row ? structuredClone(row) : null;
  }

  async transition(tenantId: string, transition: CommandTransition, _tx?: Tx): Promise<ControlCommand | null> {
    const row = this.rows.find((item) => item.tenantId === tenantId && item.id === transition.id);
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

  async listOverdue(timeoutMin: number, nowMs: number, limit: number): Promise<ControlCommand[]> {
    return this.rows
      .filter((row) => PENDING_STATUSES.includes(row.status))
      .filter((row) => isOverdue(row, nowMs, timeoutMin))
      .sort((a, b) => overdueSinceMs(a) - overdueSinceMs(b) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  /** 全部指令，供测试断言 */
  all(): ControlCommand[] {
    return [...this.rows];
  }
}
