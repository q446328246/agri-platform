import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { mergePermissions } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { hashPassword, InMemoryUserRepository, needsRehash, seedUsers, verifyPassword } from "./user.repository.js";
import type { UserRecord, UserRepository, UserStatus } from "./user.repository.js";
import { createSessionToken, InMemorySessionRepository } from "./session.repository.js";
import type { SessionRepository } from "./session.repository.js";
import { InMemoryLoginAttemptRepository } from "./login-attempt.repository.js";
import type { LoginAttemptRepository } from "./login-attempt.repository.js";

/**
 * 认证与账号管理 HTTP 接口。
 *
 * 账号数据通过 UserRepository 注入，会话通过 SessionRepository 注入：
 * 有数据库时使用 SQL 实现（会话落 auth_sessions，重启后 token 仍有效），
 * 没有数据库时回落到内存实现，接口行为保持一致。
 */

export interface AuthHttpOptions {
  /** 账号仓储，缺省为带内置管理员的内存实现 */
  users?: UserRepository;
  /** 会话仓储，缺省为内存实现；接数据库时注入 SqlSessionRepository */
  sessions?: SessionRepository;
  /** 登录尝试台账（F2 防暴破），缺省内存实现 */
  attempts?: LoginAttemptRepository;
  /**
   * 登录审计上报（F2）：把登录成功/失败写入平台审计日志。
   * 组合根注入平台内部审计端点的调用，缺省不上报；上报失败不影响登录主流程。
   */
  audit?: (input: { tenantId: string; action: string; operator: string; resource: string; detail: string }) => Promise<void>;
}

/** 对外返回的账号视图，不含口令散列 */
type PublicUser = Omit<UserRecord, "passwordHash">;

const DEFAULT_SESSION_TTL_SECONDS = 7200;

/** 等保登录失败处置：连续失败达阈值锁定账号，阈值与时长可配（缺省 5 次 / 15 分钟） */
const DEFAULT_LOGIN_MAX_FAILURES = 5;
const DEFAULT_LOGIN_LOCK_MINUTES = 15;

function loginPolicy(): { maxFailures: number; lockMinutes: number } {
  const failures = Number(process.env.AUTH_LOGIN_MAX_FAILURES ?? "");
  const minutes = Number(process.env.AUTH_LOGIN_LOCK_MINUTES ?? "");
  return {
    maxFailures: Number.isInteger(failures) && failures >= 1 ? failures : DEFAULT_LOGIN_MAX_FAILURES,
    lockMinutes: Number.isInteger(minutes) && minutes >= 1 ? minutes : DEFAULT_LOGIN_LOCK_MINUTES,
  };
}

/** 等保口令复杂度：6~32 位，须同时含字母与数字 */
function passwordPolicyError(password: string): string | undefined {
  if (password.length < 6 || password.length > 32) return "密码需为 6~32 位";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码须同时包含字母与数字";
  return undefined;
}

/** 会话有效期（秒），部署时可用 AUTH_SESSION_TTL_SECONDS 调整 */
function sessionTtlSeconds(): number {
  const configured = Number(process.env.AUTH_SESSION_TTL_SECONDS ?? "");
  return Number.isFinite(configured) && configured >= 60 ? Math.floor(configured) : DEFAULT_SESSION_TTL_SECONDS;
}

function expiryIso(ttl: number): string { return new Date(Date.now() + ttl * 1000).toISOString(); }

