import { hasPermission, mergePermissions } from "@agri/contracts";
import { constantTimeEquals } from "@agri/shared";

/**
 * 网关鉴权。
 *
 * 网关是唯一公网入口：先校验 token 并解析用户，再按「请求方法与路径」映射所需权限，
 * 最后把可信身份（x-user-id / x-tenant-id / x-permissions）下发给服务。客户端自带的
 * 身份头一律丢弃，避免伪造。
 *
 * 会话与角色权限分别来自 auth-service 与 platform-service 的内部接口，二者均有短时缓存，
 * 避免每个请求都回查；缓存过期后自然重新解析。
 */

/** 网关注入下游的身份上下文 */
export interface AuthzSession {
  userId: string;
  tenantId: string;
  username: string;
  name: string;
  roles: string[];
  permissions: string[];
}

/** 鉴权结果：放行带身份（公开路径为 null），拒绝带状态码与提示 */
export type AuthzOutcome =
  | { allowed: true; session: AuthzSession | null }
  | { allowed: false; status: 401 | 403 | 502; message: string };

export interface AuthorizeInput {
  method: string;
  pathname: string;
  authorization?: string | undefined;
  /** 设备/算法回调携带的 x-device-token */
  deviceToken?: string | undefined;
}

export interface GatewayAuthorizer {
  authorize(input: AuthorizeInput): Promise<AuthzOutcome>;
}

type RouteRule = { kind: "public" } | { kind: "session" } | { kind: "permission"; code: string } | { kind: "callback"; write: string };

/** 路径前缀到读写权限的映射，未列出的前缀至少要求登录 */
const ROUTE_PERMISSIONS: Array<{ prefix: string; read: string; write: string }> = [
  { prefix: "/api/v1/plots", read: "plot:read", write: "plot:write" },
  // 片区是地块主数据的一部分，读写权限跟随地块
  { prefix: "/api/v1/zones", read: "plot:read", write: "plot:write" },
  { prefix: "/api/v1/devices", read: "device:read", write: "device:control" },
  { prefix: "/api/v1/telemetry", read: "telemetry:read", write: "telemetry:write" },
  { prefix: "/api/v1/weather", read: "weather:read", write: "weather:read" },
  { prefix: "/api/v1/messages", read: "message:read", write: "message:write" },
  { prefix: "/api/v1/farm-tasks", read: "operation:read", write: "operation:write" },
  { prefix: "/api/v1/operations", read: "operation:read", write: "operation:write" },
  { prefix: "/api/v1/control", read: "device:read", write: "device:control" },
  { prefix: "/api/v1/decision", read: "decision:read", write: "decision:write" },
  { prefix: "/api/v1/finance", read: "finance:read", write: "finance:write" },
  { prefix: "/api/v1/trace", read: "trace:read", write: "trace:write" },
  // 文件与视频没有独立权限位，归入地块与设备：上传跟随地块维护，播放跟随设备查看
  { prefix: "/api/v1/files", read: "plot:read", write: "plot:write" },
  { prefix: "/api/v1/video", read: "device:read", write: "device:control" },
];

function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * 解析单个请求需要的身份与权限。
 * 公开路径只有登录；设备上报与算法回调走回调凭证（也允许有写权限的用户人工上报）；
 * 账号、角色、审计各自独立，其余按前缀读写映射。
 */
export function resolveRouteRule(method: string, pathname: string): RouteRule {
  const path = normalize(pathname);
  if (path === "/health") return { kind: "public" };
  if (method === "POST" && path === "/api/v1/auth/login") return { kind: "public" };
  // 设备直连上报与算法回调不带用户令牌，改由 DEVICE_CALLBACK_TOKEN 共享凭证鉴权
  if (method === "POST" && path === "/api/v1/telemetry/report") return { kind: "callback", write: "telemetry:write" };
  if (method === "POST" && path === "/api/v1/telemetry/pest-events") return { kind: "callback", write: "telemetry:write" };
  if (method === "POST" && path === "/api/v1/video/ai-events") return { kind: "callback", write: "device:control" };
  // 控制指令的设备通道：网关领取与执行回执同用这套共享凭证
  if (method === "POST" && path === "/api/v1/control/device/dispatch") return { kind: "callback", write: "device:control" };
  if (method === "POST" && path === "/api/v1/control/device/receipt") return { kind: "callback", write: "device:control" };
  if (matchesPrefix(path, "/api/v1/auth/userinfo") || matchesPrefix(path, "/api/v1/auth/logout")) return { kind: "session" };
  if (matchesPrefix(path, "/api/v1/auth/users") || matchesPrefix(path, "/api/v1/auth/internal")) return { kind: "permission", code: "system:user" };
  if (matchesPrefix(path, "/api/v1/platform/roles")) return { kind: "permission", code: "system:role" };
  if (matchesPrefix(path, "/api/v1/platform/audit-logs")) return { kind: "permission", code: "system:audit" };
  if (matchesPrefix(path, "/api/v1/platform/backups")) return { kind: "permission", code: "system:backup" };
  if (matchesPrefix(path, "/api/v1/platform/tenant") || matchesPrefix(path, "/api/v1/platform/permissions")) return { kind: "session" };

  // 管理员强制同步和风天气：同属于 weather 前缀但需更高权限，优先于 ROUTE_PERMISSIONS 判定
  if (method === "POST" && path === "/api/v1/weather/sync-now") return { kind: "permission", code: "weather:sync" };

  const rule = ROUTE_PERMISSIONS.find((item) => matchesPrefix(path, item.prefix));
  if (rule) return { kind: "permission", code: isReadMethod(method) ? rule.read : rule.write };
  return { kind: "session" };
}

