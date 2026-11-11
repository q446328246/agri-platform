import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createPlatformHttpServer } from "../src/http.js";
import { InMemoryAuditRepository, InMemoryRoleRepository, seedRoles } from "../src/role.repository.js";

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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

describe("platform HTTP API 角色与权限", () => {
  it("权限目录按分组返回，内置角色可直接查询", async () => {
    const base = await start(createPlatformHttpServer());
    const catalog = await fetch(`${base}/api/v1/platform/permissions`);
    expect(catalog.status).toBe(200);
    const groups = (await catalog.json() as { data: Array<{ group: string; items: Array<{ code: string; name: string }> }> }).data;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.flatMap((group) => group.items.map((item) => item.code))).toContain("system:role");

    const roles = await fetch(`${base}/api/v1/platform/roles`);
    const page = (await roles.json() as { data: { items: Array<{ code: string; permissions: string[] }>; total: number } }).data;
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.items.find((role) => role.code === "admin")?.permissions).toEqual(["*"]);
  });

  it("新建角色、调整权限并留下审计记录", async () => {
    const base = await start(createPlatformHttpServer());
    const created = await post(base, "/api/v1/platform/roles", { name: "灌溉管理员", code: "irrigation-manager", description: "负责水肥策略", permissions: ["plot:read", "device:control"] }, { "x-user-id": "user-admin" });
    expect(created.status).toBe(201);
    const role = (await created.json() as { data: { id: string; code: string; permissions: string[]; status: string } }).data;
    expect(role).toMatchObject({ code: "irrigation-manager", permissions: ["plot:read", "device:control"], status: "ACTIVE" });

    const updated = await put(base, `/api/v1/platform/roles/${role.id}`, { name: "灌溉管理员", permissions: ["plot:read", "device:control", "telemetry:read"], status: "DISABLED" }, { "x-user-id": "user-admin" });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { permissions: string[]; status: string } }).data).toMatchObject({ status: "DISABLED" });

    const search = await fetch(`${base}/api/v1/platform/roles?keyword=irrigation`);
    expect((await search.json() as { data: { total: number } }).data.total).toBe(1);

    const audit = await fetch(`${base}/api/v1/platform/audit-logs?keyword=role.update`);
    const logs = (await audit.json() as { data: { total: number; items: Array<{ operator: string; action: string }> } }).data;
    expect(logs.total).toBe(1);
    expect(logs.items[0]).toMatchObject({ operator: "user-admin", action: "role.update" });

    const removed = await fetch(`${base}/api/v1/platform/roles/${role.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await (await fetch(`${base}/api/v1/platform/roles?keyword=irrigation`)).json() as { data: { total: number } }).data.total).toBe(0);
  });

  it("校验入参并保护内置管理员角色", async () => {
    const base = await start(createPlatformHttpServer());

    const unknownPermission = await post(base, "/api/v1/platform/roles", { name: "越权角色", code: "bad-role", permissions: ["plot:destroy"] });
    expect(unknownPermission.status).toBe(400);

    const duplicated = await post(base, "/api/v1/platform/roles", { name: "重复编码", code: "admin", permissions: ["plot:read"] });
    expect(duplicated.status).toBe(409);

    const protectedUpdate = await put(base, "/api/v1/platform/roles/role-admin", { permissions: ["plot:read"] });
    expect(protectedUpdate.status).toBe(400);

    const protectedDelete = await fetch(`${base}/api/v1/platform/roles/role-admin`, { method: "DELETE" });
    expect(protectedDelete.status).toBe(409);

    const missing = await fetch(`${base}/api/v1/platform/roles/role-404`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});

describe("platform 租户隔离", () => {
  it.each(["tenant-demo", undefined, "tenant-missing"])("租户资料 %s 只返回当前租户，未知租户404", async (tenantId) => {
    const base = await start(createPlatformHttpServer());
    const headers: Record<string, string> = tenantId ? { "x-tenant-id": tenantId } : {};
    const response = await fetch(`${base}/api/v1/platform/tenant`, { headers });
    expect(response.status).toBe(tenantId === "tenant-missing" ? 404 : 200);
    expect(await response.json()).toMatchObject(tenantId === "tenant-missing"
      ? { code: "PLATFORM-404", data: null }
      : { data: { id: "tenant-demo" } });
  });

  it.each([
    ["PUT", "tenant-a"], ["DELETE", "tenant-a"], ["PUT", undefined], ["DELETE", undefined],
  ] as const)("%s 跨租户角色在 %s 下返回404，不修改角色或生成审计", async (method, tenantId) => {
    const role = { ...seedRoles()[1]!, id: "role-tenant-b", tenantId: "tenant-b" };
    const roles = new InMemoryRoleRepository([role]);
    const audits = new InMemoryAuditRepository();
    const base = await start(createPlatformHttpServer({ roles, audits }));
    const headers: Record<string, string> = { "content-type": "application/json", ...(tenantId ? { "x-tenant-id": tenantId } : {}) };
    const denied = await fetch(`${base}/api/v1/platform/roles/${role.id}`, {
      method, headers, body: JSON.stringify({ tenantId: role.tenantId, name: "被篡改", permissions: ["plot:write"] }),
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ code: "PLATFORM-404", message: "角色不存在", data: null });
    expect(await roles.findById(role.id)).toEqual(role);
    expect(audits.all()).toEqual([]);
  });

  it("同租户角色可以更新和删除，审计归属该租户", async () => {
    const roles = new InMemoryRoleRepository(seedRoles().map((role) => ({ ...role, tenantId: "tenant-b" })));
    const audits = new InMemoryAuditRepository();
    const base = await start(createPlatformHttpServer({ roles, audits }));
    const headers = { "x-tenant-id": "tenant-b", "x-user-id": "user-b" };
    const updated = await put(base, "/api/v1/platform/roles/role-agronomist", { name: "本租户角色", permissions: ["plot:read"] }, headers);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ data: { tenantId: "tenant-b", name: "本租户角色", permissions: ["plot:read"] } });
    expect((await fetch(`${base}/api/v1/platform/roles/role-agronomist`, { method: "DELETE", headers })).status).toBe(200);
    expect(await roles.findById("role-agronomist")).toBeNull();
    expect(audits.all()).toEqual([
      expect.objectContaining({ tenantId: "tenant-b", operator: "user-b", action: "role.delete" }),
      expect.objectContaining({ tenantId: "tenant-b", operator: "user-b", action: "role.update" }),
    ]);
  });

  it("内部权限按可信租户解析同名角色，不返回其他租户权限", async () => {
    const roles = new InMemoryRoleRepository([
      { ...seedRoles()[1]!, id: "role-a", tenantId: "tenant-a", permissions: ["plot:write"] },
      { ...seedRoles()[1]!, id: "role-b", tenantId: "tenant-b", permissions: ["plot:read"] },
    ]);
    const base = await start(createPlatformHttpServer({ roles }));
    for (const [tenantId, permissions] of [["tenant-a", ["plot:write"]], ["tenant-b", ["plot:read"]], ["tenant-missing", []]] as const) {
      const resolved = await post(base, "/api/v1/internal/platform/role-permissions", { codes: ["agronomist"], tenantId: "tenant-a" }, { "x-internal-token": "agri-internal", "x-tenant-id": tenantId });
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({ data: { items: permissions.length ? [{ code: "agronomist", permissions }] : [] } });
    }
  });
});

describe("platform 内部角色权限接口", () => {
  it("按角色编码返回启用角色的权限，并忽略停用角色", async () => {
    const base = await start(createPlatformHttpServer());
    const created = await post(base, "/api/v1/platform/roles", { name: "停用角色", code: "paused-role", permissions: ["plot:read"], status: "DISABLED" }, { "x-user-id": "user-admin" });
    expect(created.status).toBe(201);

    const resolved = await post(
      base,
      "/api/v1/internal/platform/role-permissions",
      { codes: ["admin", "agronomist", "paused-role", "role-not-exist"] },
      { "x-internal-token": "agri-internal" },
    );
    expect(resolved.status).toBe(200);
    const items = (await resolved.json() as { data: { items: Array<{ code: string; permissions: string[] }> } }).data.items;
    expect(items).toEqual([
      { code: "admin", permissions: ["*"] },
      { code: "agronomist", permissions: ["dashboard:read", "plot:read", "telemetry:read", "telemetry:write", "weather:read", "decision:read", "message:read"] },
    ]);
    expect(items.some((item) => item.code === "paused-role")).toBe(false);
  });

  it("缺少内部凭证时拒绝", async () => {
    const base = await start(createPlatformHttpServer());
    const response = await post(base, "/api/v1/internal/platform/role-permissions", { codes: ["admin"] });
    expect(response.status).toBe(401);
    expect((await response.json() as { message: string }).message).toBe("内部接口凭证无效");
  });
});
