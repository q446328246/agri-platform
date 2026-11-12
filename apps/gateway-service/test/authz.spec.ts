import { describe, expect, it, vi } from "vitest";
import { bearerToken, createGatewayAuthorizer, resolveRouteRule } from "../src/authz.js";

describe("网关路由鉴权策略", () => {
  it("登录与健康检查为公开路径，设备与算法回调走回调凭证", () => {
    expect(resolveRouteRule("GET", "/health")).toEqual({ kind: "public" });
    expect(resolveRouteRule("POST", "/api/v1/auth/login")).toEqual({ kind: "public" });
    expect(resolveRouteRule("POST", "/api/v1/telemetry/report")).toEqual({ kind: "callback", write: "telemetry:write" });
    // 虫情与视频 AI 识别由算法侧回调，凭设备凭证或用户写权限进入
    expect(resolveRouteRule("POST", "/api/v1/telemetry/pest-events")).toEqual({ kind: "callback", write: "telemetry:write" });
    expect(resolveRouteRule("POST", "/api/v1/video/ai-events")).toEqual({ kind: "callback", write: "device:control" });
    // 查询侧仍需权限，不能因上报公开而放开
    expect(resolveRouteRule("GET", "/api/v1/telemetry/pests")).toEqual({ kind: "permission", code: "telemetry:read" });
    expect(resolveRouteRule("GET", "/api/v1/video/ai-events")).toEqual({ kind: "permission", code: "device:read" });
  });

  it("个人信息、租户与权限目录只要求登录", () => {
    expect(resolveRouteRule("GET", "/api/v1/auth/userinfo")).toEqual({ kind: "session" });
    expect(resolveRouteRule("POST", "/api/v1/auth/logout")).toEqual({ kind: "session" });
    expect(resolveRouteRule("GET", "/api/v1/platform/tenant")).toEqual({ kind: "session" });
    expect(resolveRouteRule("GET", "/api/v1/platform/permissions")).toEqual({ kind: "session" });
    expect(resolveRouteRule("GET", "/api/v1/unknown")).toEqual({ kind: "session" });
  });

  it("业务路径按请求方法映射读写权限", () => {
    expect(resolveRouteRule("GET", "/api/v1/plots/")).toEqual({ kind: "permission", code: "plot:read" });
    expect(resolveRouteRule("POST", "/api/v1/plots")).toEqual({ kind: "permission", code: "plot:write" });
    expect(resolveRouteRule("DELETE", "/api/v1/farm-tasks/1")).toEqual({ kind: "permission", code: "operation:write" });
    // 片区随地块：列表需 plot:read，建档/划入地块需 plot:write
    expect(resolveRouteRule("GET", "/api/v1/zones/map")).toEqual({ kind: "permission", code: "plot:read" });
    expect(resolveRouteRule("POST", "/api/v1/zones/ZONE-01/plots")).toEqual({ kind: "permission", code: "plot:write" });
    expect(resolveRouteRule("POST", "/api/v1/control/commands")).toEqual({ kind: "permission", code: "device:control" });
    // 设备通道（领取下发与执行回执）按回调凭证放行，与遥测上报、视频 AI 回调同一套
    expect(resolveRouteRule("POST", "/api/v1/control/device/dispatch")).toEqual({ kind: "callback", write: "device:control" });
    expect(resolveRouteRule("POST", "/api/v1/control/device/receipt")).toEqual({ kind: "callback", write: "device:control" });
    // 文件随地块、视频随设备
    expect(resolveRouteRule("GET", "/api/v1/files/1/content")).toEqual({ kind: "permission", code: "plot:read" });
    expect(resolveRouteRule("POST", "/api/v1/video/cameras/camera-001/ptz")).toEqual({ kind: "permission", code: "device:control" });
    // 气象接口预设为只读；POST /sync-now 管理员强制同步需 weather:sync
    expect(resolveRouteRule("GET", "/api/v1/weather/forecast")).toEqual({ kind: "permission", code: "weather:read" });
    expect(resolveRouteRule("POST", "/api/v1/weather/sync-now")).toEqual({ kind: "permission", code: "weather:sync" });
  });

  it("账号、角色与审计使用各自独立权限", () => {
    expect(resolveRouteRule("GET", "/api/v1/auth/users")).toEqual({ kind: "permission", code: "system:user" });
    expect(resolveRouteRule("PUT", "/api/v1/platform/roles/role-admin")).toEqual({ kind: "permission", code: "system:role" });
    expect(resolveRouteRule("GET", "/api/v1/platform/audit-logs")).toEqual({ kind: "permission", code: "system:audit" });
  });

  it("剥离 Bearer 前缀", () => {
    expect(bearerToken("Bearer token-1")).toBe("token-1");
    expect(bearerToken("bearer  token-1 ")).toBe("token-1");
    expect(bearerToken("token-1")).toBe("token-1");
    expect(bearerToken(undefined)).toBe("");
  });
});

