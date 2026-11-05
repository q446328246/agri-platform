import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";

import { hashPassword, InMemoryUserRepository, seedUsers, SqlUserRepository } from "../src/user.repository.js";
import type { UserRecord } from "../src/user.repository.js";

/**
 * 账号仓储测试：内存实现覆盖业务规则，SQL 实现固定「时间列转 ISO、角色单独查」
 * 这两个容易退化的约定（pg 驱动把 TIMESTAMPTZ 解析成 Date）。
 */

const row = {
  id: "user-1",
  tenant_id: "tenant-demo",
  username: "admin",
  password_hash: hashPassword("admin123"),
  name: "管理员",
  phone: "13800000000",
  direct_permissions: ["*"],
  status: "ACTIVE",
  created_at: new Date("2026-11-01T00:00:00.000Z"),
  updated_at: new Date("2026-11-02T00:00:00.000Z"),
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
      if (query.includes("auth_user_roles")) return [{ user_id: "user-1", role_code: "admin" }] as T;
      return [row] as T;
    },
    async $executeRawUnsafe(query: string): Promise<number> { queries.push(query); return 1; },
  };
  return { client, queries };
}

function newRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return { id: "user-2", tenantId: "tenant-demo", username: "agronomist01", passwordHash: hashPassword("123456"), name: "张农技", phone: "", roles: ["agronomist"], permissions: [], status: "ACTIVE", createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", ...overrides };
}

describe("内存账号仓储", () => {
  it("按租户/状态/关键词筛选并支持改密与删除", async () => {
    const repository = new InMemoryUserRepository(seedUsers());
    await repository.create(newRecord());
    await repository.create(newRecord({ id: "user-3", username: "operator01", name: "李操作", status: "DISABLED", roles: ["operator"] }));

    const disabled = await repository.page({ tenantId: "tenant-demo", status: "DISABLED", page: 1, size: 10 });
    expect(disabled.total).toBe(1);
    expect(disabled.items[0]?.username).toBe("operator01");

    const keyword = await repository.page({ keyword: "张农技", page: 1, size: 10 });
    expect(keyword.items.map((item) => item.username)).toEqual(["agronomist01"]);

    await repository.updatePassword("user-2", hashPassword("newpass123"), "2026-11-05T01:00:00.000Z");
    const updated = await repository.findById("user-2");
    expect(updated?.passwordHash).toBe(hashPassword("newpass123"));
    expect(updated?.updatedAt).toBe("2026-11-05T01:00:00.000Z");

    await repository.remove("user-2");
    expect(await repository.findById("user-2")).toBeNull();
  });

  it("内置账号重复写入时保持幂等", async () => {
    const repository = new InMemoryUserRepository(seedUsers());
    await repository.seed(seedUsers());
    const page = await repository.page({ page: 1, size: 10 });
    expect(page.total).toBe(1);
    expect(await repository.findByUsername("tenant-demo", "admin")).not.toBeNull();
    expect(await repository.findByUsername("tenant-other", "admin")).toBeNull();
  });
});

describe("SqlUserRepository", () => {
  it("分页映射角色与 ISO 时间，并按租户过滤", async () => {
    const fake = makeClient();
    const repository = new SqlUserRepository(fake.client);
    const page = await repository.page({ tenantId: "tenant-demo", page: 1, size: 10 });

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ username: "admin", roles: ["admin"], permissions: ["*"], createdAt: "2026-11-01T00:00:00.000Z" });
    expect(fake.queries[0]).toContain("tenant_id = $1");
    expect(fake.queries.some((query) => query.includes("FROM auth_user_roles"))).toBe(true);
  });

  it("建号在事务内先写账号再写角色关联", async () => {
    const fake = makeClient();
    const repository = new SqlUserRepository(fake.client);
    await repository.create(newRecord());

    const insertUser = fake.queries.findIndex((query) => query.includes("INSERT INTO auth_users"));
    const insertRole = fake.queries.findIndex((query) => query.includes("INSERT INTO auth_user_roles"));
    expect(insertUser).toBeGreaterThanOrEqual(0);
    expect(insertRole).toBeGreaterThan(insertUser);
  });

  it("改密与删除走参数化 SQL", async () => {
    const fake = makeClient();
    const repository = new SqlUserRepository(fake.client);
    await repository.updatePassword("user-1", hashPassword("newpass123"), "2026-11-05T01:00:00.000Z");
    await repository.remove("user-1");
    expect(fake.queries[0]).toContain("UPDATE auth_users SET password_hash");
    expect(fake.queries[1]).toContain("DELETE FROM auth_users");
  });
});
