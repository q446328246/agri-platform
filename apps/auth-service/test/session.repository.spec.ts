import type { PrismaClientLike, Tx } from "@agri/db";
import { describe, expect, it } from "vitest";

import { createSessionToken, hashSessionToken, InMemorySessionRepository, SqlSessionRepository } from "../src/session.repository.js";
import type { SessionRecord } from "../src/session.repository.js";

/**
 * 会话仓储测试：内存实现覆盖过期/回收语义，SQL 实现固定
 * 「只存 token 散列」「过期判断下推 SQL」「时间列转 ISO」三个约定。
 */

function newRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = Date.now();
  return {
    token: createSessionToken(),
    userId: "user-1",
    tenantId: "tenant-demo",
    expiresAt: new Date(now + 7_200_000).toISOString(),
    createdAt: new Date(now).toISOString(),
    ...overrides,
  };
}

function makeClient() {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const row = {
    token_hash: hashSessionToken("stored"),
    user_id: "user-1",
    tenant_id: "tenant-demo",
    expires_at: new Date("2026-11-05T02:00:00.000Z"),
    created_at: new Date("2026-11-05T01:00:00.000Z"),
    refreshed_at: null,
  };
  const client: PrismaClientLike = {
    async $connect() {},
    async $disconnect() {},
    async $transaction<R>(handler: (tx: Tx) => Promise<R>): Promise<R> { return handler(client as unknown as Tx); },
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      queries.push(query);
      params.push(values);
      return (query.includes("SELECT") ? [row] : []) as T;
    },
    async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
      queries.push(query);
      params.push(values);
      return 1;
    },
  };
  return { client, queries, params };
}

describe("内存会话仓储", () => {
  it("创建后可读取，过期会话视为不存在", async () => {
    const repository = new InMemorySessionRepository();
    const valid = newRecord();
    const expired = newRecord({ expiresAt: new Date(Date.now() - 1_000).toISOString() });

    await repository.create(valid);
    await repository.create(expired);

    expect((await repository.find(valid.token))?.userId).toBe("user-1");
    expect(await repository.find(expired.token)).toBeNull();
  });

  it("续期延长有效期，按账号回收不影响其它账号", async () => {
    const repository = new InMemorySessionRepository();
    const mine = newRecord();
    const other = newRecord({ userId: "user-2" });
    await repository.create(mine);
    await repository.create(other);

    const next = new Date(Date.now() + 10_800_000).toISOString();
    expect(await repository.renew(mine.token, next)).toBe(true);
    expect((await repository.find(mine.token))?.expiresAt).toBe(next);
    expect(await repository.renew("not-exist", next)).toBe(false);

    await repository.removeByUser("user-1");
    expect(await repository.find(mine.token)).toBeNull();
    expect(await repository.find(other.token)).not.toBeNull();

    await repository.remove(other.token);
    expect(await repository.find(other.token)).toBeNull();
  });

  it("清理过期会话只删除已到期记录", async () => {
    const repository = new InMemorySessionRepository();
    const alive = newRecord();
    const dead = newRecord({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await repository.create(alive);
    await repository.create(dead);

    expect(await repository.prune(new Date().toISOString())).toBe(1);
    expect(await repository.find(alive.token)).not.toBeNull();
    expect(await repository.find(dead.token)).toBeNull();
  });
});

describe("SqlSessionRepository", () => {
  it("落库只写 token 散列，绝不写明文", async () => {
    const fake = makeClient();
    const repository = new SqlSessionRepository(fake.client);
    const record = newRecord();
    await repository.create(record);

    expect(fake.queries[0]).toContain("INSERT INTO auth_sessions");
    expect(fake.queries[0]).toContain("ON CONFLICT (token_hash)");
    expect(fake.params[0]?.[0]).toBe(hashSessionToken(record.token));
    expect(fake.params[0]?.includes(record.token)).toBe(false);
  });

  it("查询按散列命中并把时间列转成 ISO", async () => {
    const fake = makeClient();
    const repository = new SqlSessionRepository(fake.client);
    const session = await repository.find("stored");

    expect(fake.queries[0]).toContain("expires_at > now()");
    expect(fake.params[0]?.[0]).toBe(hashSessionToken("stored"));
    expect(session?.userId).toBe("user-1");
    expect(session?.expiresAt).toBe("2026-11-05T02:00:00.000Z");
    // 库里没有明文 token，不回填
    expect(session?.token).toBe("");
  });

  it("续期、回收与清理均走参数化 SQL", async () => {
    const fake = makeClient();
    const repository = new SqlSessionRepository(fake.client);
    const next = new Date(Date.now() + 3_600_000).toISOString();

    expect(await repository.renew("stored", next)).toBe(true);
    await repository.remove("stored");
    await repository.removeByUser("user-1");
    const pruned = await repository.prune(next);

    expect(fake.queries[0]).toContain("UPDATE auth_sessions SET expires_at");
    expect(fake.queries[1]).toContain("DELETE FROM auth_sessions WHERE token_hash");
    expect(fake.queries[2]).toContain("DELETE FROM auth_sessions WHERE user_id");
    expect(fake.queries[3]).toContain("DELETE FROM auth_sessions WHERE expires_at");
    expect(pruned).toBe(1);
  });
});
