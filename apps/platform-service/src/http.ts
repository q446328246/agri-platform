import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { PERMISSION_CATALOG } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { InMemoryAuditRepository, InMemoryRoleRepository, seedRoles } from "./role.repository.js";
import type { AuditRecord, AuditRepository, RoleRecord, RoleRepository } from "./role.repository.js";

/**
 * 平台服务 HTTP 接口：租户信息、权限目录、角色管理与审计日志。
 *
 * 角色与审计日志通过仓储注入，有数据库时落 platform_roles /
 * platform_role_permissions / platform_audit_logs，无数据库时使用内存实现。
 */

export interface PlatformHttpOptions {
  roles?: RoleRepository;
  audits?: AuditRepository;
}

interface Tenant { id: string; name: string; code: string; status: "ACTIVE" | "DISABLED" }

const tenants: Tenant[] = [{ id: "tenant-demo", name: "达州示范农场", code: "DAZHOU-DEMO", status: "ACTIVE" }];

/** 权限目录：与 @agri/contracts 共用一份，角色页、网关与服务守卫不会漂移 */
const permissionCatalog = PERMISSION_CATALOG;
const permissionCodes = new Set(permissionCatalog.flatMap((group) => group.items.map((item) => item.code)));

/** 服务侧权限守卫：角色与审计接口按权限区分，租户与权限目录仅需登录 */
const PLATFORM_POLICY = {
  read: "system:role",
  write: "system:role",
  publicPaths: ["/api/v1/internal/platform/role-permissions"],
  sessionPaths: ["/api/v1/platform/tenant", "/api/v1/platform/permissions"],
  pathPermissions: [{ prefix: "/api/v1/platform/audit-logs", permission: "system:audit" }],
};

/** 内部接口凭证：网关与管理脚本使用，不经公网暴露 */
function internalToken(): string { return process.env.INTERNAL_TOKEN ?? "agri-internal"; }
function fromGateway(request: IncomingMessage): boolean { return request.headers["x-internal-token"]?.toString() === internalToken(); }

