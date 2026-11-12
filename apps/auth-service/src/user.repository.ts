import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { keywordHits, likePattern, toIsoTimestamp } from "@agri/shared";

import { hashPassword } from "./password.js";

/** 口令能力对外仍从账号仓储导出，调用方不必关心实现文件位置 */
export { hashPassword, needsRehash, verifyPassword } from "./password.js";

/**
 * 系统账号仓储。
 *
 * 账号是登录与系统管理的同一份数据，落库后由 auth_users 与 auth_user_roles
 * 两张表承载：账号属性在表上，角色只存角色编码，角色权限由 platform-service
 * 维护，避免两个服务各自定义一份权限清单。
 *
 * 口令散列由 `password.ts` 提供（scrypt + 随机盐）；内存实现保存与 SQL 相同的
 * 字符串形态，因此登录与改密逻辑在两种存储下完全一致。
 */

export type UserStatus = "ACTIVE" | "DISABLED";

/** 账号记录（含散列口令，仅仓储内部使用） */
export interface UserRecord {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  name: string;
  phone: string;
  roles: string[];
  /** 直接授予用户的权限，角色权限仍以 platform 角色为准 */
  permissions: string[];
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

/** 账号查询条件 */
export interface UserQuery {
  tenantId?: string;
  status?: UserStatus;
  keyword?: string;
  page: number;
  size: number;
}

export interface UserRepository {
  page(query: UserQuery): Promise<PageResult<UserRecord>>;
  findById(id: string): Promise<UserRecord | null>;
  findByUsername(tenantId: string, username: string): Promise<UserRecord | null>;
  create(record: UserRecord): Promise<UserRecord>;
  update(record: UserRecord): Promise<UserRecord>;
  updatePassword(id: string, passwordHash: string, updatedAt: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** 幂等写入初始账号，已存在同租户同名账号时跳过 */
  seed(records: UserRecord[]): Promise<void>;
}

/** 内置管理员账号：无数据库时用于本地演示与冒烟脚本 */
export function seedUsers(): UserRecord[] {
  return [{ id: "user-admin", tenantId: "tenant-demo", username: "admin", passwordHash: hashPassword("admin123"), name: "管理员", phone: "", roles: ["admin"], permissions: ["*"], status: "ACTIVE", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }];
}

function toPage<T>(items: T[], total: number, page: number, size: number): PageResult<T> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

function matchesKeyword(record: UserRecord, keyword?: string): boolean {
  if (!keyword) return true;
  // 与 SQL 的 `username ILIKE … OR name ILIKE … OR phone ILIKE …` 同口径：分字段、不分大小写
  return keywordHits(keyword, [record.username, record.name, record.phone]);
}

/** 内存实现：未接数据库的本地模式与测试使用 */
export class InMemoryUserRepository implements UserRepository {
  private readonly rows: UserRecord[];

  constructor(seed: UserRecord[] = []) {
    this.rows = seed.map((record) => ({ ...record, roles: [...record.roles], permissions: [...record.permissions] }));
  }

  async page(query: UserQuery): Promise<PageResult<UserRecord>> {
    const filtered = this.rows
      .filter((row) => (query.tenantId ? row.tenantId === query.tenantId : true))
      .filter((row) => (query.status ? row.status === query.status : true))
      .filter((row) => matchesKeyword(row, query.keyword));
    // SQL 出页按 created_at ASC, id ASC，内存按插入序会随建号顺序漂移，两套模式翻页结果不同
    filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size).map((row) => structuredClone(row)), filtered.length, query.page, query.size);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = this.rows.find((item) => item.id === id);
    return row ? structuredClone(row) : null;
  }

  async findByUsername(tenantId: string, username: string): Promise<UserRecord | null> {
    const row = this.rows.find((item) => item.tenantId === tenantId && item.username === username);
    return row ? structuredClone(row) : null;
  }

  async create(record: UserRecord): Promise<UserRecord> {
    const row = structuredClone(record);
    this.rows.push(row);
    return structuredClone(row);
  }

  async update(record: UserRecord): Promise<UserRecord> {
    const row = structuredClone(record);
    const index = this.rows.findIndex((item) => item.id === record.id);
    if (index >= 0) this.rows[index] = row;
    return structuredClone(row);
  }

  async updatePassword(id: string, passwordHash: string, updatedAt: string): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return;
    row.passwordHash = passwordHash;
    row.updatedAt = updatedAt;
  }

  async remove(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }

  async seed(records: UserRecord[]): Promise<void> {
    for (const record of records) {
      // 幂等键与 SQL 的 ON CONFLICT (tenant_id, username) 对齐：只按 id 判重的话，
      // 换一个 id 的同租户同名账号会在内存里重复入库，库里却被冲突挡掉。
      if (!this.rows.some((row) => row.tenantId === record.tenantId && row.username === record.username)) {
        this.rows.push(structuredClone(record));
      }
    }
  }
}

