import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { hasPermission, parsePermissionHeader } from "@agri/contracts";

/**
 * 服务侧权限守卫。
 *
 * 身份与权限由网关校验后通过 `x-user-id` / `x-permissions` 头下发，服务只做本地判定，
 * 不再回查认证服务。服务监听回环地址，只有网关能写入这两个头，因此头可信。
 *
 * 守卫默认关闭（`AUTH_GUARD_MODE` 未设或非 `enforce`），原因是本地直连脚本与单元测试
 * 不带身份头；部署与冒烟验证时置为 `enforce`，网关本身就是强制的。
 */

/** 守卫策略：读/写所需权限，另可声明公开路径与仅需登录的路径 */
export interface AuthzPolicy {
  /** GET/HEAD 所需权限 */
  read: string;
  /** 其它方法所需权限 */
  write: string;
  /** 无需身份即可访问的路径（登录等） */
  publicPaths?: string[];
  /** 设备/算法回调路径：携带有效 x-device-token 放行，否则按用户身份与写权限判定 */
  callbackPaths?: string[];
  /** 仅需登录、不校验具体权限的路径（个人信息、退出登录） */
  sessionPaths?: string[];
  /** 按路径前缀覆盖所需权限，优先于读写默认值 */
  pathPermissions?: Array<{ prefix: string; permission: string }>;
}

/** 拒绝原因：401 缺身份，403 缺权限 */
export interface AuthzDenial {
  status: 401 | 403;
  message: string;
}

/** 守卫是否启用 */
export function authzGuardEnabled(): boolean {
  return process.env.AUTH_GUARD_MODE === "enforce";
}

/** 定长时间比较，避免凭证逐字节试探；任一为空一律不相等 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 设备/算法回调共享凭证，未配置时回调只能走用户身份 */
export function configuredDeviceToken(): string {
  return (process.env.DEVICE_CALLBACK_TOKEN ?? "").trim();
}

/** 请求头里的设备回调凭证是否有效 */
export function isDeviceCallbackAuthorized(headerValue: string | undefined): boolean {
  return constantTimeEquals(headerValue ?? "", configuredDeviceToken());
}

/**
 * 服务间调用时透传网关已校验的身份头。
 * 被调方仍按自己的策略二次判定权限，因此透传不会放大调用方的权限。
 */
export function identityHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["x-user-id", "x-permissions", "x-tenant-id"]) {
    const value = request.headers[name]?.toString();
    if (value) headers[name] = value;
  }
  return headers;
}

function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function matches(pathname: string, paths: string[] | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * 校验请求是否放行。
 * @returns 放行返回 null，拒绝返回状态码与提示，调用方按该状态码返回 ApiResponse
 */
export function authorizeRequest(request: IncomingMessage, policy: AuthzPolicy): AuthzDenial | null {
  if (!authzGuardEnabled()) return null;
  const pathname = normalize(new URL(request.url ?? "/", "http://localhost").pathname);
  if (matches(pathname, policy.publicPaths)) return null;
  // 回调路径：有效设备凭证直接放行；没有凭证则继续按用户身份判定（人工核查上报）
  if (matches(pathname, policy.callbackPaths) && isDeviceCallbackAuthorized(request.headers["x-device-token"]?.toString())) return null;

  const userId = request.headers["x-user-id"]?.toString() ?? "";
  if (!userId) return { status: 401, message: "未登录或登录已失效" };
  if (matches(pathname, policy.sessionPaths)) return null;

  const override = policy.pathPermissions?.find((rule) => pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`));
  const required = override?.permission ?? (request.method === "GET" || request.method === "HEAD" ? policy.read : policy.write);
  const granted = parsePermissionHeader(request.headers["x-permissions"]?.toString());
  if (!hasPermission(granted, required)) return { status: 403, message: `无权限执行该操作（需要 ${required}）` };
  return null;
}
