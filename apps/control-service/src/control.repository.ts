import { isJobCommandType, type PageResult } from "@agri/contracts";
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
 * DONE 执行到位，任一在途状态都可被 FAILED 收口；尚未领取的 QUEUED 还可被
 * CANCELLED 撤回（墒情达上限自动停灌或人工取消）。跃迁只允许沿 TRANSITIONS 走，
 * 并以 version 乐观锁兜住「设备网关与人工回填同时到达」的并发。
 *
 * 指令按租户隔离（迁移 032）：读、写、跃迁都要带 tenantId，跨租户的 id 一律当作不存在，
 * 与 operation_tasks / video_ptz_commands 同一口径。
 */

/** 指令类型；ESTOP/POWER_OFF 是急停/断电，执行完成必须带到位确认；
 *  PAUSE/RESUME 通过 parameters.targetCommandId 指向目标指令，结单时联动目标状态（迁移 050） */
export type ControlCommandType =
  | "SEEDING" | "IRRIGATION" | "WEEDING" | "FERTILIZATION" | "ESTOP"
  | "PAUSE" | "RESUME" | "RETURN_HOME" | "POWER_OFF" | "TOOL_SWITCH" | "TILLAGE";

/** 指令状态；CANCELLED 是未执行先撤回（自动停灌/人工取消），与 FAILED 的执行失败分开记；
 *  PAUSED 是作业中断（方案 8.8 续作补作的前半段），仍属在途，可恢复/结单/失败收口 */
export const CONTROL_STATUSES = ["QUEUED", "SENT", "ACKED", "PAUSED", "DONE", "FAILED", "CANCELLED"] as const;
export type ControlCommandStatus = (typeof CONTROL_STATUSES)[number];

/** 尚未收到最终回执的状态，超时看板只关心这些；暂停不是结单，没人恢复的指令仍要被收口告知 */
export const PENDING_STATUSES: readonly ControlCommandStatus[] = ["QUEUED", "SENT", "ACKED", "PAUSED"];
export const TIMEOUT_ESTOP_IDEMPOTENCY_PREFIX = "control-timeout-estop:";

/** 指令来源 */
export type ControlOrigin = "MANUAL" | "EVENT";

/** 合法跃迁表，终态没有出边。CANCELLED 只从 QUEUED 出发：已被网关领取的指令撤回不了，只能急停；
 *  PAUSED 从 SENT/ACKED 出发（设备自主上报或 PAUSE 指令结单联动），恢复后回到 ACKED 继续推进 */
const TRANSITIONS: Record<ControlCommandStatus, readonly ControlCommandStatus[]> = {
  QUEUED: ["SENT", "FAILED", "CANCELLED"],
  SENT: ["ACKED", "PAUSED", "DONE", "FAILED"],
  ACKED: ["PAUSED", "DONE", "FAILED"],
  PAUSED: ["ACKED", "DONE", "FAILED"],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
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
  /** 调用方幂等键；拖拉机分步崩溃重试复用同一指令 */
  idempotencyKey?: string;
  /** 指令缘由，用于列表展示与追溯 */
  reason: string;
  /** 定时执行时刻（迁移 050）：设备网关只领取已到期的指令，缺省入队即可执行 */
  scheduledAt?: string;
  /** 下发到设备的时间 */
  sentAt?: string;
  /** 设备回执「已接收」的时间 */
  ackedAt?: string;
  /** 最近一次暂停时间，用于识别跨恢复周期的陈旧暂停回执 */
  pausedAt?: string;
  /** 最近一次从暂停恢复的时间，用于识别跨恢复周期的陈旧恢复/暂停回执 */
  resumedAt?: string;
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
  /** 只看到期可领取的指令（scheduled_at 为空或已到点），设备轮询专用 */
  dueOnly?: boolean;
  /** 在途时长下限（分钟），配合 pending 筛超时未回执 */
  pendingOverMin?: number;
  /** 按创建时间正序返回（默认倒序）：设备侧要按下发先后执行，倒序翻页会把最早的指令饿死 */
  ascending?: boolean;
  page: number;
  size: number;
}