function trace(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
function send<T>(response: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `PLATFORM-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function tenantOf(request: IncomingMessage): string { return request.headers["x-tenant-id"]?.toString() || "tenant-demo"; }
function operator(request: IncomingMessage): string { return request.headers["x-user-id"]?.toString() || "system"; }
function pageOf(query: URLSearchParams): { page: number; size: number } { return { page: Math.max(1, Number(query.get("page") || 1)), size: Math.min(200, Math.max(1, Number(query.get("size") || 20))) }; }
function parseStatus(value: unknown): "ACTIVE" | "DISABLED" | null { const status = text(value); if (status === "ACTIVE" || status === "DISABLED") return status; return null; }

/** 校验角色权限：只接受权限目录里的编码，内置管理员固定为通配符 */
function parsePermissions(value: unknown): { permissions: string[]; error?: string } {
  if (value === undefined) return { permissions: [] };
  if (!Array.isArray(value)) return { permissions: [], error: "权限必须是数组" };
  const permissions = [...new Set(value.map((item) => String(item).trim()).filter((item) => item.length > 0))];
  const unknown = permissions.find((code) => code !== "*" && !permissionCodes.has(code));
  if (unknown) return { permissions: [], error: `未知权限编码：${unknown}` };
  return { permissions };
}

export function createPlatformHttpServer(options: PlatformHttpOptions = {}): Server {
  const roles = options.roles ?? new InMemoryRoleRepository(seedRoles());
  const audits = options.audits ?? new InMemoryAuditRepository();
  const audit = async (request: IncomingMessage, action: string, resource: string, detail: string): Promise<void> => {
    const record: AuditRecord = { id: `audit-${randomUUID().slice(0, 8)}`, tenantId: tenantOf(request), action, operator: operator(request), resource, detail, createdAt: new Date().toISOString() };
    await audits.create(record);
  };
  return createServer(async (request, response) => { const traceId = trace(request); const url = new URL(request.url ?? "/", "http://localhost"); try {
    if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { status: "ok", service: "platform" }, traceId); return; }
    const denied = authorizeRequest(request, PLATFORM_POLICY);
    if (denied) { send(response, denied.status, null, traceId, denied.message); return; }
    // 内部角色权限：网关把用户的角色编码交回来，换取实际权限
    if (request.method === "POST" && url.pathname === "/api/v1/internal/platform/role-permissions") {
      if (!fromGateway(request)) { send(response, 401, null, traceId, "内部接口凭证无效"); return; }
      const body = await readJson(request);
      const codes = Array.isArray(body.codes) ? body.codes.map((item) => String(item).trim()).filter((item) => item.length > 0) : [];
      const items: Array<{ code: string; permissions: string[] }> = [];
      for (const code of codes) {
        const role = await roles.findByCode(tenantOf(request), code);
        if (role && role.status === "ACTIVE") items.push({ code: role.code, permissions: role.permissions });
      }
      send(response, 200, { items }, traceId);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/tenant") {
      const tenant = tenants.find((item) => item.id === tenantOf(request));
      if (!tenant) { send(response, 404, null, traceId, "租户不存在"); return; }
      send(response, 200, tenant, traceId);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/permissions") { send(response, 200, permissionCatalog, traceId); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/roles") {
      const keyword = text(url.searchParams.get("keyword"));
      send(response, 200, await roles.page({ tenantId: tenantOf(request), ...(keyword ? { keyword } : {}), ...pageOf(url.searchParams) }), traceId);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/platform/roles") {
      const body = await readJson(request);
      const name = text(body.name);
      const code = text(body.code);
      if (!name) { send(response, 400, null, traceId, "角色名称不能为空"); return; }
      if (!/^[a-z][a-z0-9_-]{2,31}$/.test(code)) { send(response, 400, null, traceId, "角色编码需以小写字母开头，3~32 位小写字母、数字、下划线或短横线"); return; }
      if (await roles.findByCode(tenantOf(request), code)) { send(response, 409, null, traceId, "角色编码已存在"); return; }
      const parsed = parsePermissions(body.permissions);
      if (parsed.error !== undefined) { send(response, 400, null, traceId, parsed.error); return; }
      if (parsed.permissions.length === 0) { send(response, 400, null, traceId, "至少选择一项权限"); return; }
      const now = new Date().toISOString();
      const record: RoleRecord = { id: `role-${randomUUID().slice(0, 8)}`, tenantId: tenantOf(request), name, code, description: text(body.description), permissions: parsed.permissions, status: parseStatus(body.status) ?? "ACTIVE", createdAt: now, updatedAt: now };
      const created = await roles.create(record);
      await audit(request, "role.create", `role:${record.id}`, `新建角色 ${name}（${code}），权限 ${parsed.permissions.join(",")}`);
      send(response, 201, created, traceId);
      return;
    }
    const roleRoute = url.pathname.match(/^\/api\/v1\/platform\/roles\/([^/]+)$/);
    if (roleRoute) {
      const id = decodeURIComponent(roleRoute[1] ?? "");
      const role = await roles.findById(id);
      if (!role || role.tenantId !== tenantOf(request)) { send(response, 404, null, traceId, "角色不存在"); return; }
      if (request.method === "PUT") {
        const body = await readJson(request);
        const name = text(body.name);
        if (body.name !== undefined && !name) { send(response, 400, null, traceId, "角色名称不能为空"); return; }
        if (body.status !== undefined && parseStatus(body.status) === null) { send(response, 400, null, traceId, "状态取值非法"); return; }
        const parsed = parsePermissions(body.permissions);
        if (parsed.error !== undefined) { send(response, 400, null, traceId, parsed.error); return; }
        if (body.permissions !== undefined && parsed.permissions.length === 0) { send(response, 400, null, traceId, "至少选择一项权限"); return; }
        if (role.code === "admin" && body.permissions !== undefined) { send(response, 400, null, traceId, "内置管理员角色不可修改权限"); return; }
        const next: RoleRecord = {
          ...role,
          name: name || role.name,
          description: body.description !== undefined ? text(body.description) : role.description,
          permissions: body.permissions !== undefined ? parsed.permissions : role.permissions,
          status: parseStatus(body.status) ?? role.status,
          updatedAt: new Date().toISOString(),
        };
        const updated = await roles.update(next);
        await audit(request, "role.update", `role:${role.id}`, `更新角色 ${next.name}，权限 ${next.permissions.join(",")}`);
        send(response, 200, updated, traceId);
        return;
      }
      if (request.method === "DELETE") {
        if (role.code === "admin") { send(response, 409, null, traceId, "内置管理员角色不可删除"); return; }
        await roles.remove(role.id);
        await audit(request, "role.delete", `role:${role.id}`, `删除角色 ${role.name}（${role.code}）`);
        send(response, 200, null, traceId);
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/audit-logs") {
      const keyword = text(url.searchParams.get("keyword"));
      send(response, 200, await audits.page({ tenantId: tenantOf(request), ...(keyword ? { keyword } : {}), ...pageOf(url.searchParams) }), traceId);
      return;
    }
    send(response, 404, null, traceId, "接口不存在");
  } catch (error) { send(response, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } });
}
