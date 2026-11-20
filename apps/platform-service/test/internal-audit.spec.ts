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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

describe("平台内部审计端点（F2）", () => {
  it("内部凭证缺失拒绝，凭证有效时审计落库可查", async () => {
    const audits = new InMemoryAuditRepository();
    const base = await start(createPlatformHttpServer({ roles: new InMemoryRoleRepository(seedRoles()), audits }));

    const noToken = await post(base, "/api/v1/internal/platform/audit-logs", { action: "auth.login.failed", operator: "admin" });
    expect(noToken.status).toBe(401);

    const saved = await post(base, "/api/v1/internal/platform/audit-logs", {
      tenantId: "tenant-demo", action: "auth.login.failed", operator: "admin",
      resource: "user:admin", detail: "127.0.0.1，连续失败 5 次",
    }, { "x-internal-token": "agri-internal" });
    expect(saved.status).toBe(201);

    const logged = await fetch(`${base}/api/v1/platform/audit-logs`, { headers: { "x-user-id": "user-admin", "x-permissions": "system:audit" } });
    expect(logged.status).toBe(200);
    const page = (await logged.json() as { data: { items: Array<{ action: string; operator: string; detail: string }> } }).data;
    const hit = page.items.find((item) => item.action === "auth.login.failed");
    expect(hit).toMatchObject({ operator: "admin", detail: "127.0.0.1，连续失败 5 次" });
  });

  it("缺少 action 或 operator 返回 400", async () => {
    const base = await start(createPlatformHttpServer({ roles: new InMemoryRoleRepository(seedRoles()) }));

    const noAction = await post(base, "/api/v1/internal/platform/audit-logs", { operator: "admin" }, { "x-internal-token": "agri-internal" });
    expect(noAction.status).toBe(400);
    const noOperator = await post(base, "/api/v1/internal/platform/audit-logs", { action: "auth.login.succeeded" }, { "x-internal-token": "agri-internal" });
    expect(noOperator.status).toBe(400);
  });
});
