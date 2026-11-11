import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { createAuthHttpServer } from "../src/http.js";
import { InMemorySessionRepository } from "../src/session.repository.js";
import { InMemoryUserRepository, seedUsers, verifyPassword } from "../src/user.repository.js";
import type { UserRecord } from "../src/user.repository.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function put(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

beforeEach(() => {
  // 账号 HTTP 单测不访问外部平台服务，角色解析使用固定的空响应。
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input).endsWith("/api/v1/internal/platform/role-permissions")) {
      return Promise.resolve(new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }));
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
  vi.restoreAllMocks();
});

describe("auth HTTP API 用户管理", () => {
  it("新建、查询、更新、重置密码与删除用户", async () => {
    const base = await start(createAuthHttpServer());

    const created = await post(base, "/api/v1/auth/users", { username: "agronomist01", name: "张农技", phone: "13800000001", roles: ["agronomist"] });
    expect(created.status).toBe(201);
    const createdUser = (await created.json() as { data: { id: string; status: string; roles: string[]; username: string; password?: string } }).data;
    expect(createdUser).toMatchObject({ username: "agronomist01", status: "ACTIVE", roles: ["agronomist"] });
    expect(createdUser.password).toBeUndefined();

    const listed = await fetch(`${base}/api/v1/auth/users?keyword=agronomist01`);
    const page = (await listed.json() as { data: { total: number; items: Array<{ username: string; phone: string }> } }).data;
    expect(page.total).toBe(1);
    expect(page.items[0]?.phone).toBe("13800000001");

    const updated = await put(base, `/api/v1/auth/users/${createdUser.id}`, { name: "张农技（新）", roles: ["agronomist", "operator"], status: "DISABLED" });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { name: string; roles: string[]; status: string } }).data).toMatchObject({ name: "张农技（新）", roles: ["agronomist", "operator"], status: "DISABLED" });

    // 停用后不允许登录
    const denied = await post(base, "/api/v1/auth/login", { username: "agronomist01", password: "123456" });
    expect(denied.status).toBe(403);

    const reset = await post(base, `/api/v1/auth/users/${createdUser.id}/password`, { password: "newpass123" });
    expect(reset.status).toBe(200);
    // 启用后新密码可登录，旧密码失效
    expect((await put(base, `/api/v1/auth/users/${createdUser.id}`, { status: "ACTIVE" })).status).toBe(200);
    expect((await post(base, "/api/v1/auth/login", { username: "agronomist01", password: "newpass123" })).status).toBe(200);
    expect((await post(base, "/api/v1/auth/login", { username: "agronomist01", password: "123456" })).status).toBe(401);

    const removed = await fetch(`${base}/api/v1/auth/users/${createdUser.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const after = await fetch(`${base}/api/v1/auth/users?keyword=agronomist01`);
    expect((await after.json() as { data: { total: number } }).data.total).toBe(0);
  });

  it("拒绝重复用户名、非法入参与删除内置管理员", async () => {
    const base = await start(createAuthHttpServer());

    const invalid = await post(base, "/api/v1/auth/users", { username: "1abc", name: "非法用户名" });
    expect(invalid.status).toBe(400);

    const duplicated = await post(base, "/api/v1/auth/users", { username: "admin", name: "重复管理员" });
    expect(duplicated.status).toBe(409);

    const removed = await fetch(`${base}/api/v1/auth/users/user-admin`, { method: "DELETE" });
    expect(removed.status).toBe(409);

    const missing = await put(base, "/api/v1/auth/users/user-not-exist", { name: "不存在" });
    expect(missing.status).toBe(404);
  });

  it("管理接口不泄露密码字段", async () => {
    const base = await start(createAuthHttpServer());
    const listed = await fetch(`${base}/api/v1/auth/users`);
    const raw = await listed.text();
    expect(raw.includes("\"password\"")).toBe(false);
  });
});

function tenantUser(tenantId: string): UserRecord {
  return { ...seedUsers()[0]!, id: `user-${tenantId}`, tenantId, username: "tenantuser", name: tenantId };
}

async function addSession(sessions: InMemorySessionRepository, user: UserRecord): Promise<string> {
  const token = `token-${user.id}`;
  await sessions.create({ token, userId: user.id, tenantId: user.tenantId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return token;
}

describe("auth 用户管理租户隔离", () => {
  it.each(["tenant-a", undefined])("建号只使用可信租户 %s，明确拒绝跨租户请求体", async (headerTenant) => {
    const users = new InMemoryUserRepository();
    const base = await start(createAuthHttpServer({ users }));
    const headers: Record<string, string> = headerTenant ? { "x-tenant-id": headerTenant } : {};
    const tenantId = headerTenant ?? "tenant-demo";
    const body = { username: "tenantuser", name: "租户用户", tenantId: "tenant-b" };
    const denied = await post(base, "/api/v1/auth/users", body, headers);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "AUTH-403", data: null });
    expect((await users.page({ page: 1, size: 20 })).total).toBe(0);

    for (const input of [{ ...body, tenantId }, { username: "otheruser", name: "未指定租户" }]) {
      const created = await post(base, "/api/v1/auth/users", input, headers);
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ data: { tenantId, username: input.username } });
      expect(await users.findByUsername(tenantId, input.username)).not.toBeNull();
    }
    expect(await users.findByUsername("tenant-b", "tenantuser")).toBeNull();
  });

  it.each(["tenant-a", "tenant-b", undefined, "tenant-missing"])("列表限定租户 %s，查询参数不能覆盖范围", async (headerTenant) => {
    const users = new InMemoryUserRepository(["tenant-a", "tenant-b", "tenant-demo"].map(tenantUser));
    const base = await start(createAuthHttpServer({ users }));
    const headers: Record<string, string> = headerTenant ? { "x-tenant-id": headerTenant } : {};
    const tenantId = headerTenant ?? "tenant-demo";
    const listed = await fetch(`${base}/api/v1/auth/users?tenantId=tenant-b&keyword=tenantuser`, { headers });
    expect(listed.status).toBe(200);
    const page = (await listed.json() as { data: { total: number; items: UserRecord[] } }).data;
    expect(page.total).toBe(tenantId === "tenant-missing" ? 0 : 1);
    expect(page.items.map((user) => user.tenantId)).toEqual(tenantId === "tenant-missing" ? [] : [tenantId]);
    expect(page.items.every((user) => !("passwordHash" in user))).toBe(true);
  });

  it.each([
    ["PUT", "", "tenant-a"], ["DELETE", "", "tenant-a"], ["POST", "/password", "tenant-a"],
    ["PUT", "", undefined], ["DELETE", "", undefined], ["POST", "/password", undefined],
  ] as const)("%s 用户%s 在租户 %s 下返回404且不改数据或回收会话", async (method, suffix, headerTenant) => {
    const target = tenantUser("tenant-b");
    const own = tenantUser(headerTenant ?? "tenant-demo");
    const users = new InMemoryUserRepository([target, own]);
    const sessions = new InMemorySessionRepository();
    const targetToken = await addSession(sessions, target);
    const ownToken = await addSession(sessions, own);
    const targetSession = await sessions.find(targetToken);
    const mutations = [vi.spyOn(users, "update"), vi.spyOn(users, "remove"), vi.spyOn(users, "updatePassword"), vi.spyOn(sessions, "removeByUser")];
    const base = await start(createAuthHttpServer({ users, sessions }));
    const headers: Record<string, string> = { "content-type": "application/json", ...(headerTenant ? { "x-tenant-id": headerTenant } : {}) };
    const denied = await fetch(`${base}/api/v1/auth/users/${target.id}${suffix}`, {
      method, headers,
      body: JSON.stringify({ tenantId: target.tenantId, name: "被篡改", status: "DISABLED", password: "changed123" }),
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ code: "AUTH-404", message: "用户不存在", data: null });
    expect(await users.findById(target.id)).toEqual(target);
    expect(await sessions.find(targetToken)).toEqual(targetSession);
    expect(await sessions.find(ownToken)).not.toBeNull();
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  });

  it("同租户可更新、改密和删除，且仅回收目标用户会话", async () => {
    const target = tenantUser("tenant-b");
    const other = tenantUser("tenant-a");
    const users = new InMemoryUserRepository([target, other]);
    const sessions = new InMemorySessionRepository();
    const targetToken = await addSession(sessions, target);
    const otherToken = await addSession(sessions, other);
    const base = await start(createAuthHttpServer({ users, sessions }));
    const headers = { "x-tenant-id": target.tenantId };

    const updated = await put(base, `/api/v1/auth/users/${target.id}`, { name: "已更新", tenantId: other.tenantId }, headers);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ data: { name: "已更新", tenantId: target.tenantId } });
    expect(await sessions.find(targetToken)).not.toBeNull();
    expect((await post(base, `/api/v1/auth/users/${target.id}/password`, { password: "changed123" }, headers)).status).toBe(200);
    expect(verifyPassword("changed123", (await users.findById(target.id))!.passwordHash)).toBe(true);
    expect(await sessions.find(targetToken)).toBeNull();
    await addSession(sessions, target);
    expect((await fetch(`${base}/api/v1/auth/users/${target.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(await users.findById(target.id)).toBeNull();
    expect(await sessions.find(targetToken)).toBeNull();
    expect(await users.findById(other.id)).toEqual(other);
    expect(await sessions.find(otherToken)).not.toBeNull();
  });

  it("登录仍允许通过请求体选择租户", async () => {
    const user = tenantUser("tenant-b");
    const users = new InMemoryUserRepository([user]);
    const base = await start(createAuthHttpServer({ users }));
    const login = await post(base, "/api/v1/auth/login", { tenantId: user.tenantId, username: user.username, password: "admin123" }, { "x-tenant-id": "tenant-a" });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ data: { user: { id: user.id, tenantId: user.tenantId } } });
  });
});