/** 登录取到的 token：去空格并去掉 Bearer 前缀 */
function bearerToken(request: IncomingMessage): string { return request.headers.authorization?.replace(/^Bearer\s+/i, "").trim() ?? ""; }

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `AUTH-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function publicUser(record: UserRecord): PublicUser { const { passwordHash: _passwordHash, ...safe } = record; return safe; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => String(item).trim()).filter((item) => item.length > 0) : []; }
/** 管理接口只认网关注入的租户；未传头的本地开发请求限定在演示租户。 */
function tenantOf(request: IncomingMessage): string { return request.headers["x-tenant-id"]?.toString() || "tenant-demo"; }
function parseStatus(value: unknown): UserStatus | null { const status = text(value); if (status === "ACTIVE" || status === "DISABLED") return status; return null; }

/** 内部接口凭证：网关与管理脚本使用，不经公网暴露 */
function internalToken(): string { return process.env.INTERNAL_TOKEN ?? "agri-internal"; }
function fromGateway(request: IncomingMessage): boolean { return request.headers["x-internal-token"]?.toString() === internalToken(); }

const PLATFORM_SERVICE_URL = process.env.PLATFORM_SERVICE_URL ?? "http://127.0.0.1:3014";

/**
 * 有效权限：角色权限从 platform-service 取得，与账号直授权限合并。
 * 平台暂时不可用时退回直授权限，避免登录被下游拖垮；管理员持有 `*` 无需回查。
 */
async function effectivePermissions(user: UserRecord): Promise<string[]> {
  if (user.permissions.includes("*")) return user.permissions;
  try {
    const response = await fetch(`${PLATFORM_SERVICE_URL}/api/v1/internal/platform/role-permissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken(), "x-tenant-id": user.tenantId },
      body: JSON.stringify({ codes: user.roles }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return user.permissions;
    const payload = (await response.json()) as { data?: { items?: Array<{ permissions: string[] }> } };
    return mergePermissions((payload.data?.items ?? []).flatMap((item) => item.permissions), user.permissions);
  } catch {
    return user.permissions;
  }
}

/** 带有效权限的账号视图，登录与个人信息共用 */
async function publicUserWithPermissions(record: UserRecord): Promise<PublicUser> {
  return { ...publicUser(record), permissions: await effectivePermissions(record) };
}

/**
 * 登录审计上报：成功失败都留痕，带上来源地址与锁定说明。
 * 审计是旁路：未注入或上报失败都不影响登录主流程。
 */
async function auditLogin(
  audit: AuthHttpOptions["audit"],
  tenantId: string,
  username: string,
  ip: string,
  success: boolean,
  detail: string,
): Promise<void> {
  if (!audit) return;
  await audit({
    tenantId,
    action: success ? "auth.login.succeeded" : "auth.login.failed",
    operator: username,
    resource: `user:${username}`,
    detail: `${ip}${detail ? `，${detail}` : ""}`,
  }).catch(() => {});
}

/** 服务侧权限守卫：账号管理需 system:user，登录与内部会话接口公开，个人信息仅需登录 */
const AUTH_POLICY = {
  read: "system:user",
  write: "system:user",
  publicPaths: ["/api/v1/auth/login", "/api/v1/internal/auth/session"],
  sessionPaths: ["/api/v1/auth/userinfo", "/api/v1/auth/logout", "/api/v1/auth/refresh"],
};

async function authorized(request: IncomingMessage, users: UserRepository, sessions: SessionRepository): Promise<{ user: UserRecord; expiresAt: string } | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const session = await sessions.find(token);
  if (!session) return null;
  const user = await users.findById(session.userId);
  if (!user || user.status === "DISABLED") return null;
  return { user, expiresAt: session.expiresAt };
}

