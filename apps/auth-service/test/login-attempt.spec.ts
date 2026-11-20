import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

import { createAuthHttpServer } from "../src/http.js";
import { InMemoryLoginAttemptRepository } from "../src/login-attempt.repository.js";
import type { LoginAttemptRecord, LoginAttemptRepository } from "../src/login-attempt.repository.js";
import { InMemoryUserRepository, seedUsers } from "../src/user.repository.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
  vi.restoreAllMocks();
});

/** 可控时钟的台账桩：find 返回固定的锁定状态，用于验证锁定期与到期放行 */
class StubAttempts implements LoginAttemptRepository {
  lockedUntil: string | undefined;
  clearCalls = 0;
  private record(lockedUntil?: string): LoginAttemptRecord {
    return {
      id: "attempt-1",
      tenantId: "tenant-demo",
      username: "admin",
      lastIp: "127.0.0.1",
      failCount: 5,
      lastAttemptAt: new Date().toISOString(),
      ...(lockedUntil !== undefined ? { lockedUntil } : {}),
    };
  }
  async find(): Promise<LoginAttemptRecord | null> {
    return this.lockedUntil !== undefined ? this.record(this.lockedUntil) : null;
  }
  async recordFailure(): Promise<LoginAttemptRecord> {
    return this.record(new Date(Date.now() + 900_000).toISOString());
  }
  async clear(): Promise<void> {
    this.clearCalls += 1;
    this.lockedUntil = undefined;
  }
}

describe("登录防暴破（F2）", () => {
  it("连续失败达阈值锁定账号，锁定期内正确口令也拒绝", async () => {
    const attempts = new InMemoryLoginAttemptRepository();
    const base = await start(createAuthHttpServer({ users: new InMemoryUserRepository(seedUsers()), attempts }));

    for (let i = 0; i < 4; i += 1) {
      const response = await post(base, "/api/v1/auth/login", { username: "admin", password: "wrong-pass" });
      expect(response.status).toBe(401);
    }
    // 第 5 次触发锁定，返回 423 并说明锁定时长
    const locked = await post(base, "/api/v1/auth/login", { username: "admin", password: "wrong-pass" });
    expect(locked.status).toBe(423);
    expect((await locked.json() as { message: string }).message).toContain("账号已锁定");

    // 锁定期内即便口令正确也拒绝
    const duringLock = await post(base, "/api/v1/auth/login", { username: "admin", password: "admin123" });
    expect(duringLock.status).toBe(423);
  });

  it("登录成功后清零失败台账，再次失败重新计数", async () => {
    const attempts = new InMemoryLoginAttemptRepository();
    const base = await start(createAuthHttpServer({ users: new InMemoryUserRepository(seedUsers()), attempts }));

    await post(base, "/api/v1/auth/login", { username: "admin", password: "wrong-pass" });
    await post(base, "/api/v1/auth/login", { username: "admin", password: "wrong-pass" });
    const ok = await post(base, "/api/v1/auth/login", { username: "admin", password: "admin123" });
    expect(ok.status).toBe(200);
    expect(await attempts.find("tenant-demo", "admin")).toBeNull();

    // 清零后重新从 1 计数，不会因历史失败直接锁定
    const again = await post(base, "/api/v1/auth/login", { username: "admin", password: "wrong-pass" });
    expect(again.status).toBe(401);
    expect((await attempts.find("tenant-demo", "admin"))?.failCount).toBe(1);
  });

  it("锁定到期后放行登录", async () => {
    const attempts = new StubAttempts();
    attempts.lockedUntil = new Date(Date.now() - 1000).toISOString();
    const base = await start(createAuthHttpServer({ users: new InMemoryUserRepository(seedUsers()), attempts }));

    const response = await post(base, "/api/v1/auth/login", { username: "admin", password: "admin123" });
    expect(response.status).toBe(200);
    expect(attempts.clearCalls).toBe(1);
  });

  it("登录成功与失败都上报审计，审计失败不影响登录", async () => {
    const attempts = new InMemoryLoginAttemptRepository();
    const audit = vi.fn(async () => { throw new Error("platform down"); });
    const base = await start(createAuthHttpServer({ users: new InMemoryUserRepository(seedUsers()), attempts, audit }));

    const failed = await post(base, "/api/v1/auth/login", { username: "admin", password: "wrong-pass" });
    expect(failed.status).toBe(401);
    const succeeded = await post(base, "/api/v1/auth/login", { username: "admin", password: "admin123" });
    expect(succeeded.status).toBe(200);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0]![0]).toMatchObject({ action: "auth.login.failed", operator: "admin" });
    expect(audit.mock.calls[1]![0]).toMatchObject({ action: "auth.login.succeeded", operator: "admin" });
  });
});

describe("口令复杂度（F2 等保基线）", () => {
  it("新建账号拒绝纯数字弱口令，缺省口令满足复杂度", async () => {
    const base = await start(createAuthHttpServer({ users: new InMemoryUserRepository(seedUsers()) }));

    const weak = await post(base, "/api/v1/auth/users", { username: "user-weak", name: "弱口令", password: "123456" });
    expect(weak.status).toBe(400);
    expect((await weak.json() as { message: string }).message).toContain("字母与数字");

    const defaulted = await post(base, "/api/v1/auth/users", { username: "user-default", name: "缺省口令" });
    expect(defaulted.status).toBe(201);

    const login = await post(base, "/api/v1/auth/login", { username: "user-default", password: "Aa123456" });
    expect(login.status).toBe(200);
  });

  it("重置口令同样执行复杂度校验", async () => {
    const users = new InMemoryUserRepository(seedUsers());
    const base = await start(createAuthHttpServer({ users }));
    const created = await post(base, "/api/v1/auth/users", { username: "user-reset", name: "重置", password: "Aa123456" });
    const id = (await created.json() as { data: { id: string } }).data.id;

    const weak = await post(base, `/api/v1/auth/users/${id}/password`, { password: "abcdef" });
    expect(weak.status).toBe(400);
    const strong = await post(base, `/api/v1/auth/users/${id}/password`, { password: "Newpass123" });
    expect(strong.status).toBe(200);
  });
});
