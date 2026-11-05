import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { mergePermissions } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { hashPassword, InMemoryUserRepository, seedUsers } from "./user.repository.js";
import type { UserRecord, UserRepository, UserStatus } from "./user.repository.js";

/**
 * 认证与账号管理 HTTP 接口。
 *
 * 账号数据通过 UserRepository 注入：有数据库时使用 SqlUserRepository，
 * 没有数据库时回落到内存实现，接口行为保持一致。
 */

export interface AuthHttpOptions {
  /** 账号仓储，缺省为带内置管理员的内存实现 */
  users?: UserRepository;
}

/** 对外返回的账号视图，不含口令散列 */
type PublicUser = Omit<UserRecord, "passwordHash">;

const sessions = new Map<string, { userId: string; expiresAt: number }>();

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `AUTH-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function publicUser(record: UserRecord): PublicUser { const { passwordHash: _passwordHash, ...safe } = record; return safe; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => String(item).trim()).filter((item) => item.length > 0) : []; }
function tenantOf(request: IncomingMessage, body?: Record<string, unknown>): string { return text(body?.tenantId) || request.headers["x-tenant-id"]?.toString() || "tenant-demo"; }
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

/** 服务侧权限守卫：账号管理需 system:user，登录与内部会话接口公开，个人信息仅需登录 */
const AUTH_POLICY = {
  read: "system:user",
  write: "system:user",
  publicPaths: ["/api/v1/auth/login", "/api/v1/internal/auth/session"],
  sessionPaths: ["/api/v1/auth/userinfo", "/api/v1/auth/logout", "/api/v1/auth/refresh"],
};

async function authorized(request: IncomingMessage, users: UserRepository): Promise<UserRecord | null> {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expiresAt < Date.now()) return null;
  return users.findById(session.userId);
}

/** 新建账号入参校验，返回错误信息或可直接落库的记录 */
function buildNewUser(request: IncomingMessage, body: Record<string, unknown>): { error: string; record?: undefined } | { error?: undefined; record: UserRecord } {
  const username = text(body.username);
  const name = text(body.name);
  const password = text(body.password) || "123456";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{2,31}$/.test(username)) return { error: "用户名需以字母开头，3~32 位字母、数字、下划线或短横线" };
  if (password.length < 6) return { error: "密码至少 6 位" };
  if (!name) return { error: "姓名不能为空" };
  const now = new Date().toISOString();
  return {
    record: {
      id: `user-${randomUUID().slice(0, 8)}`,
      tenantId: tenantOf(request, body),
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
  return createServer(async (request, response) => { const traceId = trace(request); const url = new URL(request.url ?? "/", "http://localhost"); try {
    if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { status: "ok", service: "auth" }, traceId); return; }
    const denied = authorizeRequest(request, AUTH_POLICY);
    if (denied) { send(response, denied.status, null, traceId, denied.message); return; }
    // 内部会话解析：网关凭 token 换取用户与角色，避免网关维护会话表
    if (request.method === "POST" && url.pathname === "/api/v1/internal/auth/session") {
      if (!fromGateway(request)) { send(response, 401, null, traceId, "内部接口凭证无效"); return; }
      const body = await readJson(request);
      const token = text(body.token);
      const session = token ? sessions.get(token) : undefined;
      if (!session || session.expiresAt < Date.now()) { send(response, 401, null, traceId, "登录已失效"); return; }
      const user = await users.findById(session.userId);
      if (!user || user.status === "DISABLED") { send(response, 401, null, traceId, "账号不可用"); return; }
      send(response, 200, { userId: user.id, tenantId: user.tenantId, username: user.username, name: user.name, roles: user.roles, permissions: user.permissions, expiresAt: new Date(session.expiresAt).toISOString() }, traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
      const body = await readJson(request);
      const username = text(body.username);
      const user = await users.findByUsername(tenantOf(request, body), username);
      if (!user || user.passwordHash !== hashPassword(text(body.password))) { send(response, 401, null, traceId, "用户名或密码错误"); return; }
      if (user.status === "DISABLED") { send(response, 403, null, traceId, "账号已停用，请联系管理员"); return; }
      const token = randomUUID();
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7200000 });
      send(response, 200, { token, expiresIn: 7200, user: await publicUserWithPermissions(user) }, traceId);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/auth/userinfo") { const user = await authorized(request, users); if (!user) { send(response, 401, null, traceId, "未授权，请登录"); return; } send(response, 200, await publicUserWithPermissions(user), traceId); return; }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") { const token = request.headers.authorization?.replace(/^Bearer\s+/i, ""); if (token) sessions.delete(token); send(response, 200, null, traceId); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/auth/users") {
      const status = parseStatus(url.searchParams.get("status"));
      const page = await users.page({
        page: Math.max(1, Number(url.searchParams.get("page") || 1)),
        size: Math.min(200, Math.max(1, Number(url.searchParams.get("size") || 20))),
        ...(request.headers["x-tenant-id"] ? { tenantId: request.headers["x-tenant-id"].toString() } : {}),
        ...(status ? { status } : {}),
        ...(text(url.searchParams.get("keyword")) ? { keyword: text(url.searchParams.get("keyword")) } : {}),
      });
      const result: PageResult<PublicUser> = { ...page, items: page.items.map(publicUser) };
      send(response, 200, result, traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/users") {
      const built = buildNewUser(request, await readJson(request));
      if (built.error !== undefined) { send(response, 400, null, traceId, built.error); return; }
      if (await users.findByUsername(built.record.tenantId, built.record.username)) { send(response, 409, null, traceId, "用户名已存在"); return; }
      send(response, 201, publicUser(await users.create(built.record)), traceId);
      return;
    }
    const userRoute = url.pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)$/);
    if (userRoute) {
      const id = decodeURIComponent(userRoute[1] ?? "");
      const user = await users.findById(id);
      if (!user) { send(response, 404, null, traceId, "用户不存在"); return; }
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
        // 账号删除后回收其会话，避免已发放 token 继续可用
        for (const [token, session] of sessions) if (session.userId === user.id) sessions.delete(token);
        send(response, 200, null, traceId);
        return;
      }
    }
    const passwordRoute = url.pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)\/password$/);
    if (request.method === "POST" && passwordRoute) {
      const id = decodeURIComponent(passwordRoute[1] ?? "");
      const user = await users.findById(id);
      if (!user) { send(response, 404, null, traceId, "用户不存在"); return; }
      const password = text((await readJson(request)).password);
      if (password.length < 6) { send(response, 400, null, traceId, "密码至少 6 位"); return; }
      await users.updatePassword(user.id, hashPassword(password), new Date().toISOString());
      send(response, 200, null, traceId);
      return;
    }
    send(response, 404, null, traceId, "接口不存在");
  } catch (error) { send(response, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } });
}