export interface OverdueCursor {
  createdAt: string;
  id: string;
}

export interface ControlCommandRepository {
  /** 写入指令；来源事件已存在时返回 null */
  create(command: ControlCommand, tx?: Tx): Promise<ControlCommand | null>;
  findByIdempotencyKey(tenantId: string, idempotencyKey: string, tx?: Tx): Promise<ControlCommand | null>;
  hasActiveJob(tenantId: string, deviceId: string, excludeId?: string): Promise<boolean>;
  page(tenantId: string, query: ControlCommandQuery): Promise<PageResult<ControlCommand>>;
  find(tenantId: string, id: string, tx?: Tx, options?: { forUpdate?: boolean }): Promise<ControlCommand | null>;
  /** 沿合法跃迁表推进状态；记录不存在、不属于该租户、版本过期或跃迁非法时返回 null。
   *  传入 tx 时读写都走该事务，供「跃迁 + 事件入队」原子提交。 */
  transition(tenantId: string, transition: CommandTransition, tx?: Tx): Promise<ControlCommand | null>;
  /** 无显式事务时原子推进本体与联动目标；SQL 实现自行开启事务，内存实现先校验再同步提交 */
  transitionPair?(
    tenantId: string,
    transition: CommandTransition,
    linked?: { id: string; status: ControlCommandStatus; version: number; at: string; message?: string },
    tx?: Tx,
  ): Promise<{ command: ControlCommand; linkedCommand?: ControlCommand } | null>;
  /** 急停确认后收口同设备仍活跃的作业指令，释放设备互锁并拒绝旧指令继续推进 */
  failActiveJobs(tenantId: string, deviceId: string, emergencyStopId: string, at: string, message: string, tx?: Tx): Promise<ControlCommand[]>;
  /** 跨租户捞出超时未回执的在途指令，按创建顺序游标翻页，避免阻塞指令饿死后续候选 */
  listOverdue(timeoutMin: number, nowMs: number, limit: number, cursor?: OverdueCursor): Promise<ControlCommand[]>;
}

function toPage(items: ControlCommand[], total: number, page: number, size: number): PageResult<ControlCommand> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

/** 指令在途起点：最后一次状态推进时间（含暂停/恢复）；没有推进过就是入队时间，
 *  定时指令取入队与预约时刻的较晚者——预约明早执行的指令不该今晚就被算成超时 */
function overdueSinceMs(command: ControlCommand): number {
  const progressed = [command.sentAt, command.ackedAt, command.pausedAt, command.resumedAt]
    .filter((value): value is string => value !== undefined)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (progressed.length > 0) return Math.max(...progressed);
  const created = Date.parse(command.createdAt);
  const scheduled = command.scheduledAt === undefined ? NaN : Date.parse(command.scheduledAt);
  return Number.isFinite(scheduled) ? Math.max(created, scheduled) : created;
}

function overdueSinceSql(): string {
  return "COALESCE(GREATEST(acked_at, sent_at, paused_at, resumed_at), GREATEST(created_at, scheduled_at))";
}

/** 在途时长（分钟），从最后一次状态推进时间起算；已结束的指令返回 undefined */
export function pendingMinutesOf(command: ControlCommand, nowMs: number): number | undefined {
  if (!PENDING_STATUSES.includes(command.status)) return undefined;
  const since = overdueSinceMs(command);
  if (!Number.isFinite(since)) return undefined;
  return Math.max(0, Math.round((nowMs - since) / 60000));
}

/** 执行包络给出的作业时长优先于通用回执阈值，另留 1 分钟确认缓冲。 */
export function effectiveTimeoutMin(command: ControlCommand, timeoutMin: number): number {
  const base = Number.isFinite(timeoutMin) ? Math.max(1, Math.ceil(timeoutMin)) : 1;
  const plan = command.parameters.plan;
  const duration = plan && typeof plan === "object" ? (plan as Record<string, unknown>).totalDurationMin : undefined;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? Math.max(base, Math.ceil(duration + 1))
    : base;
}

