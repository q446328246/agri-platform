import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/** 登录尝试台账：按（租户, 用户名）累计连续失败与锁定状态（迁移 064） */
export interface LoginAttemptRecord {
  id: string;
  tenantId: string;
  username: string;
  /** 最近一次尝试来源地址 */
  lastIp: string;
  /** 连续失败次数，登录成功清零 */
  failCount: number;
  /** 锁定截止时间（ISO 8601 UTC），缺省表示未锁定 */
  lockedUntil?: string;
  lastAttemptAt: string;
}

export interface LoginAttemptInput {
  tenantId: string;
  username: string;
  lastIp: string;
}

export interface LoginAttemptRepository {
  find(tenantId: string, username: string): Promise<LoginAttemptRecord | null>;
  /**
   * 记录一次失败登录：连续次数 +1，达到阈值则写入锁定截止时间。
   * 返回更新后的台账，调用方据此判断是否触发锁定。
   */
  recordFailure(input: LoginAttemptInput, maxFailures: number, lockMinutes: number, now: Date): Promise<LoginAttemptRecord>;
  /** 登录成功后清零台账（失败次数与锁定一并清除） */
  clear(tenantId: string, username: string): Promise<void>;
}

function toRecord(row: Record<string, unknown>): LoginAttemptRecord {
  const record: LoginAttemptRecord = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    username: String(row.username),
    lastIp: String(row.last_ip ?? ""),
    failCount: Number(row.fail_count),
    lastAttemptAt: toIsoTimestamp(row.last_attempt_at),
  };
  if (row.locked_until !== null && row.locked_until !== undefined) record.lockedUntil = toIsoTimestamp(row.locked_until);
  return record;
}

/** 内存实现：仅供测试与降级路径，构造默认空库 */
export class InMemoryLoginAttemptRepository implements LoginAttemptRepository {
  private readonly rows = new Map<string, LoginAttemptRecord>();

  private key(tenantId: string, username: string): string {
    return `${tenantId}|${username}`;
  }

  async find(tenantId: string, username: string): Promise<LoginAttemptRecord | null> {
    const row = this.rows.get(this.key(tenantId, username));
    return row ? structuredClone(row) : null;
  }

  async recordFailure(input: LoginAttemptInput, maxFailures: number, lockMinutes: number, now: Date): Promise<LoginAttemptRecord> {
    const key = this.key(input.tenantId, input.username);
    const existing = this.rows.get(key);
    const failCount = (existing?.failCount ?? 0) + 1;
    const lockedUntil = failCount >= maxFailures ? new Date(now.getTime() + lockMinutes * 60_000).toISOString() : undefined;
    const record: LoginAttemptRecord = {
      id: existing?.id ?? ulid(),
      tenantId: input.tenantId,
      username: input.username,
      lastIp: input.lastIp,
      failCount,
      lastAttemptAt: now.toISOString(),
      ...(lockedUntil !== undefined ? { lockedUntil } : {}),
    };
    this.rows.set(key, structuredClone(record));
    return structuredClone(record);
  }

  async clear(tenantId: string, username: string): Promise<void> {
    this.rows.delete(this.key(tenantId, username));
  }
}

/** SQL 实现：迁移 064 的 auth_login_attempts，唯一键（租户, 用户名）保证并发下同一条台账 */
export class SqlLoginAttemptRepository implements LoginAttemptRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async find(tenantId: string, username: string): Promise<LoginAttemptRecord | null> {
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM auth_login_attempts WHERE tenant_id = $1 AND username = $2 LIMIT 1`,
      tenantId, username,
    ) as Record<string, unknown>[];
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async recordFailure(input: LoginAttemptInput, maxFailures: number, lockMinutes: number, now: Date): Promise<LoginAttemptRecord> {
    // 锁定截止时间在 JS 侧算好直接传入：避免 SQL 里用 make_interval 拼 timestamptz 的口径问题
    const lockedUntil = now.getTime() + lockMinutes * 60_000;
    const rows = await this.client.$queryRawUnsafe(
      `INSERT INTO auth_login_attempts (id, tenant_id, username, last_ip, fail_count, locked_until, last_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, CASE WHEN 1 >= $7 THEN $5::timestamptz ELSE NULL END, $6, $6, $6)
       ON CONFLICT (tenant_id, username) DO UPDATE SET
         last_ip = EXCLUDED.last_ip,
         fail_count = auth_login_attempts.fail_count + 1,
         locked_until = CASE
           WHEN auth_login_attempts.fail_count + 1 >= $7 THEN $5::timestamptz
           ELSE auth_login_attempts.locked_until
         END,
         last_attempt_at = EXCLUDED.last_attempt_at,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      ulid(), input.tenantId, input.username, input.lastIp,
      new Date(lockedUntil), now, maxFailures,
    ) as Record<string, unknown>[];
    return toRecord(rows[0]!);
  }

  async clear(tenantId: string, username: string): Promise<void> {
    await this.client.$queryRawUnsafe(
      `DELETE FROM auth_login_attempts WHERE tenant_id = $1 AND username = $2`,
      tenantId, username,
    );
  }
}
