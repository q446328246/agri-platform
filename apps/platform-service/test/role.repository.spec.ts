import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";

import { InMemoryAuditRepository, InMemoryRoleRepository, seedRoles, SqlAuditRepository, SqlRoleRepository } from "../src/role.repository.js";
import type { RoleRecord } from "../src/role.repository.js";

/**
 * 角色与审计仓储测试：内存实现覆盖业务规则，SQL 实现固定「权限码单独查」「时间列转 ISO」
 * 这两个与 pg 驱动行为相关的约定。
 */

const roleRow = {
  id: "role-1",
  tenant_id: "tenant-demo",
  name: "平台管理员",
  code: "admin",
  description: "内置角色",
  status: "ACTIVE",
  created_at: new Date("2026-11-01T00:00:00.000Z"),
  updated_at: new Date("2026-11-02T00:00:00.000Z"),
};

const auditRow = {
  id: "audit-1",
  tenant_id: "tenant-demo",
  action: "role.update",
  operator: "user-admin",
  resource: "role:role-1",
  detail: "更新角色",
  created_at: new Date("2026-11-05T00:00:00.000Z"),
};

function makeClient() {
  const queries: string[] = [];
  const client: PrismaClientLike = {
    async $connect() {},
    async $disconnect() {},
    async $transaction<R>(handler: (tx: Tx) => Promise<R>): Promise<R> { return handler(client as unknown as Tx); },
    async $queryRawUnsafe<T>(query: string): Promise<T> {
      queries.push(query);
      if (query.includes("COUNT(*)")) return [{ total: 1 }] as T;
      if (query.includes("platform_role_permissions")) return [{ role_id: "role-1", permission_code: "*" }] as T;
      if (query.includes("platform_audit_logs")) return [auditRow] as T;
      return [roleRow] as T;
    },
    async $executeRawUnsafe(query: string): Promise<number> { queries.push(query); return 1; },
  };
  return { client, queries };
}

function newRole(overrides: Partial<RoleRecord> = {}): RoleRecord {
  return { id: "role-9", tenantId: "tenant-demo", name: "灌溉管理员", code: "irrigation-manager", description: "", permissions: ["plot:read"], status: "ACTIVE", createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", ...overrides };
}

describe("内存角色仓储", () => {
  it("按编码判重、按关键词筛选并支持更新与删除", async () => {
    const repository = new InMemoryRoleRepository(seedRoles());
    await repository.create(newRole());

    expect((await repository.findByCode("tenant-demo", "irrigation-manager"))?.name).toBe("灌溉管理员");
    expect(await repository.findByCode("tenant-other", "irrigation-manager")).toBeNull();

    const searched = await repository.page({ keyword: "灌溉", page: 1, size: 10 });
    expect(searched.total).toBe(1);

    await repository.update({ ...newRole(), permissions: ["plot:read", "device:control"], status: "DISABLED" });
    expect((await repository.findById("role-9"))?.permissions).toEqual(["plot:read", "device:control"]);

    await repository.remove("role-9");
    expect(await repository.findById("role-9")).toBeNull();
  });
});

describe("SqlRoleRepository / SqlAuditRepository", () => {
  it("角色分页映射权限码与 ISO 时间", async () => {
    const fake = makeClient();
    const repository = new SqlRoleRepository(fake.client);
    const page = await repository.page({ tenantId: "tenant-demo", page: 1, size: 10 });

    expect(page.items[0]).toMatchObject({ code: "admin", permissions: ["*"], createdAt: "2026-11-01T00:00:00.000Z" });
    expect(fake.queries[0]).toContain("tenant_id = $1");
    expect(fake.queries.some((query) => query.includes("FROM platform_role_permissions"))).toBe(true);
  });

  it("建角色在事务内先写角色再写权限，删角色走参数化 SQL", async () => {
    const fake = makeClient();
    const repository = new SqlRoleRepository(fake.client);
    await repository.create(newRole());

    const insertRole = fake.queries.findIndex((query) => query.includes("INSERT INTO platform_roles"));
    const insertPermission = fake.queries.findIndex((query) => query.includes("INSERT INTO platform_role_permissions"));
    expect(insertRole).toBeGreaterThanOrEqual(0);
    expect(insertPermission).toBeGreaterThan(insertRole);

    await repository.remove("role-9");
    expect(fake.queries.at(-1)).toContain("DELETE FROM platform_roles");
  });

  it("审计日志写入与分页查询", async () => {
    const fake = makeClient();
    const repository = new SqlAuditRepository(fake.client);
    await repository.create({ id: "audit-2", tenantId: "tenant-demo", action: "role.create", operator: "user-admin", resource: "role:role-9", detail: "新建角色", createdAt: "2026-11-05T00:00:00.000Z" });
    expect(fake.queries[0]).toContain("INSERT INTO platform_audit_logs");

    const page = await repository.page({ tenantId: "tenant-demo", keyword: "role", page: 1, size: 10 });
    expect(page.items[0]).toMatchObject({ action: "role.update", createdAt: "2026-11-05T00:00:00.000Z" });
  });
});

describe("内存审计仓储", () => {
  it("按关键词过滤并保持最新在前", async () => {
    const repository = new InMemoryAuditRepository();
    await repository.create({ id: "audit-1", tenantId: "tenant-demo", action: "role.create", operator: "user-admin", resource: "role:1", detail: "新建角色", createdAt: "2026-11-05T00:00:00.000Z" });
    await repository.create({ id: "audit-2", tenantId: "tenant-demo", action: "role.delete", operator: "user-admin", resource: "role:2", detail: "删除角色", createdAt: "2026-11-05T01:00:00.000Z" });

    expect(repository.all()).toHaveLength(2);
    const page = await repository.page({ keyword: "delete", page: 1, size: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe("audit-2");
  });
});