/** 去除 Bearer 前缀 */
export function bearerToken(authorization: string | undefined): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** 带过期时间的内存缓存 */
function cacheMap<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt < Date.now()) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T, ttlMs: number): void {
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    clear(): void {
      map.clear();
    },
  };
}

export interface GatewayAuthorizerOptions {
  authServiceUrl: string;
  platformServiceUrl: string;
  /** 内部接口凭证，与 auth/platform 的 INTERNAL_TOKEN 一致 */
  internalToken?: string;
  /** 设备/算法回调共享凭证，与 telemetry/video 的 DEVICE_CALLBACK_TOKEN 一致；未配置时回调只认用户身份 */
  deviceCallbackToken?: string;
  /** 会话缓存时长，默认 5 秒 */
  sessionTtlMs?: number;
  /** 角色权限缓存时长，默认 10 秒 */
  roleTtlMs?: number;
  fetchImpl?: typeof fetch;
}

interface SessionResponse {
  userId: string;
  tenantId: string;
  username: string;
  name: string;
  roles: string[];
  permissions: string[];
}

/** 权限不足时的统一拒绝结果 */
export function permissionDenied(code: string): AuthzOutcome {
  return { allowed: false, status: 403, message: `无权限执行该操作（需要 ${code}）` };
}

export function createGatewayAuthorizer(options: GatewayAuthorizerOptions): GatewayAuthorizer {
  const request = options.fetchImpl ?? fetch;
  const internalToken = options.internalToken ?? process.env.INTERNAL_TOKEN ?? "agri-internal";
  const deviceCallbackToken = (options.deviceCallbackToken ?? process.env.DEVICE_CALLBACK_TOKEN ?? "").trim();
  const sessionTtlMs = options.sessionTtlMs ?? 5000;
  const roleTtlMs = options.roleTtlMs ?? 10000;
  const sessionCache = cacheMap<AuthzSession>();
  const roleCache = cacheMap<string[]>();

  async function internal<T>(url: string, payload: unknown, tenantId?: string): Promise<{ status: number; data: T | null }> {
    const response = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken, ...(tenantId !== undefined ? { "x-tenant-id": tenantId } : {}) },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { data?: T };
    return { status: response.status, data: body.data ?? null };
  }

  async function resolveRolePermissions(tenantId: string, roles: string[]): Promise<string[]> {
    if (roles.length === 0) return [];
    const key = JSON.stringify([tenantId, [...roles].sort()]);
    const cached = roleCache.get(key);
    if (cached) return cached;
    const result = await internal<{ items: Array<{ code: string; permissions: string[] }> }>(
      `${options.platformServiceUrl}/api/v1/internal/platform/role-permissions`,
      { codes: roles },
      tenantId,
    );
    if (result.status !== 200 || !result.data) throw new Error("角色权限解析失败");
    const permissions = mergePermissions(...result.data.items.map((item) => item.permissions));
    roleCache.set(key, permissions, roleTtlMs);
    return permissions;
  }

  async function resolveSession(token: string): Promise<AuthzSession | null> {
    const cached = sessionCache.get(token);
    if (cached) return cached;
    const result = await internal<SessionResponse>(`${options.authServiceUrl}/api/v1/internal/auth/session`, { token });
    if (result.status === 401 || result.status === 403) return null;
    if (result.status !== 200 || !result.data) throw new Error("会话解析失败");
    const context = result.data;
    const rolePermissions = await resolveRolePermissions(context.tenantId, context.roles ?? []);
    const session: AuthzSession = {
      userId: context.userId,
      tenantId: context.tenantId,
      username: context.username,
      name: context.name,
      roles: context.roles ?? [],
      permissions: mergePermissions(rolePermissions, context.permissions ?? []),
    };
    sessionCache.set(token, session, sessionTtlMs);
    return session;
  }

  return {
    async authorize(input) {
      const rule = resolveRouteRule(input.method, input.pathname);
      if (rule.kind === "public") return { allowed: true, session: null };
      // 回调优先认设备凭证；凭证错误直接拒绝，不再回退用户身份，避免拿用户令牌试探设备通道
      if (rule.kind === "callback" && input.deviceToken) {
        return constantTimeEquals(input.deviceToken, deviceCallbackToken)
          ? { allowed: true, session: null }
          : { allowed: false, status: 401, message: "设备回调凭证无效" };
      }
      const token = bearerToken(input.authorization);
      if (!token) return { allowed: false, status: 401, message: "未登录或登录已失效" };
      try {
        const session = await resolveSession(token);
        if (!session) return { allowed: false, status: 401, message: "未登录或登录已失效" };
        if (rule.kind === "session") return { allowed: true, session };
        const required = rule.kind === "callback" ? rule.write : rule.code;
        return hasPermission(session.permissions, required) ? { allowed: true, session } : permissionDenied(required);
      } catch {
        return { allowed: false, status: 502, message: "认证或角色服务不可用" };
      }
    },
  };
}
