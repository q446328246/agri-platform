import { createHash, randomBytes } from "node:crypto";

import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 登录会话仓储。
 *
 * 会话是「token → 账号」的映射，落库后由 auth_sessions 承载。库里只保存
 * token 的散列（token 是高熵随机串，用 sha256 足够），即使库被读走也无法
 * 直接拿去调用接口；内存实现保留明文以便与 SQL 实现行为一致。
 *
 * 过期判断下推到 SQL（`expires_at > now()`）并在读取时兜底，
 * 进程重启后旧 token 依然可用，多实例部署也能共享同一份会话。
 */

export interface SessionRecord {
  /** 明文 token；SQL 实现不回填该字段，仅内存实现保留 */
  token: string;
  userId: string;
  tenantId: string;
  /** ISO 时间，跨存储统一为字符串，避免驱动返回 Date 造成的时区偏差 */
  expiresAt: string;
  createdAt: string;
  refreshedAt?: string;
}

export interface SessionRepository {
  create(record: SessionRecord): Promise<void>;
  /** 读取未过期会话；已过期视为不存在 */
  find(token: string): Promise<SessionRecord | null>;
  /** 滑动续期，返回是否命中有效会话 */
  renew(token: string, expiresAt: string): Promise<boolean>;
  remove(token: string): Promise<void>;
  /** 回收某账号的全部会话：删号、改密时调用 */
  removeByUser(userId: string): Promise<void>;
  /** 清理过期会话，返回清理条数 */
  prune(now: string): Promise<number>;
}

/** token 散列：带固定前缀，避免与其它用途的散列混用 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(`agri:session:${token}`).digest("hex");
}

/** 会话 token：32 字节随机数的十六进制形式，不可预测且无需签名 */
export function createSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function isExpired(record: SessionRecord, now: number): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= now;
}

/** 内存实现：无数据库的本地模式与单测使用 */
export class InMemorySessionRepository implements SessionRepository {
  private readonly rows = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> {
    this.rows.set(record.token, { ...record });
  }

  async find(token: string): Promise<SessionRecord | null> {
    const record = this.rows.get(token);
    if (!record) return null;
    if (isExpired(record, Date.now())) {
      this.rows.delete(token);
      return null;
    }
    return { ...record };
  }

  async renew(token: string, expiresAt: string): Promise<boolean> {
    const record = await this.find(token);
    if (!record) return false;
    this.rows.set(token, { ...record, expiresAt, refreshedAt: new Date().toISOString() });
    return true;
  }

  async remove(token: string): Promise<void> {
    this.rows.delete(token);
  }

  async removeByUser(userId: string): Promise<void> {
    for (const [token, record] of this.rows) if (record.userId === userId) this.rows.delete(token);
  }

  async prune(now: string): Promise<number> {
    const deadline = Date.parse(now);
    let removed = 0;
    for (const [token, record] of this.rows) {
      if (isExpired(record, Number.isNaN(deadline) ? Date.now() : deadline)) {
        this.rows.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

const SESSION_COLUMNS = "token_hash, user_id, tenant_id, expires_at, created_at, refreshed_at";

function toRecord(row: Record<string, unknown>): SessionRecord {
  return {
    // 库里没有明文 token，调用方只使用 userId/expiresAt
    token: "",
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    expiresAt: toIsoTimestamp(row.expires_at),
    createdAt: toIsoTimestamp(row.created_at),
    ...(row.refreshed_at ? { refreshedAt: toIsoTimestamp(row.refreshed_at) } : {}),
  };
}

/** PostgreSQL 实现，表结构由迁移 007 管理 */
export class SqlSessionRepository implements SessionRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async create(record: SessionRecord): Promise<void> {
    await this.client.$executeRawUnsafe(
      `INSERT INTO auth_sessions (token_hash, user_id, tenant_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at, refreshed_at = now()`,
      hashSessionToken(record.token),
      record.userId,
      record.tenantId,
      record.expiresAt,
      record.createdAt,
    );
  }

  async find(token: string): Promise<SessionRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${SESSION_COLUMNS} FROM auth_sessions WHERE token_hash = $1 AND expires_at > now() LIMIT 1`,
      hashSessionToken(token),
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async renew(token: string, expiresAt: string): Promise<boolean> {
    const affected = await this.client.$executeRawUnsafe(
      "UPDATE auth_sessions SET expires_at = $2, refreshed_at = now() WHERE token_hash = $1 AND expires_at > now()",
      hashSessionToken(token),
      expiresAt,
    );
    return affected > 0;
  }

  async remove(token: string): Promise<void> {
    await this.client.$executeRawUnsafe("DELETE FROM auth_sessions WHERE token_hash = $1", hashSessionToken(token));
  }

  async removeByUser(userId: string): Promise<void> {
    await this.client.$executeRawUnsafe("DELETE FROM auth_sessions WHERE user_id = $1", userId);
  }

  async prune(now: string): Promise<number> {
    return this.client.$executeRawUnsafe("DELETE FROM auth_sessions WHERE expires_at <= $1", now);
  }
}
