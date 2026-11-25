import { setTimeout as delay } from "node:timers/promises";

const apiUrl = (process.env.EMQX_API_URL ?? "http://127.0.0.1:18083").replace(/\/$/, "");
const dashboardUsername = process.env.EMQX_DASHBOARD_USERNAME?.trim();
const dashboardPassword = process.env.EMQX_DASHBOARD_PASSWORD;
const dashboardLoginPassword = process.env.EMQX_DASHBOARD_LOGIN_PASSWORD ?? dashboardPassword;
const serviceUsername = process.env.MQTT_USERNAME?.trim();
const servicePassword = process.env.MQTT_PASSWORD;
const topicPrefix = process.env.MQTT_TOPIC_PREFIX?.trim() || "agri";
const tenantId = process.env.TENANT_ID?.trim() || "tenant-demo";

for (const [name, value] of Object.entries({
  EMQX_DASHBOARD_USERNAME: dashboardUsername,
  EMQX_DASHBOARD_PASSWORD: dashboardPassword,
  MQTT_USERNAME: serviceUsername,
  MQTT_PASSWORD: servicePassword,
})) {
  if (!value) throw new Error(`${name} is required`);
}
for (const [name, value] of Object.entries({ MQTT_USERNAME: serviceUsername, MQTT_TOPIC_PREFIX: topicPrefix, TENANT_ID: tenantId })) {
  if (/[+/#\s]/.test(value)) throw new Error(`${name} must not contain whitespace, /, + or #`);
}

function parseDeviceCredentials(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MQTT_DEVICES_JSON must be a valid JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("MQTT_DEVICES_JSON must contain at least one device");
  }

  const seen = new Set();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`MQTT_DEVICES_JSON[${index}] must be an object`);
    }
    const deviceNo = typeof entry.deviceNo === "string" ? entry.deviceNo.trim() : "";
    const password = typeof entry.password === "string" ? entry.password : "";
    if (!deviceNo) throw new Error(`MQTT_DEVICES_JSON[${index}].deviceNo is required`);
    if (!password) throw new Error(`MQTT_DEVICES_JSON[${index}].password is required`);
    if (/[+/#\s]/.test(deviceNo)) {
      throw new Error(`MQTT_DEVICES_JSON[${index}].deviceNo must not contain whitespace, /, + or #`);
    }
    if (deviceNo === serviceUsername) {
      throw new Error(`MQTT device ${deviceNo} must not use the service account`);
    }
    if (seen.has(deviceNo)) throw new Error(`MQTT_DEVICES_JSON contains duplicate deviceNo ${deviceNo}`);
    seen.add(deviceNo);
    return { deviceNo, password };
  });
}

