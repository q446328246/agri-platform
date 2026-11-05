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
  /** 无需身份即可访问的路径（登录、设备上报等） */
  publicPaths?: string[];
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

  const userId = request.headers["x-user-id"]?.toString() ?? "";
  if (!userId) return { status: 401, message: "未登录或登录已失效" };
  if (matches(pathname, policy.sessionPaths)) return null;

  const override = policy.pathPermissions?.find((rule) => pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`));
  const required = override?.permission ?? (request.method === "GET" || request.method === "HEAD" ? policy.read : policy.write);
  const granted = parsePermissionHeader(request.headers["x-permissions"]?.toString());
  if (!hasPermission(granted, required)) return { status: 403, message: `无权限执行该操作（需要 ${required}）` };
  return null;
}