/**
 * 是否已超时未回执：在途且等待时长超过该指令有效阈值。
 * 列表筛选与定时收口必须同一个判断，否则「页面上标红」和「后台真正收口」会变成两套口径。
 * 这里按毫秒精确比较、用严格大于，与 SQL 侧 `now() - … > make_interval(mins => n)` 对齐：
 * 先四舍五入再比大小会让内存模式把只差半分钟的行也算成超时。
 */
function isOverdue(command: ControlCommand, nowMs: number, timeoutMin: number | undefined): boolean {
  if (timeoutMin === undefined) return true;
  if (!PENDING_STATUSES.includes(command.status)) return false;
  const since = overdueSinceMs(command);
  if (!Number.isFinite(since)) return false;
  return nowMs - since > effectiveTimeoutMin(command, timeoutMin) * 60_000;
}

export function isCommandOverdue(command: ControlCommand, nowMs: number, timeoutMin: number): boolean {
  return isOverdue(command, nowMs, timeoutMin);
}

const COLUMNS =
  "id, tenant_id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, idempotency_key, reason, scheduled_at, sent_at, acked_at, paused_at, resumed_at, finished_at, receipt_message, result_json, version, created_at";

function overdueThresholdSql(param: string): string {
  return `GREATEST(CEIL(${param}::numeric), CEIL(COALESCE(CASE WHEN jsonb_typeof(parameters->'plan'->'totalDurationMin') = 'number' THEN (parameters->'plan'->>'totalDurationMin')::numeric ELSE 0 END, 0) + 1), 1)::int`;
}

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
    ["scheduled_at", "scheduledAt"],
    ["sent_at", "sentAt"],
    ["acked_at", "ackedAt"],
    ["paused_at", "pausedAt"],
    ["resumed_at", "resumedAt"],
    ["finished_at", "finishedAt"],
  ] as const) {
    if (row[column] !== null && row[column] !== undefined) record[key] = toIsoTimestamp(row[column]);
  }
  if (row.source_event_id !== null && row.source_event_id !== undefined) record.sourceEventId = String(row.source_event_id);
  if (row.idempotency_key !== null && row.idempotency_key !== undefined) record.idempotencyKey = String(row.idempotency_key);
  if (row.receipt_message !== null && row.receipt_message !== undefined) record.receiptMessage = String(row.receipt_message);
  if (row.result_json !== null && row.result_json !== undefined) record.result = row.result_json as Record<string, unknown>;
  return record;
}