interface SessionFixture {
  userId: string;
  tenantId: string;
  username: string;
  name: string;
  roles: string[];
  permissions: string[];
}

const SESSIONS: Record<string, SessionFixture> = {
  "token-admin": { userId: "user-admin", tenantId: "tenant-demo", username: "admin", name: "系统管理员", roles: ["admin"], permissions: ["*"] },
  "token-agronomist": { userId: "user-agro", tenantId: "tenant-demo", username: "agronomist01", name: "张农技", roles: ["agronomist"], permissions: [] },
};

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ["*"],
  agronomist: ["plot:read", "telemetry:read"],
  operator: ["plot:read"],
  disabled: [],
};

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify({ code: status >= 400 ? `INTERNAL-${status}` : "OK", message: "", data, timestamp: Date.now() }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(overrides: { sessionStatus?: number; roleStatus?: number; sessions?: Record<string, SessionFixture>; tenantRoles?: Record<string, Record<string, string[]>> } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { token?: string; codes?: string[] };
    if (url.endsWith("/api/v1/internal/auth/session")) {
      if (overrides.sessionStatus) return jsonResponse(overrides.sessionStatus, null);
      const session = (overrides.sessions ?? SESSIONS)[body.token ?? ""];
      return session ? jsonResponse(200, session) : jsonResponse(401, null);
    }
    if (url.endsWith("/api/v1/internal/platform/role-permissions")) {
      if (overrides.roleStatus) return jsonResponse(overrides.roleStatus, null);
      const roles = overrides.tenantRoles ? overrides.tenantRoles[new Headers(init?.headers).get("x-tenant-id") ?? ""] ?? {} : ROLE_PERMISSIONS;
      const items = (body.codes ?? []).filter((code) => code in roles).map((code) => ({ code, permissions: roles[code] }));
      return jsonResponse(200, { items });
    }
    throw new Error(`未预期的内部调用：${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function authorizer(fetchImpl: typeof fetch) {
  return createGatewayAuthorizer({ authServiceUrl: "http://auth", platformServiceUrl: "http://platform", internalToken: "test-internal", fetchImpl });
}

describe("网关鉴权解析", () => {
  it("公开路径直接放行且不回查认证服务", async () => {
    const { fetchImpl, calls } = stubFetch();
    const result = await authorizer(fetchImpl).authorize({ method: "POST", pathname: "/api/v1/auth/login" });
    expect(result).toEqual({ allowed: true, session: null });
    expect(calls).toHaveLength(0);
  });

  it("缺少 token 或会话失效返回 401", async () => {
    const { fetchImpl } = stubFetch();
    const instance = authorizer(fetchImpl);
    expect(await instance.authorize({ method: "GET", pathname: "/api/v1/plots" })).toEqual({ allowed: false, status: 401, message: "未登录或登录已失效" });
    expect(await instance.authorize({ method: "GET", pathname: "/api/v1/plots", authorization: "Bearer token-missing" })).toEqual({ allowed: false, status: 401, message: "未登录或登录已失效" });
  });

  it("合并角色权限与会话权限后下发身份", async () => {
    const { fetchImpl } = stubFetch();
    const result = await authorizer(fetchImpl).authorize({ method: "GET", pathname: "/api/v1/plots", authorization: "Bearer token-agronomist" });
    expect(result).toEqual({
      allowed: true,
      session: { userId: "user-agro", tenantId: "tenant-demo", username: "agronomist01", name: "张农技", roles: ["agronomist"], permissions: ["plot:read", "telemetry:read"] },
    });
  });

  it("权限不足返回 403 并指出所需权限", async () => {
    const { fetchImpl } = stubFetch();
    expect(await authorizer(fetchImpl).authorize({ method: "POST", pathname: "/api/v1/plots", authorization: "Bearer token-agronomist" })).toEqual({
      allowed: false,
      status: 403,
      message: "无权限执行该操作（需要 plot:write）",
    });
  });

  it("短时缓存会话，避免每个请求都回查", async () => {
    const { fetchImpl, calls } = stubFetch();
    const instance = authorizer(fetchImpl);
    await instance.authorize({ method: "GET", pathname: "/api/v1/plots", authorization: "Bearer token-agronomist" });
    const second = await instance.authorize({ method: "GET", pathname: "/api/v1/telemetry/latest", authorization: "Bearer token-agronomist" });
    expect(second.allowed).toBe(true);
    // 一次会话解析 + 一次角色权限解析，第二次全部命中缓存
    expect(calls).toEqual(["http://auth/api/v1/internal/auth/session", "http://platform/api/v1/internal/platform/role-permissions"]);
  });

  it.each([["tenant-a", "tenant-b"], ["tenant-b", "tenant-a"]])("同名角色缓存按租户隔离：先 %s 后 %s", async (firstTenant, secondTenant) => {
    const sessions: Record<string, SessionFixture> = {};
    for (const tenantId of [firstTenant, secondTenant]) {
      for (const index of [1, 2]) sessions[`${tenantId}-${index}`] = { userId: `${tenantId}-${index}`, tenantId, username: "operator", name: "操作员", roles: ["operator"], permissions: [] };
    }
    const { fetchImpl, calls } = stubFetch({ sessions, tenantRoles: {
      "tenant-a": { operator: ["plot:read", "plot:write"] },
      "tenant-b": { operator: ["plot:read"] },
    } });
    const instance = authorizer(fetchImpl);
    // 使用不同 token 强制解析会话，验证的是角色缓存而非会话缓存。
    for (const index of [1, 2]) {
      for (const tenantId of [firstTenant, secondTenant]) {
        const authorization = `Bearer ${tenantId}-${index}`;
        const write = await instance.authorize({ method: "POST", pathname: "/api/v1/plots", authorization });
        expect(write).toMatchObject(tenantId === "tenant-a" ? { allowed: true, session: { tenantId, permissions: ["plot:read", "plot:write"] } } : { allowed: false, status: 403 });
        expect(await instance.authorize({ method: "GET", pathname: "/api/v1/plots", authorization })).toMatchObject({ allowed: true, session: { tenantId } });
      }
    }
    expect(calls.filter((url) => url.endsWith("/role-permissions"))).toHaveLength(2);
    const roleCalls = vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).endsWith("/role-permissions"));
    expect(roleCalls.map(([, init]) => new Headers(init?.headers).get("x-tenant-id"))).toEqual([firstTenant, secondTenant]);
    expect(roleCalls.every(([, init]) => new Headers(init?.headers).get("x-internal-token") === "test-internal")).toBe(true);
  });

  it("同租户同一角色集合排序后复用缓存，不改变会话角色顺序", async () => {
    const fixture = SESSIONS["token-agronomist"]!;
    const { fetchImpl, calls } = stubFetch({ sessions: {
      first: { ...fixture, roles: ["operator", "agronomist"] },
      second: { ...fixture, roles: ["agronomist", "operator"] },
    } });
    const instance = authorizer(fetchImpl);
    for (const [token, roles] of [["first", ["operator", "agronomist"]], ["second", ["agronomist", "operator"]]] as const) {
      expect(await instance.authorize({ method: "GET", pathname: "/api/v1/plots", authorization: `Bearer ${token}` })).toMatchObject({ allowed: true, session: { roles } });
    }
    expect(calls.filter((url) => url.endsWith("/role-permissions"))).toHaveLength(1);
  });

  it.each([
    ["tenant-a", ["operator", "writer"], "tenant-a", ["operator,writer"]],
    ["tenant-a,operator", ["writer"], "tenant-a", ["operator", "writer"]],
  ] as const)("租户与角色缓存键使用无歧义序列化：%s %s / %s %s", async (tenantA, rolesA, tenantB, rolesB) => {
    const fixture = SESSIONS["token-agronomist"]!;
    const { fetchImpl, calls } = stubFetch({ sessions: {
      first: { ...fixture, tenantId: tenantA, roles: [...rolesA] },
      second: { ...fixture, tenantId: tenantB, roles: [...rolesB] },
    } });
    const instance = authorizer(fetchImpl);
    for (const token of ["first", "second"]) {
      expect(await instance.authorize({ method: "GET", pathname: "/api/v1/auth/userinfo", authorization: `Bearer ${token}` })).toMatchObject({ allowed: true });
    }
    expect(calls.filter((url) => url.endsWith("/role-permissions"))).toHaveLength(2);
  });

  it("认证或角色服务异常返回 502", async () => {
    const { fetchImpl } = stubFetch({ sessionStatus: 500 });
    expect(await authorizer(fetchImpl).authorize({ method: "GET", pathname: "/api/v1/plots", authorization: "Bearer token-admin" })).toEqual({
      allowed: false,
      status: 502,
      message: "认证或角色服务不可用",
    });
  });
});

describe("设备/算法回调鉴权", () => {
  function callbackAuthorizer(fetchImpl: typeof fetch, deviceCallbackToken = "device-secret") {
    return createGatewayAuthorizer({ authServiceUrl: "http://auth", platformServiceUrl: "http://platform", internalToken: "test-internal", deviceCallbackToken, fetchImpl });
  }

  it("有效设备凭证直接放行且不回查认证服务", async () => {
    const { fetchImpl, calls } = stubFetch();
    for (const pathname of ["/api/v1/telemetry/report", "/api/v1/telemetry/pest-events", "/api/v1/video/ai-events"]) {
      expect(await callbackAuthorizer(fetchImpl).authorize({ method: "POST", pathname, deviceToken: "device-secret" })).toEqual({ allowed: true, session: null });
    }
    expect(calls).toHaveLength(0);
  });

  it("设备凭证错误返回 401，不回退用户身份", async () => {
    const { fetchImpl, calls } = stubFetch();
    const result = await callbackAuthorizer(fetchImpl).authorize({ method: "POST", pathname: "/api/v1/video/ai-events", authorization: "Bearer token-admin", deviceToken: "wrong-secret" });
    expect(result).toEqual({ allowed: false, status: 401, message: "设备回调凭证无效" });
    expect(calls).toHaveLength(0);
  });

  it("未配置凭证时设备通道关闭，用户写权限仍可人工上报", async () => {
    const { fetchImpl } = stubFetch();
    const instance = callbackAuthorizer(fetchImpl, "");
    expect(await instance.authorize({ method: "POST", pathname: "/api/v1/telemetry/pest-events", deviceToken: "device-secret" })).toEqual({ allowed: false, status: 401, message: "设备回调凭证无效" });
    expect(await instance.authorize({ method: "POST", pathname: "/api/v1/telemetry/pest-events", authorization: "Bearer token-admin" })).toMatchObject({ allowed: true, session: { userId: "user-admin" } });
  });

  it("无设备凭证时按用户写权限判定：只读角色被拒，管理员放行，匿名 401", async () => {
    const { fetchImpl } = stubFetch();
    const instance = callbackAuthorizer(fetchImpl);
    expect(await instance.authorize({ method: "POST", pathname: "/api/v1/telemetry/pest-events", authorization: "Bearer token-agronomist" })).toEqual({
      allowed: false,
      status: 403,
      message: "无权限执行该操作（需要 telemetry:write）",
    });
    expect(await instance.authorize({ method: "POST", pathname: "/api/v1/video/ai-events", authorization: "Bearer token-admin" })).toMatchObject({ allowed: true });
    expect(await instance.authorize({ method: "POST", pathname: "/api/v1/telemetry/report" })).toEqual({ allowed: false, status: 401, message: "未登录或登录已失效" });
  });
});