const devices = process.env.MQTT_DEVICES_JSON?.trim()
  ? parseDeviceCredentials(process.env.MQTT_DEVICES_JSON)
  : (() => {
      const deviceNo = process.env.MQTT_DEVICE_USERNAME?.trim();
      const password = process.env.MQTT_DEVICE_PASSWORD;
      if (!deviceNo) throw new Error("MQTT_DEVICE_USERNAME is required when MQTT_DEVICES_JSON is not set");
      if (!password) throw new Error("MQTT_DEVICE_PASSWORD is required when MQTT_DEVICES_JSON is not set");
      if (/[+/#\s]/.test(deviceNo)) throw new Error("MQTT_DEVICE_USERNAME must not contain whitespace, /, + or #");
      if (deviceNo === serviceUsername) throw new Error(`MQTT device ${deviceNo} must not use the service account`);
      return [{ deviceNo, password }];
    })();

class EmqxApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${apiUrl}/api/v5${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new EmqxApiError(`${method} ${path} failed (${response.status}): ${payload?.message ?? response.statusText}`, response.status);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function login(password) {
  return request("/login", {
    method: "POST",
    body: { username: dashboardUsername, password },
  });
}

async function waitForDashboardLogin() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (true) {
    try {
      const result = await login(dashboardLoginPassword);
      return { ...result, loginPassword: dashboardLoginPassword };
    } catch (error) {
      lastError = error;
      // 首次启动使用出厂管理员口令，登录成功后立即轮换为本地配置。
      if (error instanceof EmqxApiError && error.status === 401 && dashboardUsername === "admin" && !process.env.EMQX_DASHBOARD_LOGIN_PASSWORD) {
        try {
          const result = await login("public");
          return { ...result, loginPassword: "public" };
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
      if (lastError instanceof EmqxApiError && [401, 403].includes(lastError.status)) throw lastError;
      if (Date.now() >= deadline) throw new Error(`EMQX Dashboard 未在 30 秒内就绪: ${lastError.message}`);
      await delay(250);
    }
  }
}

const loginResult = await waitForDashboardLogin();
if (!loginResult.token) throw new Error("EMQX login did not return a token");
let token = loginResult.token;

if (loginResult.loginPassword !== dashboardPassword) {
  await request(`/users/${encodeURIComponent(dashboardUsername)}/change_pwd`, {
    token,
    method: "POST",
    body: { old_pwd: loginResult.loginPassword, new_pwd: dashboardPassword },
  });
  const rotatedLogin = await login(dashboardPassword);
  if (!rotatedLogin.token) throw new Error("EMQX login after password rotation did not return a token");
  token = rotatedLogin.token;
}

const authentication = await request("/authentication", { token });
let authenticator = authentication.find((item) => item.backend === "built_in_database" && item.enable !== false);
if (!authenticator) {
  authenticator = await request("/authentication", {
    token,
    method: "POST",
    body: {
      enable: true,
      backend: "built_in_database",
      mechanism: "password_based",
      user_id_type: "username",
      password_hash_algorithm: { name: "sha256", salt_position: "suffix" },
    },
  });
}
if (!authenticator.id) throw new Error("EMQX built-in authentication has no id");
const authenticatorId = encodeURIComponent(authenticator.id);

const authenticatedUsers = [
  { username: serviceUsername, password: servicePassword },
  ...devices.map((device) => ({ username: device.deviceNo, password: device.password })),
];
for (const user of authenticatedUsers) {
  try {
    await request(`/authentication/${authenticatorId}/users`, {
      token,
      method: "POST",
      body: { user_id: user.username, password: user.password, is_superuser: false },
    });
  } catch (error) {
    if (!String(error).includes("(409)")) throw error;
    await request(`/authentication/${authenticatorId}/users/${encodeURIComponent(user.username)}`, {
      token,
      method: "PUT",
      body: { password: user.password, is_superuser: false },
    });
  }
}

const sourceResponse = await request("/authorization/sources", { token });
const sources = sourceResponse.sources ?? sourceResponse;
let source = sources.find((item) => item.type === "built_in_database" && item.enable !== false);
if (!source) {
  source = await request("/authorization/sources", {
    token,
    method: "POST",
    body: { type: "built_in_database", enable: true },
  });
}
const authorizationSettings = await request("/authorization/settings", { token });
await request("/authorization/settings", {
  token,
  method: "PUT",
  body: { ...authorizationSettings, no_match: "deny", deny_action: "disconnect" },
});
const aclUsers = [
  {
    username: serviceUsername,
    rules: [
      { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/telemetry` },
      { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/receipt` },
      { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/command` },
    ],
  },
  ...devices.map((device) => ({
    username: device.deviceNo,
    rules: [
      { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/${device.deviceNo}/telemetry` },
      { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/${device.deviceNo}/receipt` },
      { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/${device.deviceNo}/command` },
    ],
  })),
];
for (const user of aclUsers) {
  await request(`/authorization/sources/built_in_database/rules/users/${encodeURIComponent(user.username)}`, {
    token,
    method: "PUT",
    body: user,
  });
}
await request("/authorization/cache", { token, method: "DELETE" });
console.log(`EMQX authentication and ACLs provisioned for tenant ${tenantId} (${devices.length} devices)`);
