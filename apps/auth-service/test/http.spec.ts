import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createAuthHttpServer } from "../src/http.js";

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

async function put(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
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