/** 新建账号入参校验，返回错误信息或可直接落库的记录 */
function buildNewUser(request: IncomingMessage, body: Record<string, unknown>): { error: string; record?: undefined } | { error?: undefined; record: UserRecord } {
  const username = text(body.username);
  const name = text(body.name);
  const password = text(body.password) || "Aa123456";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{2,31}$/.test(username)) return { error: "用户名需以字母开头，3~32 位字母、数字、下划线或短横线" };
  const passwordError = passwordPolicyError(password);
  if (passwordError) return { error: passwordError };
  if (!name) return { error: "姓名不能为空" };
  const now = new Date().toISOString();
  return {
    record: {
      id: `user-${randomUUID().slice(0, 8)}`,
      tenantId: tenantOf(request),
      username,
      passwordHash: hashPassword(password),
      name,
      phone: text(body.phone),
      roles: stringList(body.roles),
      permissions: stringList(body.permissions),
      status: parseStatus(body.status) ?? "ACTIVE",
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** 更新账号：只覆盖传入字段，用户名与口令分别由建号与重置口令接口维护 */
function applyUpdate(record: UserRecord, body: Record<string, unknown>): { error: string; next?: undefined } | { error?: undefined; next: UserRecord } {
  const name = text(body.name);
  if (body.name !== undefined && !name) return { error: "姓名不能为空" };
  if (body.status !== undefined && parseStatus(body.status) === null) return { error: "状态取值非法" };
  const next: UserRecord = {
    ...record,
    name: name || record.name,
    phone: body.phone !== undefined ? text(body.phone) : record.phone,
    roles: body.roles !== undefined ? stringList(body.roles) : record.roles,
    permissions: body.permissions !== undefined ? stringList(body.permissions) : record.permissions,
    status: parseStatus(body.status) ?? record.status,
    updatedAt: new Date().toISOString(),
  };
  return { next };
}

export function createAuthHttpServer(options: AuthHttpOptions = {}): Server {
  const users = options.users ?? new InMemoryUserRepository(seedUsers());
  const sessions = options.sessions ?? new InMemorySessionRepository();
  return createServer(async (request, response) => { const traceId = trace(request); const url = new URL(request.url ?? "/", "http://localhost"); try {
    if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { status: "ok", service: "auth" }, traceId); return; }
    const denied = authorizeRequest(request, AUTH_POLICY);
    if (denied) { send(response, denied.status, null, traceId, denied.message); return; }
    // 内部会话解析：网关凭 token 换取用户与角色，避免网关维护会话表
    if (request.method === "POST" && url.pathname === "/api/v1/internal/auth/session") {
      if (!fromGateway(request)) { send(response, 401, null, traceId, "内部接口凭证无效"); return; }
      const body = await readJson(request);
      const token = text(body.token);
      const session = token ? await sessions.find(token) : null;
      if (!session) { send(response, 401, null, traceId, "登录已失效"); return; }
      const user = await users.findById(session.userId);
      if (!user || user.status === "DISABLED") { send(response, 401, null, traceId, "账号不可用"); return; }
      send(response, 200, { userId: user.id, tenantId: user.tenantId, username: user.username, name: user.name, roles: user.roles, permissions: user.permissions, expiresAt: session.expiresAt }, traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
      const body = await readJson(request);
      const username = text(body.username);
      const password = text(body.password);
      // 登录尚未建立可信身份，允许通过请求体选择登录租户。
      const tenantId = text(body.tenantId) || tenantOf(request);
      const ip = request.socket.remoteAddress ?? "";
      const attempts = options.attempts;
      // 防暴破：锁定期内的尝试直接拒绝，不再消耗口令比对
      if (attempts) {
        const existing = await attempts.find(tenantId, username);
        if (existing?.lockedUntil && Date.parse(existing.lockedUntil) > Date.now()) {
          const minutes = Math.max(1, Math.ceil((Date.parse(existing.lockedUntil) - Date.now()) / 60_000));
          send(response, 423, null, traceId, `账号已锁定，请 ${minutes} 分钟后重试或联系管理员`);
          return;
        }
      }
      const user = await users.findByUsername(tenantId, username);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        if (attempts) {
          const policy = loginPolicy();
          const record = await attempts.recordFailure({ tenantId, username, lastIp: ip }, policy.maxFailures, policy.lockMinutes, new Date());
          await auditLogin(options.audit, tenantId, username, ip, false, record.lockedUntil ? `连续失败 ${record.failCount} 次，锁定至 ${record.lockedUntil}` : `连续失败 ${record.failCount} 次`);
          if (record.lockedUntil) {
            const minutes = Math.max(1, Math.ceil((Date.parse(record.lockedUntil) - Date.now()) / 60_000));
            send(response, 423, null, traceId, `用户名或密码错误，账号已锁定，请 ${minutes} 分钟后重试或联系管理员`);
            return;
          }
        }
        send(response, 401, null, traceId, "用户名或密码错误");
        return;
      }
      if (user.status === "DISABLED") { send(response, 403, null, traceId, "账号已停用，请联系管理员"); return; }
      // 登录成功清零失败台账，并留审计
      if (attempts) await attempts.clear(tenantId, username);
      await auditLogin(options.audit, tenantId, username, ip, true, "");
      // 旧 sha256 散列在登录成功时就地升级，历史账号无需批量改密
      if (needsRehash(user.passwordHash)) {
        const upgraded = hashPassword(password);
        await users.updatePassword(user.id, upgraded, new Date().toISOString());
        user.passwordHash = upgraded;
      }
      const ttl = sessionTtlSeconds();
      const token = createSessionToken();
      await sessions.create({ token, userId: user.id, tenantId: user.tenantId, expiresAt: expiryIso(ttl), createdAt: new Date().toISOString() });
      send(response, 200, { token, expiresIn: ttl, user: await publicUserWithPermissions(user) }, traceId);
      return;
    }
    // 滑动续期：沿用同一 token 只延长有效期，前端并发请求不会互相踢下线
    if (request.method === "POST" && url.pathname === "/api/v1/auth/refresh") {
      const token = bearerToken(request);
      const session = token ? await sessions.find(token) : null;
      if (!token || !session) { send(response, 401, null, traceId, "登录已失效"); return; }
      const user = await users.findById(session.userId);
      if (!user || user.status === "DISABLED") { await sessions.remove(token); send(response, 401, null, traceId, "账号不可用"); return; }
      const ttl = sessionTtlSeconds();
      if (!(await sessions.renew(token, expiryIso(ttl)))) { send(response, 401, null, traceId, "登录已失效"); return; }
      send(response, 200, { token, expiresIn: ttl, user: await publicUserWithPermissions(user) }, traceId);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/auth/userinfo") { const identity = await authorized(request, users, sessions); if (!identity) { send(response, 401, null, traceId, "未授权，请登录"); return; } send(response, 200, await publicUserWithPermissions(identity.user), traceId); return; }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") { const token = bearerToken(request); if (token) await sessions.remove(token); send(response, 200, null, traceId); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/auth/users") {
      const status = parseStatus(url.searchParams.get("status"));
      const page = await users.page({
        page: Math.max(1, Number(url.searchParams.get("page") || 1)),
        size: Math.min(200, Math.max(1, Number(url.searchParams.get("size") || 20))),
        tenantId: tenantOf(request),
        ...(status ? { status } : {}),
        ...(text(url.searchParams.get("keyword")) ? { keyword: text(url.searchParams.get("keyword")) } : {}),
      });
      const result: PageResult<PublicUser> = { ...page, items: page.items.map(publicUser) };
      send(response, 200, result, traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/users") {
      const body = await readJson(request);
      if (body.tenantId !== undefined && text(body.tenantId) !== tenantOf(request)) { send(response, 403, null, traceId, "不能跨租户创建用户"); return; }
      const built = buildNewUser(request, body);
      if (built.error !== undefined) { send(response, 400, null, traceId, built.error); return; }
      if (await users.findByUsername(built.record.tenantId, built.record.username)) { send(response, 409, null, traceId, "用户名已存在"); return; }
      send(response, 201, publicUser(await users.create(built.record)), traceId);
      return;
    }
    const userRoute = url.pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)$/);
    if (userRoute) {
      const id = decodeURIComponent(userRoute[1] ?? "");
      const user = await users.findById(id);
      if (!user || user.tenantId !== tenantOf(request)) { send(response, 404, null, traceId, "用户不存在"); return; }
      if (request.method === "PUT") {
        const applied = applyUpdate(user, await readJson(request));
        if (applied.error !== undefined) { send(response, 400, null, traceId, applied.error); return; }
        send(response, 200, publicUser(await users.update(applied.next)), traceId);
        return;
      }
      if (request.method === "DELETE") {
        if (user.username === "admin") { send(response, 409, null, traceId, "内置管理员不可删除"); return; }
        if (user.id === request.headers["x-user-id"]?.toString()) { send(response, 409, null, traceId, "不能删除当前登录用户"); return; }
        await users.remove(user.id);
        // 账号删除后回收其全部会话，避免已发放 token 继续可用
        await sessions.removeByUser(user.id);
        send(response, 200, null, traceId);
        return;
      }
    }
    const passwordRoute = url.pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)\/password$/);
    if (request.method === "POST" && passwordRoute) {
      const id = decodeURIComponent(passwordRoute[1] ?? "");
      const user = await users.findById(id);
      if (!user || user.tenantId !== tenantOf(request)) { send(response, 404, null, traceId, "用户不存在"); return; }
      const password = text((await readJson(request)).password);
      const passwordError = passwordPolicyError(password);
      if (passwordError) { send(response, 400, null, traceId, passwordError); return; }
      await users.updatePassword(user.id, hashPassword(password), new Date().toISOString());
      // 改密后回收该账号全部会话，旧 token 立即失效
      await sessions.removeByUser(user.id);
      send(response, 200, null, traceId);
      return;
    }
    send(response, 404, null, traceId, "接口不存在");
  } catch (error) {
    // 等保错误处理：生产环境错误响应不泄露内部细节，仅开发/测试保留原始信息便于排查
    const detail = process.env.NODE_ENV === "production" ? "请求处理失败" : (error instanceof Error ? error.message : "请求处理失败");
    send(response, 400, null, traceId, detail);
  } });
}
