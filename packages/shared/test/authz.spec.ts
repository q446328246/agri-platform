import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { AuthzPolicy } from "../src/authz.js";
import { authorizeRequest, authzGuardEnabled, constantTimeEquals, identityHeaders, isDeviceCallbackAuthorized } from "../src/authz.js";

const policy: AuthzPolicy = {
  read: "plot:read",
  write: "plot:write",
  publicPaths: ["/api/v1/plots/report"],
  sessionPaths: ["/api/v1/plots/profile"],
  pathPermissions: [{ prefix: "/api/v1/plots/audit", permission: "system:audit" }],
};

function request(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("服务侧权限守卫", () => {
  it("未显式开启时一律放行，兼容本地直连与单元测试", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "");
    expect(authzGuardEnabled()).toBe(false);
    expect(authorizeRequest(request("GET", "/api/v1/plots"), policy)).toBeNull();
  });

  it("公开路径不需要身份，其余请求缺少身份头返回 401", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    expect(authorizeRequest(request("POST", "/api/v1/plots/report"), policy)).toBeNull();
    expect(authorizeRequest(request("GET", "/api/v1/plots"), policy)).toEqual({ status: 401, message: "未登录或登录已失效" });
  });

  it("仅需登录的路径不再校验具体权限", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    expect(authorizeRequest(request("GET", "/api/v1/plots/profile", { "x-user-id": "user-admin" }), policy)).toBeNull();
  });

  it("按请求方法选择读写权限，通配权限可放行", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    expect(authorizeRequest(request("GET", "/api/v1/plots", { "x-user-id": "user-1", "x-permissions": "plot:read" }), policy)).toBeNull();
    expect(authorizeRequest(request("POST", "/api/v1/plots", { "x-user-id": "user-1", "x-permissions": "plot:*" }), policy)).toBeNull();
    expect(authorizeRequest(request("GET", "/api/v1/plots", { "x-user-id": "user-1", "x-permissions": "*" }), policy)).toBeNull();
  });

  it("权限不足返回 403 并说明所需权限", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    expect(authorizeRequest(request("POST", "/api/v1/plots", { "x-user-id": "user-1", "x-permissions": "plot:read" }), policy)).toEqual({
      status: 403,
      message: "无权限执行该操作（需要 plot:write）",
    });
  });

  it("路径级权限覆盖读写默认值，尾部斜杠不影响判定", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    expect(authorizeRequest(request("GET", "/api/v1/plots/audit/", { "x-user-id": "user-1", "x-permissions": "plot:read" }), policy)).toEqual({
      status: 403,
      message: "无权限执行该操作（需要 system:audit）",
    });
    expect(authorizeRequest(request("GET", "/api/v1/plots/audit", { "x-user-id": "user-1", "x-permissions": "system:audit" }), policy)).toBeNull();
  });
});

describe("设备回调凭证", () => {
  const callbackPolicy: AuthzPolicy = {
    read: "telemetry:read",
    write: "telemetry:write",
    callbackPaths: ["/api/v1/telemetry/report", "/api/v1/telemetry/pest-events"],
  };

  it("开启守卫后回调路径认设备凭证，或用户身份加写权限", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    vi.stubEnv("DEVICE_CALLBACK_TOKEN", "device-secret");
    expect(authorizeRequest(request("POST", "/api/v1/telemetry/report", { "x-device-token": "device-secret" }), callbackPolicy)).toBeNull();
    expect(authorizeRequest(request("POST", "/api/v1/telemetry/report", { "x-device-token": "wrong" }), callbackPolicy)).toEqual({ status: 401, message: "未登录或登录已失效" });
    expect(authorizeRequest(request("POST", "/api/v1/telemetry/report"), callbackPolicy)).toEqual({ status: 401, message: "未登录或登录已失效" });
    // 人工田间核查：无设备凭证时按用户写权限放行
    expect(authorizeRequest(request("POST", "/api/v1/telemetry/pest-events", { "x-user-id": "user-1", "x-permissions": "telemetry:write" }), callbackPolicy)).toBeNull();
    expect(authorizeRequest(request("POST", "/api/v1/telemetry/pest-events", { "x-user-id": "user-1", "x-permissions": "telemetry:read" }), callbackPolicy)).toEqual({ status: 403, message: "无权限执行该操作（需要 telemetry:write）" });
  });

  it("未配置凭证时设备通道关闭，空凭证永不放行", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    vi.stubEnv("DEVICE_CALLBACK_TOKEN", "");
    expect(authorizeRequest(request("POST", "/api/v1/telemetry/report", { "x-device-token": "" }), callbackPolicy)).toEqual({ status: 401, message: "未登录或登录已失效" });
    expect(isDeviceCallbackAuthorized("anything")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(false);
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });

  it("守卫未开启时回调路径与其余路径一律放行", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "");
    expect(authorizeRequest(request("POST", "/api/v1/telemetry/report"), callbackPolicy)).toBeNull();
  });
});

describe("identityHeaders", () => {
  it("只透传身份三项，缺失项不写空值，其余请求头不外泄", () => {
    expect(identityHeaders(request("GET", "/api/v1/plots", {
      "x-user-id": "user-1",
      "x-permissions": "plot:read",
      "x-tenant-id": "tenant-demo",
      authorization: "Bearer secret",
      cookie: "session=secret",
    }))).toEqual({ "x-user-id": "user-1", "x-permissions": "plot:read", "x-tenant-id": "tenant-demo" });
    expect(identityHeaders(request("GET", "/api/v1/plots", { "x-user-id": "user-1" }))).toEqual({ "x-user-id": "user-1" });
    expect(identityHeaders(request("GET", "/api/v1/plots"))).toEqual({});
  });

  it("透传的身份头能让被调方守卫按原权限放行", () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    const inbound = request("GET", "/api/v1/plots", { "x-user-id": "user-1", "x-permissions": "plot:read" });
    const forwarded = request("GET", "/api/v1/telemetry/latest", identityHeaders(inbound));
    expect(authorizeRequest(forwarded, { read: "plot:read", write: "plot:write" })).toBeNull();
    expect(authorizeRequest(forwarded, { read: "plot:write", write: "plot:write" })).toEqual({
      status: 403,
      message: "无权限执行该操作（需要 plot:write）",
    });
  });
});
