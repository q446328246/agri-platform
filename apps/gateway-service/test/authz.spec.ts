import { describe, expect, it, vi } from "vitest";
import { bearerToken, createGatewayAuthorizer, resolveRouteRule } from "../src/authz.js";

describe("网关路由鉴权策略", () => {
  it("登录、设备上报与健康检查为公开路径", () => {
    expect(resolveRouteRule("GET", "/health")).toEqual({ kind: "public" });
    expect(resolveRouteRule("POST", "/api/v1/auth/login")).toEqual({ kind: "public" });
    expect(resolveRouteRule("POST", "/api/v1/telemetry/report")).toEqual({ kind: "public" });
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
    expect(resolveRouteRule("POST", "/api/v1/control/commands")).toEqual({ kind: "permission", code: "device:control" });
    // 文件随地块、视频随设备
    expect(resolveRouteRule("GET", "/api/v1/files/1/content")).toEqual({ kind: "permission", code: "plot:read" });
    expect(resolveRouteRule("POST", "/api/v1/video/cameras/camera-001/ptz")).toEqual({ kind: "permission", code: "device:control" });
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

function stubFetch(overrides: { sessionStatus?: number; roleStatus?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { token?: string; codes?: string[] };
    if (url.endsWith("/api/v1/internal/auth/session")) {
      if (overrides.sessionStatus) return jsonResponse(overrides.sessionStatus, null);
      const session = SESSIONS[body.token ?? ""];
      return session ? jsonResponse(200, session) : jsonResponse(401, null);
    }
    if (url.endsWith("/api/v1/internal/platform/role-permissions")) {
      if (overrides.roleStatus) return jsonResponse(overrides.roleStatus, null);
      const items = (body.codes ?? []).filter((code) => code in ROLE_PERMISSIONS).map((code) => ({ code, permissions: ROLE_PERMISSIONS[code] }));
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

  it("认证或角色服务异常返回 502", async () => {
    const { fetchImpl } = stubFetch({ sessionStatus: 500 });
    expect(await authorizer(fetchImpl).authorize({ method: "GET", pathname: "/api/v1/plots", authorization: "Bearer token-admin" })).toEqual({
      allowed: false,
      status: 502,
      message: "认证或角色服务不可用",
    });
  });
});
