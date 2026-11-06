import type { PrismaClientLike, Tx } from "@agri/db";
import type { PageResult } from "@agri/contracts";

/**
 * 消息中心仓储。
 *
 * 消息有两条来源：业务服务直接调用接口写入，以及事件消费根据越限/处方事件
 * 自动生成。后者需要按来源事件去重，因此记录保留 source_event_id 并由
 * 数据库唯一约束兜住重复投递，消费侧的内存幂等失效时也不会写出两条。
 */

/** 消息类型：ALERT 告警待处置，NOTICE 通知仅提醒 */
export type MessageType = "ALERT" | "NOTICE";

/** 消息级别 */
export type MessageLevel = "INFO" | "WARNING" | "CRITICAL";

/** 消息记录 */
export interface MessageRecord {
  id: string;
  tenantId: string;
  type: MessageType;
  title: string;
  content: string;
  level: MessageLevel;
  read: boolean;
  createdAt: string;
  /** 关联地块编码，便于按地块过滤 */
  plotCode?: string;
  /** 来源事件标识，同一事件的重复投递只会生成一条消息 */
  sourceEventId?: string;
  /** 去重键，来自 @agri/contracts 消息模板；同租户内唯一，用于告警聚合 */
  dedupeKey?: string;
}

/** 消息查询条件 */
export interface MessageQuery {
  tenantId?: string;
  type?: MessageType;
  /** 告警级别筛选，缺省不过滤 */
  level?: MessageLevel;
  /** true 仅看已读，false 仅看未读，缺省不过滤 */
  read?: boolean;
  plotCode?: string;
  keyword?: string;
  /** 创建时间区间，由 HTTP 层扩展为完整 ISO 后传入 */
  from?: string;
  to?: string;
  page: number;
  size: number;
}

export interface MessageRepository {
  /** 写入消息；来源事件已存在时返回 null */
  create(input: MessageRecord): Promise<MessageRecord | null>;
  page(query: MessageQuery): Promise<PageResult<MessageRecord>>;
  findById(id: string, tenantId?: string): Promise<MessageRecord | null>;
  markRead(id: string, tenantId?: string): Promise<MessageRecord | null>;
  unreadCount(tenantId?: string): Promise<number>;
}

function toPage<T>(items: T[], total: number, page: number, size: number): PageResult<T> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

function toRecord(row: Record<string, unknown>): MessageRecord {
  const record: MessageRecord = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    type: row.type === "ALERT" ? "ALERT" : "NOTICE",
    title: String(row.title),
    content: String(row.content),
    level: row.level === "CRITICAL" ? "CRITICAL" : row.level === "WARNING" ? "WARNING" : "INFO",
    read: Boolean(row.is_read),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString(),
  };
  if (row.plot_code !== null && row.plot_code !== undefined) record.plotCode = String(row.plot_code);
  if (row.source_event_id !== null && row.source_event_id !== undefined) record.sourceEventId = String(row.source_event_id);
  if (row.dedupe_key !== null && row.dedupe_key !== undefined) record.dedupeKey = String(row.dedupe_key);
  return record;
}

