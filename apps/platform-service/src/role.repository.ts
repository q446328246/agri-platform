import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 平台角色与审计日志仓储。
 *
 * 角色权限以权限码形式存放在 platform_role_permissions，权限目录本身仍在
 * 代码里维护（见 http.ts 的 permissionCatalog），数据库只存角色实际勾选项，
 * 避免目录变更时历史数据与代码不一致。
 */

export type RoleStatus = "ACTIVE" | "DISABLED";

/** 角色记录 */
export interface RoleRecord {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  description: string;
  permissions: string[];
  status: RoleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RoleQuery {
  tenantId?: string;
  keyword?: string;
  page: number;
  size: number;
}

export interface RoleRepository {
  page(query: RoleQuery): Promise<PageResult<RoleRecord>>;
  findById(id: string): Promise<RoleRecord | null>;
  findByCode(tenantId: string, code: string): Promise<RoleRecord | null>;
  create(record: RoleRecord): Promise<RoleRecord>;
  update(record: RoleRecord): Promise<RoleRecord>;
  remove(id: string): Promise<void>;
  /** 幂等写入内置角色，同租户同编码已存在时跳过 */
  seed(records: RoleRecord[]): Promise<void>;
}

/** 审计日志记录 */
export interface AuditRecord {
  id: string;
  tenantId: string;
  action: string;
  operator: string;
  resource: string;
  detail: string;
  createdAt: string;
}

export interface AuditQuery {
  tenantId?: string;
  keyword?: string;
  page: number;
  size: number;
}

export interface AuditRepository {
  page(query: AuditQuery): Promise<PageResult<AuditRecord>>;
  create(record: AuditRecord): Promise<AuditRecord>;
}

/** 内置角色：无数据库时的默认角色集 */
export function seedRoles(): RoleRecord[] {
  return [
    { id: "role-admin", tenantId: "tenant-demo", name: "平台管理员", code: "admin", description: "内置角色，拥有全部权限", permissions: ["*"], status: "ACTIVE", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
    { id: "role-agronomist", tenantId: "tenant-demo", name: "农技人员", code: "agronomist", description: "负责四情监控与农事决策", permissions: ["dashboard:read", "plot:read", "telemetry:read", "telemetry:write", "weather:read", "decision:read", "message:read"], status: "ACTIVE", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
    { id: "role-operator", tenantId: "tenant-demo", name: "农机操作员", code: "operator", description: "负责设备控制与农事执行", permissions: ["dashboard:read", "device:read", "device:control", "operation:read", "operation:write", "trace:read"], status: "ACTIVE", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
  ];
}

function toPage<T>(items: T[], total: number, page: number, size: number): PageResult<T> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

function toRole(row: Record<string, unknown>, permissions: string[] = []): RoleRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    code: String(row.code),
    description: String(row.description ?? ""),
    permissions,
    status: row.status === "DISABLED" ? "DISABLED" : "ACTIVE",
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

function toAudit(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    action: String(row.action),
    operator: String(row.operator),
    resource: String(row.resource),
    detail: String(row.detail ?? ""),
    createdAt: toIsoTimestamp(row.created_at),
  };
}

/** 内存实现：未接数据库的本地模式与测试使用 */
export class InMemoryRoleRepository implements RoleRepository {
  private readonly rows: RoleRecord[];

  constructor(seed: RoleRecord[] = []) {
    this.rows = seed.map((record) => ({ ...record, permissions: [...record.permissions] }));
  }

  async page(query: RoleQuery): Promise<PageResult<RoleRecord>> {
    const filtered = this.rows
      .filter((row) => (query.tenantId ? row.tenantId === query.tenantId : true))
      .filter((row) => (query.keyword ? row.name.includes(query.keyword) || row.code.includes(query.keyword) : true));
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size), filtered.length, query.page, query.size);
  }

  async findById(id: string): Promise<RoleRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findByCode(tenantId: string, code: string): Promise<RoleRecord | null> {
    return this.rows.find((row) => row.tenantId === tenantId && row.code === code) ?? null;
  }

  async create(record: RoleRecord): Promise<RoleRecord> {
    this.rows.push(record);
    return record;
  }

  async update(record: RoleRecord): Promise<RoleRecord> {
    const index = this.rows.findIndex((row) => row.id === record.id);
    if (index >= 0) this.rows[index] = record;
    return record;
  }

  async remove(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }

  async seed(records: RoleRecord[]): Promise<void> {
    for (const record of records) {
      if (!this.rows.some((row) => row.id === record.id)) this.rows.push({ ...record, permissions: [...record.permissions] });
    }
  }
}

/** PostgreSQL 实现，表结构由迁移 004 管理 */
export class SqlRoleRepository implements RoleRepository {
  constructor(private readonly client: PrismaClientLike) {}

  /** 批量补齐权限码，避免分页时逐条查询 */
  private async loadPermissions(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const rows = await this.client.$queryRawUnsafe<Array<{ role_id: string; permission_code: string }>>(
      "SELECT role_id, permission_code FROM platform_role_permissions WHERE role_id = ANY($1::text[]) ORDER BY permission_code",
      ids,
    );
    for (const row of rows) {
      const list = map.get(row.role_id) ?? [];
      list.push(row.permission_code);
      map.set(row.role_id, list);
    }
    return map;
  }