/** 权限列在库里是 JSONB，驱动可能返回已解析数组或字符串，这里统一成字符串数组 */
function toPermissions(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRecord(row: Record<string, unknown>, roles: string[] = []): UserRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    name: String(row.name),
    phone: String(row.phone ?? ""),
    roles,
    permissions: toPermissions(row.direct_permissions),
    status: row.status === "DISABLED" ? "DISABLED" : "ACTIVE",
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

const USER_COLUMNS = "id, tenant_id, username, password_hash, name, phone, direct_permissions, status, created_at, updated_at";

/** PostgreSQL 实现，表结构由迁移 004 管理 */
export class SqlUserRepository implements UserRepository {
  constructor(private readonly client: PrismaClientLike) {}

  /** 批量补齐角色：用户表与角色关联表分开查询，避免页内 N+1 */
  private async loadRoles(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const rows = await this.client.$queryRawUnsafe<Array<{ user_id: string; role_code: string }>>(
      "SELECT user_id, role_code FROM auth_user_roles WHERE user_id = ANY($1::text[]) ORDER BY role_code",
      ids,
    );
    for (const row of rows) {
      const list = map.get(row.user_id) ?? [];
      list.push(row.role_code);
      map.set(row.user_id, list);
    }
    return map;
  }

  async page(query: UserQuery): Promise<PageResult<UserRecord>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.tenantId) {
      values.push(query.tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    if (query.keyword) {
      values.push(likePattern(query.keyword));
      conditions.push(`(username ILIKE $${values.length} OR name ILIKE $${values.length} OR phone ILIKE $${values.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM auth_users ${where}`, ...values);
    const total = Number(totalRows[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${USER_COLUMNS} FROM auth_users ${where} ORDER BY created_at ASC, id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      ...values,
    );
    const roles = await this.loadRoles(rows.map((row) => String(row.id)));
    return toPage(rows.map((row) => toRecord(row, roles.get(String(row.id)) ?? [])), total, query.page, query.size);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE id = $1 LIMIT 1`, id);
    const row = rows[0];
    if (!row) return null;
    const roles = await this.loadRoles([id]);
    return toRecord(row, roles.get(id) ?? []);
  }

  async findByUsername(tenantId: string, username: string): Promise<UserRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${USER_COLUMNS} FROM auth_users WHERE tenant_id = $1 AND username = $2 LIMIT 1`,
      tenantId,
      username,
    );
    const row = rows[0];
    if (!row) return null;
    const roles = await this.loadRoles([String(row.id)]);
    return toRecord(row, roles.get(String(row.id)) ?? []);
  }

  /** 账号与角色关联同事务写入，避免只落一半 */
  private async writeRoles(tx: Pick<Tx, "$executeRawUnsafe">, userId: string, roles: string[]): Promise<void> {
    await tx.$executeRawUnsafe("DELETE FROM auth_user_roles WHERE user_id = $1", userId);
    for (const code of roles) {
      await tx.$executeRawUnsafe("INSERT INTO auth_user_roles (user_id, role_code) VALUES ($1, $2) ON CONFLICT DO NOTHING", userId, code);
    }
  }

  async create(record: UserRecord): Promise<UserRecord> {
    await this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO auth_users (id, tenant_id, username, password_hash, name, phone, direct_permissions, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        record.id,
        record.tenantId,
        record.username,
        record.passwordHash,
        record.name,
        record.phone,
        JSON.stringify(record.permissions),
        record.status,
        record.createdAt,
        record.updatedAt,
      );
      await this.writeRoles(tx, record.id, record.roles);
    });
    return record;
  }

  async update(record: UserRecord): Promise<UserRecord> {
    await this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "UPDATE auth_users SET name = $2, phone = $3, direct_permissions = $4::jsonb, status = $5, updated_at = $6 WHERE id = $1",
        record.id,
        record.name,
        record.phone,
        JSON.stringify(record.permissions),
        record.status,
        record.updatedAt,
      );
      await this.writeRoles(tx, record.id, record.roles);
    });
    return record;
  }

  async updatePassword(id: string, passwordHash: string, updatedAt: string): Promise<void> {
    await this.client.$executeRawUnsafe("UPDATE auth_users SET password_hash = $2, updated_at = $3 WHERE id = $1", id, passwordHash, updatedAt);
  }

  async remove(id: string): Promise<void> {
    // 角色关联由外键 ON DELETE CASCADE 一并清理
    await this.client.$executeRawUnsafe("DELETE FROM auth_users WHERE id = $1", id);
  }

  async seed(records: UserRecord[]): Promise<void> {
    for (const record of records) {
      const inserted = await this.client.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO auth_users (id, tenant_id, username, password_hash, name, phone, direct_permissions, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT (tenant_id, username) DO NOTHING
         RETURNING id`,
        record.id,
        record.tenantId,
        record.username,
        record.passwordHash,
        record.name,
        record.phone,
        JSON.stringify(record.permissions),
        record.status,
        record.createdAt,
        record.updatedAt,
      );
      if (inserted.length > 0) await this.writeRoles(this.client, record.id, record.roles);
    }
  }
}