/** PostgreSQL 实现，表结构由迁移 005 建立、031 扩展回执列、032 补租户归属、050 扩类型/暂停态/定时列 */
export class SqlControlCommandRepository implements ControlCommandRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(command: ControlCommand, tx?: Tx): Promise<ControlCommand | null> {
    // 唯一索引冲突说明同一来源事件对该设备已生成指令，返回空表示无需重复写入
    const executor = tx ?? this.client;
    const rows = await executor.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO control_commands (id, tenant_id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, idempotency_key, reason, scheduled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
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
      command.idempotencyKey ?? null,
      command.reason,
      command.scheduledAt ?? null,
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
      conditions.push("status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED')");
    }
    // 定时指令未到点不可领取；GREATEST 忽略 NULL，未预约的指令起点仍是入队时间
    if (query.dueOnly) {
      conditions.push("(scheduled_at IS NULL OR scheduled_at <= now())");
    }
    if (query.pendingOverMin !== undefined) {
      values.push(query.pendingOverMin);
      conditions.push(`now() - ${overdueSinceSql()} > make_interval(mins => ${overdueThresholdSql(`$${values.length}`)})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(
      `SELECT COUNT(*)::int AS total FROM control_commands ${where}`,
      ...values,
    );
    const total = Number(totalRows[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const order = query.ascending ? "ASC" : "DESC";
    const priorityOrder = query.dueOnly ? "CASE WHEN type IN ('ESTOP', 'POWER_OFF') THEN 0 ELSE 1 END," : "";
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS}
       FROM control_commands ${where}
       ORDER BY ${priorityOrder} created_at ${order}, id ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      ...values,
    );
    return toPage(rows.map(toRecord), total, query.page, query.size);
  }

  async find(tenantId: string, id: string, tx?: Tx, options?: { forUpdate?: boolean }): Promise<ControlCommand | null> {
    const executor = tx ?? this.client;
    const rows = await executor.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS} FROM control_commands WHERE tenant_id = $1 AND id = $2${options?.forUpdate ? " FOR UPDATE" : ""}`,
      tenantId,
      id,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string, tx?: Tx): Promise<ControlCommand | null> {
    const executor = tx ?? this.client;
    const rows = await executor.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS} FROM control_commands WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
      tenantId,
      idempotencyKey,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async hasActiveJob(tenantId: string, deviceId: string, excludeId?: string): Promise<boolean> {
    const rows = await this.client.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM control_commands AS command
          WHERE command.tenant_id = $1 AND command.device_id = $2
            AND (
              (command.type IN ('SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION', 'TOOL_SWITCH', 'RETURN_HOME', 'TILLAGE')
                AND command.status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED')
                AND ($3::text IS NULL OR command.id <> $3))
              OR command.id = (
                SELECT latest.id FROM control_commands AS latest
                 WHERE latest.tenant_id = command.tenant_id AND latest.device_id = command.device_id
                   AND latest.type IN ('ESTOP', 'POWER_OFF') AND latest.status <> 'CANCELLED'
                 ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
              ) AND (
                command.status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED', 'FAILED')
                OR (command.status = 'DONE' AND COALESCE(command.result_json->>'confirmed', 'false') <> 'true')
              )
            )
       ) AS exists`,
      tenantId,
      deviceId,
      excludeId ?? null,
    );
    return rows[0]?.exists === true;
  }

  async transition(tenantId: string, transition: CommandTransition, tx?: Tx): Promise<ControlCommand | null> {
    // 跃迁合法性按库内当前状态判定，调用方拿着陈旧记录也绕不过状态机；
    // 并发写入由 UPDATE 上的 version 条件拦住，跨租户按「不存在」处理，
    // 三种失败都收敛成 null（HTTP 侧分别回 409 / 409 / 404）。
    // 带 tx 时读写都走同一事务，状态与 outbox 事件要么同时成功要么同时回滚。
    const executor = tx ?? this.client;
    const current = await this.transitionMetadataOf(tenantId, transition.id, executor);
    if (current === null || !canTransition(current.status, transition.status)) return null;
    const fencedType = isJobCommandType(current.type) || current.type === "PAUSE" || current.type === "RESUME";
    const emergencyFence = fencedType && transition.status !== "FAILED" && transition.status !== "CANCELLED"
      ? `AND NOT EXISTS (
           SELECT 1 FROM control_commands AS safety
            WHERE safety.id = (
              SELECT latest.id FROM control_commands AS latest
               WHERE latest.tenant_id = control_commands.tenant_id AND latest.device_id = control_commands.device_id
                 AND latest.type IN ('ESTOP', 'POWER_OFF') AND latest.status <> 'CANCELLED'
               ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
            )
              AND (safety.finished_at IS NULL OR control_commands.created_at <= safety.finished_at
                OR (safety.status = 'DONE' AND COALESCE(safety.result_json->>'confirmed', 'false') <> 'true'))
         )`
      : "";
    const rows = await executor.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `UPDATE control_commands
          SET status = $4,
              version = version + 1,
              sent_at = CASE WHEN $4 = 'SENT' THEN $5::timestamptz ELSE sent_at END,
              acked_at = CASE WHEN $4 = 'ACKED' THEN $5::timestamptz ELSE acked_at END,
              paused_at = CASE WHEN $4 = 'PAUSED' THEN $5::timestamptz ELSE paused_at END,
              resumed_at = CASE WHEN $4 = 'PAUSED' THEN NULL WHEN $4 = 'ACKED' AND status = 'PAUSED' THEN $5::timestamptz ELSE resumed_at END,
              finished_at = CASE WHEN $4 IN ('DONE', 'FAILED', 'CANCELLED') THEN $5::timestamptz ELSE finished_at END,
              receipt_message = COALESCE($6::text, receipt_message),
              result_json = COALESCE($7::jsonb, result_json)
        WHERE tenant_id = $1 AND id = $2 AND version = $3
        ${emergencyFence}
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

  async transitionPair(
    tenantId: string,
    transition: CommandTransition,
    linked?: { id: string; status: ControlCommandStatus; version: number; at: string; message?: string },
    tx?: Tx,
  ): Promise<{ command: ControlCommand; linkedCommand?: ControlCommand } | null> {
    const apply = async (inner: Tx): Promise<{ command: ControlCommand; linkedCommand?: ControlCommand } | null> => {
      const command = await this.transition(tenantId, transition, inner);
      if (!command) return null;
      if (!linked) return { command };
      const linkedCommand = await this.transition(tenantId, linked, inner);
      if (!linkedCommand) throw new Error("联动指令状态已被其它回执推进，本次结单整体回滚");
      return { command, linkedCommand };
    };
    return tx ? apply(tx) : this.client.$transaction(apply);
  }

  private async transitionMetadataOf(
    tenantId: string,
    id: string,
    executor: PrismaClientLike | Tx = this.client,
  ): Promise<{ id: string; status: ControlCommandStatus; type: ControlCommandType; deviceId: string; createdAt: string } | null> {
    const rows = await executor.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT id, status, type, device_id, created_at FROM control_commands WHERE tenant_id = $1 AND id = $2",
      tenantId,
      id,
    );
    const row = rows[0];
    if (!row) return null;
    const status = String(row.status);
    return (CONTROL_STATUSES as readonly string[]).includes(status)
      ? { id: String(row.id), status: status as ControlCommandStatus, type: row.type as ControlCommandType, deviceId: String(row.device_id), createdAt: toIsoTimestamp(row.created_at) }
      : null;
  }

