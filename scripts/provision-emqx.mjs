const apiUrl = (process.env.EMQX_API_URL ?? "http://127.0.0.1:18083").replace(/\/$/, "");
const dashboardUsername = process.env.EMQX_DASHBOARD_USERNAME?.trim();
const dashboardPassword = process.env.EMQX_DASHBOARD_PASSWORD;
const dashboardLoginPassword = process.env.EMQX_DASHBOARD_LOGIN_PASSWORD ?? dashboardPassword;
const serviceUsername = process.env.MQTT_USERNAME?.trim();
const servicePassword = process.env.MQTT_PASSWORD;
const deviceUsername = process.env.MQTT_DEVICE_USERNAME?.trim();
const devicePassword = process.env.MQTT_DEVICE_PASSWORD;
const topicPrefix = process.env.MQTT_TOPIC_PREFIX?.trim() || "agri";
const tenantId = process.env.TENANT_ID?.trim() || "tenant-demo";

for (const [name, value] of Object.entries({
  EMQX_DASHBOARD_USERNAME: dashboardUsername,
  EMQX_DASHBOARD_PASSWORD: dashboardPassword,
  MQTT_USERNAME: serviceUsername,
  MQTT_PASSWORD: servicePassword,
  MQTT_DEVICE_USERNAME: deviceUsername,
  MQTT_DEVICE_PASSWORD: devicePassword,
})) {
  if (!value) throw new Error(`${name} is required`);
}
for (const [name, value] of Object.entries({ MQTT_USERNAME: serviceUsername, MQTT_DEVICE_USERNAME: deviceUsername, MQTT_TOPIC_PREFIX: topicPrefix, TENANT_ID: tenantId })) {
  if (/[+/#\s]/.test(value)) throw new Error(`${name} must not contain whitespace, /, + or #`);
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
    throw new Error(`${method} ${path} failed (${response.status}): ${payload?.message ?? response.statusText}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

const login = await request("/login", {
  method: "POST",
  body: { username: dashboardUsername, password: dashboardLoginPassword },
});
if (!login.token) throw new Error("EMQX login did not return a token");
let token = login.token;

if (dashboardLoginPassword !== dashboardPassword) {
  await request(`/users/${encodeURIComponent(dashboardUsername)}/change_pwd`, {
    token,
    method: "POST",
    body: { old_pwd: dashboardLoginPassword, new_pwd: dashboardPassword },
  });
  const rotatedLogin = await request("/login", {
    method: "POST",
    body: { username: dashboardUsername, password: dashboardPassword },
  });
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

for (const [user_id, password] of [[serviceUsername, servicePassword], [deviceUsername, devicePassword]]) {
  try {
    await request(`/authentication/${authenticatorId}/users`, {
      token,
      method: "POST",
      body: { user_id, password, is_superuser: false },
    });
  } catch (error) {
    if (!String(error).includes("(409)")) throw error;
    await request(`/authentication/${authenticatorId}/users/${encodeURIComponent(user_id)}`, {
      token,
      method: "PUT",
      body: { password, is_superuser: false },
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
await request("/authorization/sources/built_in_database/rules/users", {
  token,
  method: "POST",
  body: [
    {
      username: serviceUsername,
      rules: [
        { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/telemetry` },
        { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/receipt` },
        { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/command` },
      ],
    },
    {
      username: deviceUsername,
      rules: [
        { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/${deviceUsername}/telemetry` },
        { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/${deviceUsername}/receipt` },
        { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/${deviceUsername}/command` },
      ],
    },
  ],
});
await request("/authorization/cache", { token, method: "DELETE" });
console.log(`EMQX authentication and ACLs provisioned for tenant ${tenantId}`);
