import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { AuthzPolicy } from "../src/authz.js";
import { authorizeRequest, authzGuardEnabled } from "../src/authz.js";

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
