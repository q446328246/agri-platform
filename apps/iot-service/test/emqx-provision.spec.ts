import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../../../scripts/provision-emqx.mjs", import.meta.url));

async function readBody(request: NodeReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

type NodeReadableStream = NodeJS.ReadableStream & AsyncIterable<Buffer>;

describe("EMQX provisioning", () => {
  it("首次引导轮换默认口令，重复执行更新用户与 ACL", async () => {
    let dashboardPassword = "public";
    let authenticatorCreated = false;
    let sourceCreated = false;
    const users = new Map<string, Record<string, unknown>>();
    const loginPasswords: string[] = [];
    const acls = new Map<string, Record<string, unknown>>();
    const aclUpdates: Record<string, unknown>[] = [];
    let authorizationSettings: Record<string, unknown> | undefined;

    const server = createServer(async (request, response) => {
      const path = request.url ?? "";
      const method = request.method ?? "GET";
      const body = await readBody(request);
      const send = (status: number, payload?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(payload === undefined ? undefined : JSON.stringify(payload));
      };

      if (path === "/api/v5/login" && method === "POST") {
        loginPasswords.push(String(body.password));
        if (body.password !== dashboardPassword) return send(401, { message: "Wrong username or password" });
        return send(200, { token: "test-token" });
      }
      if (path === "/api/v5/users/admin/change_pwd" && method === "POST") {
        expect(body.old_pwd).toBe(dashboardPassword);
        dashboardPassword = String(body.new_pwd);
        return send(204);
      }
      if (path === "/api/v5/authentication" && method === "GET") {
        return send(200, authenticatorCreated ? [{ id: "authn-1", backend: "built_in_database", enable: true }] : []);
      }
      if (path === "/api/v5/authentication" && method === "POST") {
        authenticatorCreated = true;
        return send(201, { id: "authn-1", backend: "built_in_database", enable: true });
      }
      if (path === "/api/v5/authentication/authn-1/users" && method === "POST") {
        const user_id = String(body.user_id);
        if (users.has(user_id)) return send(409, { message: "Already exists" });
        users.set(user_id, body);
        return send(201, body);
      }
      if (path.startsWith("/api/v5/authentication/authn-1/users/") && method === "PUT") {
        users.set(decodeURIComponent(path.split("/").at(-1)!), body);
        return send(204);
      }
      if (path === "/api/v5/authorization/sources" && method === "GET") {
        return send(200, { sources: sourceCreated ? [{ type: "built_in_database", enable: true }] : [] });
      }
      if (path === "/api/v5/authorization/sources" && method === "POST") {
        sourceCreated = true;
        return send(201, { type: "built_in_database", enable: true });
      }
      if (path === "/api/v5/authorization/settings" && method === "GET") {
        return send(200, { no_match: "allow", deny_action: "disconnect" });
      }
      if (path === "/api/v5/authorization/settings" && method === "PUT") {
        authorizationSettings = body;
        return send(204);
      }
      if (path === "/api/v5/authorization/sources/built_in_database/rules/users" && method === "POST") {
        return send(409, { message: "ACL user already exists" });
      }
      if (path.startsWith("/api/v5/authorization/sources/built_in_database/rules/users/") && method === "PUT") {
        const username = decodeURIComponent(path.split("/").at(-1)!);
        acls.set(username, body);
        aclUpdates.push(body);
        return send(204);
      }
      if (path === "/api/v5/authorization/cache" && method === "DELETE") return send(204);
      return send(404, { message: `Unexpected ${method} ${path}` });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const env = {
      ...process.env,
      EMQX_API_URL: `http://127.0.0.1:${address.port}`,
      EMQX_DASHBOARD_USERNAME: "admin",
      EMQX_DASHBOARD_PASSWORD: "configured-dashboard-password",
      MQTT_USERNAME: "test-service",
      MQTT_PASSWORD: "test-service-password",
      MQTT_DEVICE_USERNAME: "TEST-DEVICE",
      MQTT_DEVICE_PASSWORD: "test-device-password",
      MQTT_TOPIC_PREFIX: "agri",
      TENANT_ID: "tenant-test",
    };
    delete env.EMQX_DASHBOARD_LOGIN_PASSWORD;

    try {
      await execFileAsync(process.execPath, [scriptPath], { env, timeout: 10_000 });
      await execFileAsync(process.execPath, [scriptPath], { env, timeout: 10_000 });

      expect(loginPasswords).toEqual(["configured-dashboard-password", "public", "configured-dashboard-password", "configured-dashboard-password"]);
      expect(dashboardPassword).toBe("configured-dashboard-password");
      expect([...users.keys()].sort()).toEqual(["TEST-DEVICE", "test-service"]);
      expect(users.get("test-service")).toMatchObject({ password: "test-service-password", is_superuser: false });
      expect(users.get("TEST-DEVICE")).toMatchObject({ password: "test-device-password", is_superuser: false });
      expect(authorizationSettings).toMatchObject({ no_match: "deny", deny_action: "disconnect" });
      expect(aclUpdates).toHaveLength(4);
      expect(aclUpdates.slice(0, 2)).toEqual(aclUpdates.slice(2));
      expect([...acls.keys()].sort()).toEqual(["TEST-DEVICE", "test-service"]);
      expect(acls.get("test-service")).toEqual({
        username: "test-service",
        rules: [
          { action: "subscribe", permission: "allow", topic: "agri/tenant-test/+/telemetry" },
          { action: "subscribe", permission: "allow", topic: "agri/tenant-test/+/receipt" },
          { action: "publish", permission: "allow", topic: "agri/tenant-test/+/command" },
        ],
      });
      expect(acls.get("TEST-DEVICE")).toEqual({
        username: "TEST-DEVICE",
        rules: [
          { action: "publish", permission: "allow", topic: "agri/tenant-test/TEST-DEVICE/telemetry" },
          { action: "publish", permission: "allow", topic: "agri/tenant-test/TEST-DEVICE/receipt" },
          { action: "subscribe", permission: "allow", topic: "agri/tenant-test/TEST-DEVICE/command" },
        ],
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