/** PostgreSQL 实现，表结构由迁移 003 管理 */
export class SqlMessageRepository implements MessageRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(input: MessageRecord): Promise<MessageRecord | null> {
    // 唯一约束冲突说明同一事件已生成过消息，直接返回空表示无需重复写入
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO ops_messages (id, tenant_id, type, title, content, level, is_read, plot_code, source_event_id, dedupe_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id, tenant_id, type, title, content, level, is_read, plot_code, source_event_id, dedupe_key, created_at`,
      input.id,
      input.tenantId,
      input.type,
      input.title,
      input.content,
      input.level,
      input.plotCode ?? null,
      input.sourceEventId ?? null,
      input.dedupeKey ?? null,
      input.createdAt,
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async page(query: MessageQuery): Promise<PageResult<MessageRecord>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.tenantId !== undefined && query.tenantId !== "") {
      values.push(query.tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (query.type) {
      values.push(query.type);
      conditions.push(`type = $${values.length}`);
    }
    if (query.level) {
      values.push(query.level);
      conditions.push(`level = $${values.length}`);
    }
    if (query.from) {
      values.push(query.from);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      conditions.push(`created_at <= $${values.length}`);
    }
    if (query.read !== undefined) {
      conditions.push(`is_read = ${query.read ? "TRUE" : "FALSE"}`);
    }
    if (query.plotCode !== undefined && query.plotCode !== "") {
      values.push(query.plotCode);
      conditions.push(`plot_code = $${values.length}`);
    }
    if (query.keyword !== undefined && query.keyword !== "") {
      values.push(`%${query.keyword}%`);
      conditions.push(`(title ILIKE $${values.length} OR content ILIKE $${values.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM ops_messages ${where}`, ...values);
    const total = Number(totalRows[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, tenant_id, type, title, content, level, is_read, plot_code, source_event_id, dedupe_key, created_at
       FROM ops_messages ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      ...values,
    );
    return toPage(rows.map(toRecord), total, query.page, query.size);
  }

  async findById(id: string, tenantId?: string): Promise<MessageRecord | null> {
    const values: unknown[] = [id];
    let where = "id = $1";
    if (tenantId !== undefined && tenantId !== "") {
      values.push(tenantId);
      where += ` AND tenant_id = $${values.length}`;
    }
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, tenant_id, type, title, content, level, is_read, plot_code, source_event_id, dedupe_key, created_at
       FROM ops_messages WHERE ${where} LIMIT 1`,
      ...values,
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async markRead(id: string, tenantId?: string): Promise<MessageRecord | null> {
    const values: unknown[] = [id];
    let where = "id = $1";
    if (tenantId !== undefined && tenantId !== "") {
      values.push(tenantId);
      where += ` AND tenant_id = $${values.length}`;
    }
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `UPDATE ops_messages SET is_read = TRUE WHERE ${where}
       RETURNING id, tenant_id, type, title, content, level, is_read, plot_code, source_event_id, dedupe_key, created_at`,
      ...values,
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async unreadCount(tenantId?: string): Promise<number> {
    const values: unknown[] = [];
    let where = "is_read = FALSE";
    if (tenantId !== undefined && tenantId !== "") {
      values.push(tenantId);
      where += ` AND tenant_id = $${values.length}`;
    }
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM ops_messages WHERE ${where}`, ...values);
    return Number(rows[0]?.total ?? 0);
  }
}

/** 内存实现：未接入数据库的本地模式与测试使用 */
export class InMemoryMessageRepository implements MessageRepository {
  private readonly rows: MessageRecord[] = [];

  constructor(seed: MessageRecord[] = []) {
    this.rows.push(...seed);
  }

  async create(input: MessageRecord): Promise<MessageRecord | null> {
    if (input.sourceEventId !== undefined && this.rows.some((row) => row.sourceEventId === input.sourceEventId)) {
      return null;
    }
    if (input.dedupeKey !== undefined && this.rows.some((row) => row.dedupeKey === input.dedupeKey)) {
      return null;
    }
    const record: MessageRecord = { ...input };
    this.rows.unshift(record);
    return record;
  }

  async page(query: MessageQuery): Promise<PageResult<MessageRecord>> {
    const filtered = this.rows
      .filter((row) => (query.tenantId ? row.tenantId === query.tenantId : true))
      .filter((row) => (query.type ? row.type === query.type : true))
      .filter((row) => (query.level ? row.level === query.level : true))
      .filter((row) => (query.read === undefined ? true : row.read === query.read))
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .filter((row) => (query.keyword ? `${row.title}${row.content}`.includes(query.keyword) : true))
      .filter((row) => (query.from ? row.createdAt >= query.from : true))
      .filter((row) => (query.to ? row.createdAt <= query.to : true));
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size), filtered.length, query.page, query.size);
  }

  async findById(id: string, tenantId?: string): Promise<MessageRecord | null> {
    return this.rows.find((row) => row.id === id && (tenantId ? row.tenantId === tenantId : true)) ?? null;
  }

  async markRead(id: string, tenantId?: string): Promise<MessageRecord | null> {
    const row = this.rows.find((item) => item.id === id && (tenantId ? item.tenantId === tenantId : true));
    if (!row) return null;
    row.read = true;
    return row;
  }

  async unreadCount(tenantId?: string): Promise<number> {
    return this.rows.filter((row) => !row.read && (tenantId ? row.tenantId === tenantId : true)).length;
  }

  /** 全部消息，供测试断言 */
  all(): MessageRecord[] {
    return [...this.rows];
  }
}
