export interface MqttDeviceProvisioner {
  provision(input: { tenantId: string; deviceNo: string; username: string; password: string }): Promise<void>;
}

export interface EmqxDeviceProvisionerOptions {
  apiUrl?: string | undefined;
  dashboardUsername?: string | undefined;
  dashboardPassword?: string | undefined;
  topicPrefix?: string | undefined;
  serviceUsername?: string | undefined;
  servicePassword?: string | undefined;
  fetchImpl?: typeof fetch;
}

export class MqttProvisioningError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "MqttProvisioningError";
  }
}

class EmqxApiError extends Error {
  constructor(public readonly status: number, path: string) {
    super(`EMQX ${path} returned HTTP ${status}`);
  }
}

function topicPart(value: string, label: string): string {
  if (!value || /[+/#\s]/.test(value)) throw new MqttProvisioningError(`${label}不能包含空白、/、+ 或 #`, 400);
  return value;
}

function deviceRules(topicPrefix: string, tenantId: string, deviceNo: string) {
  return [
    { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/${deviceNo}/telemetry` },
    { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/${deviceNo}/receipt` },
    { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/${deviceNo}/command` },
  ];
}

function serviceRules(topicPrefix: string, tenantId: string) {
  return [
    { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/telemetry` },
    { action: "subscribe", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/receipt` },
    { action: "publish", permission: "allow", topic: `${topicPrefix}/${tenantId}/+/command` },
  ];
}

export function createEmqxDeviceProvisioner(options: EmqxDeviceProvisionerOptions = {}): MqttDeviceProvisioner {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function request(path: string, token: string | undefined, method = "GET", body?: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    let response: Response;
    try {
      response = await fetchImpl(`${options.apiUrl!.replace(/\/+$/, "")}/api/v5${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new MqttProvisioningError("无法连接 EMQX 管理接口");
    }
    if (!response.ok) throw new EmqxApiError(response.status, path);
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  async function ensureAuthenticator(token: string): Promise<string> {
    const payload = await request("/authentication", token);
    const items: any[] = Array.isArray(payload) ? payload : []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let authenticator = items.find((item) => item.backend === "built_in_database" && item.enable !== false);
    if (!authenticator) {
      try {
        authenticator = await request("/authentication", token, "POST", {
          enable: true,
          backend: "built_in_database",
          mechanism: "password_based",
          user_id_type: "username",
          password_hash_algorithm: { name: "sha256", salt_position: "suffix" },
        });
      } catch (error) {
        if (!(error instanceof EmqxApiError) || error.status !== 409) throw error;
        const retry = await request("/authentication", token);
        authenticator = (Array.isArray(retry) ? retry : []).find((item: any) => item.backend === "built_in_database" && item.enable !== false); // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    }
    if (!authenticator?.id) throw new MqttProvisioningError("EMQX 内置认证源不可用");
    return encodeURIComponent(String(authenticator.id));
  }

  async function upsertUser(token: string, authenticatorId: string, username: string, password: string): Promise<void> {
    try {
      await request(`/authentication/${authenticatorId}/users`, token, "POST", {
        user_id: username,
        password,
        is_superuser: false,
      });
    } catch (error) {
      if (!(error instanceof EmqxApiError) || error.status !== 409) throw error;
      await request(`/authentication/${authenticatorId}/users/${encodeURIComponent(username)}`, token, "PUT", {
        password,
        is_superuser: false,
      });
    }
  }

  async function ensureAuthorization(token: string): Promise<void> {
    const payload = await request("/authorization/sources", token);
    const sources: any[] = Array.isArray(payload) ? payload : payload?.sources ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const exists = sources.some((item) => item.type === "built_in_database" && item.enable !== false);
    if (!exists) {
      try {
        await request("/authorization/sources", token, "POST", { type: "built_in_database", enable: true });
      } catch (error) {
        if (!(error instanceof EmqxApiError) || error.status !== 409) throw error;
      }
    }
    const settings = await request("/authorization/settings", token);
    await request("/authorization/settings", token, "PUT", { ...settings, no_match: "deny", deny_action: "disconnect" });
  }

  async function putAcl(token: string, username: string, rules: unknown[]): Promise<void> {
    await request(`/authorization/sources/built_in_database/rules/users/${encodeURIComponent(username)}`, token, "PUT", {
      username,
      rules,
    });
  }

  return {
    async provision(input) {
      const apiUrl = options.apiUrl?.trim();
      const dashboardUsername = options.dashboardUsername?.trim();
      const dashboardPassword = options.dashboardPassword;
      if (!apiUrl || !dashboardUsername || !dashboardPassword) {
        throw new MqttProvisioningError("EMQX 测试开户未配置管理接口或管理员账号", 503);
      }
      const tenantId = topicPart(input.tenantId, "租户");
      const deviceNo = topicPart(input.deviceNo, "设备编号");
      const username = topicPart(input.username, "MQTT 账号");
      if (!input.password || input.password.length < 8) throw new MqttProvisioningError("MQTT 密码长度需为 8~128 个字符", 400);
      const serviceUsername = options.serviceUsername?.trim();
      if (serviceUsername && serviceUsername === username) throw new MqttProvisioningError("MQTT 设备账号不能与服务账号相同", 400);
      try {
        const login = await request("/login", undefined, "POST", { username: dashboardUsername, password: dashboardPassword });
        if (!login?.token) throw new MqttProvisioningError("EMQX 管理登录失败", 502);
        const token = String(login.token);
        const authenticatorId = await ensureAuthenticator(token);
        await ensureAuthorization(token);
        if (serviceUsername) {
          if (!options.servicePassword) throw new MqttProvisioningError("EMQX 测试开户缺少 MQTT 服务账号密码", 503);
          await upsertUser(token, authenticatorId, serviceUsername, options.servicePassword);
          await putAcl(token, serviceUsername, serviceRules(options.topicPrefix?.trim() || "agri", tenantId));
        }
        await upsertUser(token, authenticatorId, username, input.password);
        await putAcl(token, username, deviceRules(options.topicPrefix?.trim() || "agri", tenantId, deviceNo));
        await request("/authorization/cache", token, "DELETE");
      } catch (error) {
        if (error instanceof MqttProvisioningError) throw error;
        throw new MqttProvisioningError(error instanceof EmqxApiError ? `EMQX 测试开户失败（HTTP ${error.status}）` : "EMQX 测试开户失败");
      }
    },
  };
}

export function mqttProvisionerFromEnv(env: NodeJS.ProcessEnv = process.env): MqttDeviceProvisioner | undefined {
  const enabled = ["1", "true"].includes((env.IOT_MQTT_AUTO_PROVISION_TEST_ONLY ?? "").trim().toLowerCase());
  if (!enabled) return undefined;
  return createEmqxDeviceProvisioner({
    apiUrl: env.EMQX_API_URL,
    dashboardUsername: env.EMQX_DASHBOARD_USERNAME,
    dashboardPassword: env.EMQX_DASHBOARD_PASSWORD,
    topicPrefix: env.MQTT_TOPIC_PREFIX,
    serviceUsername: env.MQTT_USERNAME,
    servicePassword: env.MQTT_PASSWORD,
  });
}