describe("auth 内部会话接口", () => {
  it("凭内部凭证用 token 换取用户、角色与权限", async () => {
    const base = await start(createAuthHttpServer());
    const login = await post(base, "/api/v1/auth/login", { username: "admin", password: "admin123" });
    const token = (await login.json() as { data: { token: string } }).data.token;

    const resolved = await post(base, "/api/v1/internal/auth/session", { token }, { "x-internal-token": "agri-internal" });
    expect(resolved.status).toBe(200);
    const session = (await resolved.json() as { data: { userId: string; tenantId: string; roles: string[]; permissions: string[]; expiresAt: string } }).data;
    expect(session).toMatchObject({ userId: "user-admin", tenantId: "tenant-demo", roles: ["admin"], permissions: ["*"] });
    expect(Number.isNaN(Date.parse(session.expiresAt))).toBe(false);
  });

  it("内部凭证缺失或 token 失效时拒绝", async () => {
    const base = await start(createAuthHttpServer());
    const noToken = await post(base, "/api/v1/internal/auth/session", { token: "any" });
    expect(noToken.status).toBe(401);
    expect((await noToken.json() as { message: string }).message).toBe("内部接口凭证无效");

    const expired = await post(base, "/api/v1/internal/auth/session", { token: "not-exist" }, { "x-internal-token": "agri-internal" });
    expect(expired.status).toBe(401);
    expect((await expired.json() as { message: string }).message).toBe("登录已失效");
  });
});

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("auth 会话持久化与续期", () => {
  it("共享会话仓储时，服务重启后旧 token 仍可解析", async () => {
    const users = new InMemoryUserRepository(seedUsers());
    const sessions = new InMemorySessionRepository();
    const before = await start(createAuthHttpServer({ users, sessions }));

    const login = await post(before, "/api/v1/auth/login", { username: "admin", password: "admin123" });
    expect(login.status).toBe(200);
    const token = (await login.json() as { data: { token: string } }).data.token;

    // 第二个服务实例共享同一份存储：旧 token 不再依赖进程内的 Map
    const after = await start(createAuthHttpServer({ users, sessions }));
    const resolved = await post(after, "/api/v1/internal/auth/session", { token }, { "x-internal-token": "agri-internal" });
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as { data: { userId: string } }).data.userId).toBe("user-admin");

    const info = await fetch(`${after}/api/v1/auth/userinfo`, { headers: authHeaders(token) });
    expect(info.status).toBe(200);
  });

  it("refresh 沿用同一 token 续期，登出后立即失效", async () => {
    const base = await start(createAuthHttpServer());
    const login = await post(base, "/api/v1/auth/login", { username: "admin", password: "admin123" });
    const token = (await login.json() as { data: { token: string } }).data.token;

    const refreshed = await post(base, "/api/v1/auth/refresh", {}, authHeaders(token));
    expect(refreshed.status).toBe(200);
    const renewed = (await refreshed.json() as { data: { token: string; expiresIn: number } }).data;
    expect(renewed.token).toBe(token);
    expect(renewed.expiresIn).toBe(7200);

    // 缺少 token 时续期必须被拒绝
    expect((await post(base, "/api/v1/auth/refresh", {})).status).toBe(401);
    expect((await fetch(`${base}/api/v1/auth/userinfo`, { headers: authHeaders(token) })).status).toBe(200);

    expect((await post(base, "/api/v1/auth/logout", {}, authHeaders(token))).status).toBe(200);
    expect((await fetch(`${base}/api/v1/auth/userinfo`, { headers: authHeaders(token) })).status).toBe(401);
  });

  it("重置口令后该账号已发放的会话立即失效", async () => {
    const base = await start(createAuthHttpServer());
    const created = await post(base, "/api/v1/auth/users", { username: "sessionuser", name: "会话测试", password: "session123" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { data: { id: string } }).data.id;

    const login = await post(base, "/api/v1/auth/login", { username: "sessionuser", password: "session123" });
    const token = (await login.json() as { data: { token: string } }).data.token;
    expect((await fetch(`${base}/api/v1/auth/userinfo`, { headers: authHeaders(token) })).status).toBe(200);

    expect((await post(base, `/api/v1/auth/users/${id}/password`, { password: "session456" })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/auth/userinfo`, { headers: authHeaders(token) })).status).toBe(401);
    expect((await post(base, "/api/v1/auth/login", { username: "sessionuser", password: "session456" })).status).toBe(200);
  });

  it("旧 sha256 账号登录后就地升级为 scrypt 散列", async () => {
    const legacy = createHash("sha256").update("agri:legacy123").digest("hex");
    const users = new InMemoryUserRepository([{
      id: "user-legacy",
      tenantId: "tenant-demo",
      username: "legacy",
      passwordHash: legacy,
      name: "旧账号",
      phone: "",
      roles: [],
      permissions: [],
      status: "ACTIVE",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    }]);
    const base = await start(createAuthHttpServer({ users }));

    expect((await post(base, "/api/v1/auth/login", { username: "legacy", password: "wrong" })).status).toBe(401);
    expect((await post(base, "/api/v1/auth/login", { username: "legacy", password: "legacy123" })).status).toBe(200);

    const stored = await users.findById("user-legacy");
    expect(stored?.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("legacy123", stored?.passwordHash ?? "")).toBe(true);
  });
});
