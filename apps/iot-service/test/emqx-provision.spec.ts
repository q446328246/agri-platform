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

async function startEmqxStub() {
  const state = {
    dashboardPassword: "public",
    authenticatorCreated: false,
    sourceCreated: false,
    users: new Map<string, Record<string, unknown>>(),
    loginPasswords: [] as string[],
    acls: new Map<string, Record<string, unknown>>(),
    aclUpdates: [] as Record<string, unknown>[],
    authorizationSettings: undefined as Record<string, unknown> | undefined,
  };

  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    const method = request.method ?? "GET";
    const body = await readBody(request);
    const send = (status: number, payload?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    if (path === "/api/v5/login" && method === "POST") {
      state.loginPasswords.push(String(body.password));
      if (body.password !== state.dashboardPassword) return send(401, { message: "Wrong username or password" });
      return send(200, { token: "test-token" });
    }
    if (path === "/api/v5/users/admin/change_pwd" && method === "POST") {
      expect(body.old_pwd).toBe(state.dashboardPassword);
      state.dashboardPassword = String(body.new_pwd);
      return send(204);
    }
    if (path === "/api/v5/authentication" && method === "GET") {
      return send(200, state.authenticatorCreated ? [{ id: "authn-1", backend: "built_in_database", enable: true }] : []);
    }
    if (path === "/api/v5/authentication" && method === "POST") {
      state.authenticatorCreated = true;
      return send(201, { id: "authn-1", backend: "built_in_database", enable: true });
    }
    if (path === "/api/v5/authentication/authn-1/users" && method === "POST") {
      const user_id = String(body.user_id);
      if (state.users.has(user_id)) return send(409, { message: "Already exists" });
      state.users.set(user_id, body);
      return send(201, body);
    }
    if (path.startsWith("/api/v5/authentication/authn-1/users/") && method === "PUT") {
      state.users.set(decodeURIComponent(path.split("/").at(-1)!), body);
      return send(204);
    }
    if (path === "/api/v5/authorization/sources" && method === "GET") {
      return send(200, { sources: state.sourceCreated ? [{ type: "built_in_database", enable: true }] : [] });
    }
    if (path === "/api/v5/authorization/sources" && method === "POST") {
      state.sourceCreated = true;
      return send(201, { type: "built_in_database", enable: true });
    }
    if (path === "/api/v5/authorization/settings" && method === "GET") {
      return send(200, { no_match: "allow", deny_action: "disconnect" });
    }
    if (path === "/api/v5/authorization/settings" && method === "PUT") {
      state.authorizationSettings = body;
      return send(204);
    }
    if (path === "/api/v5/authorization/sources/built_in_database/rules/users" && method === "POST") {
      return send(409, { message: "ACL user already exists" });
    }
    if (path.startsWith("/api/v5/authorization/sources/built_in_database/rules/users/") && method === "PUT") {
      const username = decodeURIComponent(path.split("/").at(-1)!);
      state.acls.set(username, body);
      state.aclUpdates.push(body);
      return send(204);
    }
    if (path === "/api/v5/authorization/cache" && method === "DELETE") return send(204);
    return send(404, { message: `Unexpected ${method} ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function provisioningEnv(apiUrl: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    EMQX_API_URL: apiUrl,
    EMQX_DASHBOARD_USERNAME: "admin",
    EMQX_DASHBOARD_PASSWORD: "configured-dashboard-password",
    MQTT_USERNAME: "test-service",
    MQTT_PASSWORD: "test-service-password",
    MQTT_TOPIC_PREFIX: "agri",
    TENANT_ID: "tenant-test",
  };
  delete env.EMQX_DASHBOARD_LOGIN_PASSWORD;
  delete env.MQTT_DEVICES_JSON;
  delete env.MQTT_DEVICE_USERNAME;
  delete env.MQTT_DEVICE_PASSWORD;
  return { ...env, ...overrides };
}

function expectedDeviceAcl(deviceNo: string) {
  return {
    username: deviceNo,
    rules: [
      { action: "publish", permission: "allow", topic: `agri/tenant-test/${deviceNo}/telemetry` },
      { action: "publish", permission: "allow", topic: `agri/tenant-test/${deviceNo}/receipt` },
      { action: "subscribe", permission: "allow", topic: `agri/tenant-test/${deviceNo}/command` },
    ],
  };
}

describe("EMQX provisioning", () => {
  it("首次引导轮换默认口令，重复执行更新用户与 ACL", async () => {
    const stub = await startEmqxStub();
    const env = provisioningEnv(stub.url, {
      MQTT_DEVICE_USERNAME: "TEST-DEVICE",
      MQTT_DEVICE_PASSWORD: "test-device-password",
    });

    try {
      await execFileAsync(process.execPath, [scriptPath], { env, timeout: 10_000 });
      await execFileAsync(process.execPath, [scriptPath], { env, timeout: 10_000 });

      expect(stub.state.loginPasswords).toEqual(["configured-dashboard-password", "public", "configured-dashboard-password", "configured-dashboard-password"]);
      expect(stub.state.dashboardPassword).toBe("configured-dashboard-password");
      expect([...stub.state.users.keys()].sort()).toEqual(["TEST-DEVICE", "test-service"]);
      expect(stub.state.users.get("test-service")).toMatchObject({ password: "test-service-password", is_superuser: false });
      expect(stub.state.users.get("TEST-DEVICE")).toMatchObject({ password: "test-device-password", is_superuser: false });
      expect(stub.state.authorizationSettings).toMatchObject({ no_match: "deny", deny_action: "disconnect" });
      expect(stub.state.aclUpdates).toHaveLength(4);
      expect(stub.state.aclUpdates.slice(0, 2)).toEqual(stub.state.aclUpdates.slice(2));
      expect([...stub.state.acls.keys()].sort()).toEqual(["TEST-DEVICE", "test-service"]);
      expect(stub.state.acls.get("test-service")).toEqual({
        username: "test-service",
        rules: [
          { action: "subscribe", permission: "allow", topic: "agri/tenant-test/+/telemetry" },
          { action: "subscribe", permission: "allow", topic: "agri/tenant-test/+/receipt" },
          { action: "publish", permission: "allow", topic: "agri/tenant-test/+/command" },
        ],
      });
      expect(stub.state.acls.get("TEST-DEVICE")).toEqual(expectedDeviceAcl("TEST-DEVICE"));
    } finally {
      await stub.close();
    }
  });

  it("按设备清单创建多台设备账号并写入独立 ACL", async () => {
    const stub = await startEmqxStub();
    const env = provisioningEnv(stub.url, {
      MQTT_DEVICES_JSON: JSON.stringify([
        { deviceNo: "DZ-T-001", password: "tractor-password" },
        { deviceNo: "DZ-S-005", password: "soil-password" },
      ]),
    });

    try {
      await execFileAsync(process.execPath, [scriptPath], { env, timeout: 10_000 });
      await execFileAsync(process.execPath, [scriptPath], { env, timeout: 10_000 });

      expect([...stub.state.users.keys()].sort()).toEqual(["DZ-S-005", "DZ-T-001", "test-service"]);
      expect(stub.state.users.get("DZ-T-001")).toMatchObject({ password: "tractor-password", is_superuser: false });
      expect(stub.state.users.get("DZ-S-005")).toMatchObject({ password: "soil-password", is_superuser: false });
      expect(stub.state.aclUpdates).toHaveLength(6);
      expect(stub.state.aclUpdates.slice(0, 3)).toEqual(stub.state.aclUpdates.slice(3));
      expect(stub.state.acls.get("DZ-T-001")).toEqual(expectedDeviceAcl("DZ-T-001"));
      expect(stub.state.acls.get("DZ-S-005")).toEqual(expectedDeviceAcl("DZ-S-005"));
    } finally {
      await stub.close();
    }
  });

  it.each([
    ["not-json", "MQTT_DEVICES_JSON must be a valid JSON array"],
    ["[]", "MQTT_DEVICES_JSON must contain at least one device"],
    [JSON.stringify([{ deviceNo: "DZ-T-001" }]), "MQTT_DEVICES_JSON[0].password is required"],
    [JSON.stringify([{ deviceNo: "DZ-T-001", password: "one" }, { deviceNo: "DZ-T-001", password: "two" }]), "duplicate deviceNo DZ-T-001"],
    [JSON.stringify([{ deviceNo: "DZ/T-001", password: "one" }]), "deviceNo must not contain whitespace, /, + or #"],
    [JSON.stringify([{ deviceNo: "test-service", password: "one" }]), "must not use the service account"],
  ])("拒绝非法设备清单 %s", async (value, message) => {
    const env = provisioningEnv("http://127.0.0.1:1", { MQTT_DEVICES_JSON: value });
    await expect(execFileAsync(process.execPath, [scriptPath], { env, timeout: 10_000 })).rejects.toThrow(message);
  });
});