  async failActiveJobs(
    tenantId: string,
    deviceId: string,
    emergencyStopId: string,
    at: string,
    message: string,
    tx?: Tx,
  ): Promise<ControlCommand[]> {
    const executor = tx ?? this.client;
    const rows = await executor.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `UPDATE control_commands
          SET status = 'FAILED', version = version + 1, finished_at = $4::timestamptz, receipt_message = $5::text
        WHERE tenant_id = $1 AND device_id = $2 AND id <> $3
          AND type IN ('SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION', 'TOOL_SWITCH', 'RETURN_HOME', 'TILLAGE')
          AND status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED')
        RETURNING ${COLUMNS}`,
      tenantId,
      deviceId,
      emergencyStopId,
      at,
      message,
    );
    return rows.map(toRecord);
  }

  async listOverdue(timeoutMin: number, nowMs: number, limit: number, cursor?: OverdueCursor): Promise<ControlCommand[]> {
    // 判定时钟由调用方注入，测试与生产扫都按同一时刻；创建顺序游标保证等待急停的旧指令
    // 不会每轮占满同一批，后面的超时指令仍能轮到收口。
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS}
       FROM control_commands
       WHERE status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED')
         AND $3::timestamptz - ${overdueSinceSql()} > make_interval(mins => ${overdueThresholdSql("$1")})
         AND ($4::text IS NULL OR (created_at, id) > ($5::timestamptz, $4::text))
       ORDER BY created_at, id
       LIMIT $2`,
      timeoutMin,
      limit,
      new Date(nowMs).toISOString(),
      cursor?.id ?? null,
      cursor?.createdAt ?? null,
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

  async create(command: ControlCommand, _tx?: Tx): Promise<ControlCommand | null> {
    if (this.rows.some((row) => row.id === command.id)) return null;
    if (command.idempotencyKey !== undefined && this.rows.some((row) => row.tenantId === command.tenantId && row.idempotencyKey === command.idempotencyKey)) {
      return null;
    }
    if (isJobCommandType(command.type) && PENDING_STATUSES.includes(command.status)
      && this.rows.some((row) => row.tenantId === command.tenantId && row.deviceId === command.deviceId
        && isJobCommandType(row.type) && PENDING_STATUSES.includes(row.status))) {
      return null;
    }
    // 去重粒度与 SQL 侧部分唯一索引一致：（来源事件, 设备）——同一事件的多设备建单各留一条，
    // 重放同一事件对同一设备才被挡住
    if (command.sourceEventId !== undefined && this.rows.some((row) => row.sourceEventId === command.sourceEventId && row.deviceId === command.deviceId)) {
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
    delete record.pausedAt;
    delete record.resumedAt;
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
      .filter((row) => (query.dueOnly ? row.scheduledAt === undefined || Date.parse(row.scheduledAt) <= nowMs : true))
      .filter((row) => isOverdue(row, nowMs, query.pendingOverMin));
    // 排序与 SQL 侧一致（created_at/id 同向，默认 DESC）：内存里靠插入顺序，一旦有回填的
    // 历史指令就会翻页，同一页两套模式拿到不同的行。
    const rank = (left: ControlCommand, right: ControlCommand) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    const safetyRank = (left: ControlCommand, right: ControlCommand) => query.dueOnly
      ? Number(!["ESTOP", "POWER_OFF"].includes(left.type)) - Number(!["ESTOP", "POWER_OFF"].includes(right.type))
      : 0;
    filtered.sort((a, b) => safetyRank(a, b) || (query.ascending ? 1 : -1) * rank(a, b));
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size), filtered.length, query.page, query.size);
  }

  async find(tenantId: string, id: string, _tx?: Tx, _options?: { forUpdate?: boolean }): Promise<ControlCommand | null> {
    const row = this.rows.find((item) => item.tenantId === tenantId && item.id === id);
    return row ? structuredClone(row) : null;
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string, _tx?: Tx): Promise<ControlCommand | null> {
    const row = this.rows.find((item) => item.tenantId === tenantId && item.idempotencyKey === idempotencyKey);
    return row ? structuredClone(row) : null;
  }

  async hasActiveJob(tenantId: string, deviceId: string, excludeId?: string): Promise<boolean> {
    const activeJob = this.rows.some((row) => row.tenantId === tenantId
      && row.deviceId === deviceId
      && row.id !== excludeId
      && isJobCommandType(row.type)
      && PENDING_STATUSES.includes(row.status));
    if (activeJob) return true;
    const latestSafetyStop = this.rows
      .filter((row) => row.tenantId === tenantId && row.deviceId === deviceId
        && (row.type === "ESTOP" || row.type === "POWER_OFF")
        && row.status !== "CANCELLED")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1);
    return latestSafetyStop !== undefined
      && (PENDING_STATUSES.includes(latestSafetyStop.status)
        || latestSafetyStop.status === "FAILED"
        || (latestSafetyStop.status === "DONE" && latestSafetyStop.result?.confirmed !== true));
  }

  private emergencyOverlaps(row: ControlCommand): boolean {
    const createdAt = Date.parse(row.createdAt);
    const latestSafetyStop = this.rows
      .filter((safety) => safety.tenantId === row.tenantId
        && safety.deviceId === row.deviceId
        && safety.id !== row.id
        && (safety.type === "ESTOP" || safety.type === "POWER_OFF")
        && safety.status !== "CANCELLED")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .at(-1);
    return latestSafetyStop !== undefined
      && (latestSafetyStop.finishedAt === undefined
        || createdAt <= Date.parse(latestSafetyStop.finishedAt)
        || (latestSafetyStop.status === "DONE" && latestSafetyStop.result?.confirmed !== true));
  }

  private transitionAllowed(row: ControlCommand | undefined, transition: CommandTransition): row is ControlCommand {
    if (!row || row.version !== transition.version || !canTransition(row.status, transition.status)) return false;
    const fencedType = isJobCommandType(row.type) || row.type === "PAUSE" || row.type === "RESUME";
    return !fencedType || transition.status === "FAILED" || transition.status === "CANCELLED" || !this.emergencyOverlaps(row);
  }

  private applyTransition(row: ControlCommand, transition: CommandTransition): ControlCommand {
    const previousStatus = row.status;
    row.status = transition.status;
    row.version += 1;
    if (transition.status === "SENT") row.sentAt = transition.at;
    if (transition.status === "ACKED") {
      row.ackedAt = transition.at;
      if (previousStatus === "PAUSED") row.resumedAt = transition.at;
    }
    if (transition.status === "PAUSED") {
      row.pausedAt = transition.at;
      delete row.resumedAt;
    }
    if (transition.status === "DONE" || transition.status === "FAILED" || transition.status === "CANCELLED") row.finishedAt = transition.at;
    if (transition.message !== undefined) row.receiptMessage = transition.message;
    if (transition.result !== undefined) row.result = structuredClone(transition.result);
    return structuredClone(row);
  }

  async transition(tenantId: string, transition: CommandTransition, _tx?: Tx): Promise<ControlCommand | null> {
    const row = this.rows.find((item) => item.tenantId === tenantId && item.id === transition.id);
    return this.transitionAllowed(row, transition) ? this.applyTransition(row, transition) : null;
  }

  async transitionPair(
    tenantId: string,
    transition: CommandTransition,
    linked?: { id: string; status: ControlCommandStatus; version: number; at: string; message?: string },
    _tx?: Tx,
  ): Promise<{ command: ControlCommand; linkedCommand?: ControlCommand } | null> {
    const row = this.rows.find((item) => item.tenantId === tenantId && item.id === transition.id);
    const linkedRow = linked ? this.rows.find((item) => item.tenantId === tenantId && item.id === linked.id) : undefined;
    if (!this.transitionAllowed(row, transition)) return null;
    if (linked && !this.transitionAllowed(linkedRow, linked)) return null;
    const command = this.applyTransition(row, transition);
    const linkedCommand = linked && linkedRow ? this.applyTransition(linkedRow, linked) : undefined;
    return { command, ...(linkedCommand ? { linkedCommand } : {}) };
  }

  async failActiveJobs(
    tenantId: string,
    deviceId: string,
    emergencyStopId: string,
    at: string,
    message: string,
    _tx?: Tx,
  ): Promise<ControlCommand[]> {
    const failed = this.rows.filter((row) => row.tenantId === tenantId
      && row.deviceId === deviceId
      && row.id !== emergencyStopId
      && isJobCommandType(row.type)
      && PENDING_STATUSES.includes(row.status));
    for (const row of failed) {
      row.status = "FAILED";
      row.version += 1;
      row.finishedAt = at;
      row.receiptMessage = message;
    }
    return failed.map((row) => structuredClone(row));
  }

  async listOverdue(timeoutMin: number, nowMs: number, limit: number, cursor?: OverdueCursor): Promise<ControlCommand[]> {
    return this.rows
      .filter((row) => PENDING_STATUSES.includes(row.status))
      .filter((row) => isOverdue(row, nowMs, timeoutMin))
      .filter((row) => cursor === undefined || row.createdAt > cursor.createdAt || (row.createdAt === cursor.createdAt && row.id > cursor.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  /** 全部指令，供测试断言 */
  all(): ControlCommand[] {
    return [...this.rows];
  }
}