  async page(query: RoleQuery): Promise<PageResult<RoleRecord>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.tenantId) {
      values.push(query.tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (query.keyword) {
      values.push(`%${query.keyword}%`);
      conditions.push(`(name ILIKE $${values.length} OR code ILIKE $${values.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM platform_roles ${where}`, ...values);
    const total = Number(totalRows[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, tenant_id, name, code, description, status, created_at, updated_at
       FROM platform_roles ${where}
       ORDER BY created_at ASC, id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      ...values,
    );
    const permissions = await this.loadPermissions(rows.map((row) => String(row.id)));
    return toPage(rows.map((row) => toRole(row, permissions.get(String(row.id)) ?? [])), total, query.page, query.size);
  }

  async findById(id: string): Promise<RoleRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT id, tenant_id, name, code, description, status, created_at, updated_at FROM platform_roles WHERE id = $1 LIMIT 1",
      id,
    );
    const row = rows[0];
    if (!row) return null;
    const permissions = await this.loadPermissions([id]);
    return toRole(row, permissions.get(id) ?? []);
  }

  async findByCode(tenantId: string, code: string): Promise<RoleRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT id, tenant_id, name, code, description, status, created_at, updated_at FROM platform_roles WHERE tenant_id = $1 AND code = $2 LIMIT 1",
      tenantId,
      code,
    );
    const row = rows[0];
    if (!row) return null;
    const permissions = await this.loadPermissions([String(row.id)]);
    return toRole(row, permissions.get(String(row.id)) ?? []);
  }

  private async writePermissions(tx: Pick<Tx, "$executeRawUnsafe">, roleId: string, permissions: string[]): Promise<void> {
    await tx.$executeRawUnsafe("DELETE FROM platform_role_permissions WHERE role_id = $1", roleId);
    for (const code of permissions) {
      await tx.$executeRawUnsafe("INSERT INTO platform_role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING", roleId, code);
    }
  }

  async create(record: RoleRecord): Promise<RoleRecord> {
    await this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_roles (id, tenant_id, name, code, description, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        record.id,
        record.tenantId,
        record.name,
        record.code,
        record.description,
        record.status,
        record.createdAt,
        record.updatedAt,
      );
      await this.writePermissions(tx, record.id, record.permissions);
    });
    return record;
  }

  async update(record: RoleRecord): Promise<RoleRecord> {
    await this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "UPDATE platform_roles SET name = $2, description = $3, status = $4, updated_at = $5 WHERE id = $1",
        record.id,
        record.name,
        record.description,
        record.status,
        record.updatedAt,
      );
      await this.writePermissions(tx, record.id, record.permissions);
    });
    return record;
  }

  async remove(id: string): Promise<void> {
    // 权限关联由外键 ON DELETE CASCADE 一并清理
    await this.client.$executeRawUnsafe("DELETE FROM platform_roles WHERE id = $1", id);
  }

  async seed(records: RoleRecord[]): Promise<void> {
    for (const record of records) {
      const inserted = await this.client.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO platform_roles (id, tenant_id, name, code, description, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, code) DO NOTHING
         RETURNING id`,
        record.id,
        record.tenantId,
        record.name,
        record.code,
        record.description,
        record.status,
        record.createdAt,
        record.updatedAt,
      );
      if (inserted.length > 0) await this.writePermissions(this.client, record.id, record.permissions);
    }
  }
}

/** 审计日志内存实现 */
export class InMemoryAuditRepository implements AuditRepository {
  private readonly rows: AuditRecord[] = [];

  async page(query: AuditQuery): Promise<PageResult<AuditRecord>> {
    const filtered = this.rows
      .filter((row) => (query.tenantId ? row.tenantId === query.tenantId : true))
      .filter((row) => (query.keyword ? `${row.action}${row.operator}${row.resource}${row.detail}`.includes(query.keyword) : true));
    const start = (query.page - 1) * query.size;
    return toPage(filtered.slice(start, start + query.size), filtered.length, query.page, query.size);
  }

  async create(record: AuditRecord): Promise<AuditRecord> {
    this.rows.unshift(record);
    if (this.rows.length > 500) this.rows.length = 500;
    return record;
  }

  /** 全部记录，供测试断言 */
  all(): AuditRecord[] {
    return [...this.rows];
  }
}

/** 审计日志 PostgreSQL 实现 */
export class SqlAuditRepository implements AuditRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async page(query: AuditQuery): Promise<PageResult<AuditRecord>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.tenantId) {
      values.push(query.tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (query.keyword) {
      values.push(`%${query.keyword}%`);
      conditions.push(`(action ILIKE $${values.length} OR operator ILIKE $${values.length} OR resource ILIKE $${values.length} OR detail ILIKE $${values.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM platform_audit_logs ${where}`, ...values);
    const total = Number(totalRows[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, tenant_id, action, operator, resource, detail, created_at
       FROM platform_audit_logs ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      ...values,
    );
    return toPage(rows.map(toAudit), total, query.page, query.size);
  }

  async create(record: AuditRecord): Promise<AuditRecord> {
    await this.client.$executeRawUnsafe(
      "INSERT INTO platform_audit_logs (id, tenant_id, action, operator, resource, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      record.id,
      record.tenantId,
      record.action,
      record.operator,
      record.resource,
      record.detail,
      record.createdAt,
    );
    return record;
  }
}
