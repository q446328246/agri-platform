import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";

interface Tenant { id: string; name: string; code: string; status: "ACTIVE" | "DISABLED" }
interface Role { id: string; name: string; code: string; permissions: string[] }
interface AuditLog { id: string; action: string; operator: string; resource: string; createdAt: string }
const tenants: Tenant[] = [{ id: "tenant-demo", name: "达州示范农场", code: "DAZHOU-DEMO", status: "ACTIVE" }];
const roles: Role[] = [{ id: "role-admin", name: "平台管理员", code: "admin", permissions: ["*"] }, { id: "role-agronomist", name: "农技人员", code: "agronomist", permissions: ["dashboard:read", "telemetry:read", "decision:read"] }];
const auditLogs: AuditLog[] = [];

function trace(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
function send<T>(response: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `PLATFORM-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }
function paged<T>(items: T[], query: URLSearchParams): PageResult<T> { const page = Math.max(1, Number(query.get("page") || 1)); const size = Math.min(200, Math.max(1, Number(query.get("size") || 20))); const start = (page - 1) * size; return { items: items.slice(start, start + size), total: items.length, page, size, pages: Math.ceil(items.length / size) }; }

export function createPlatformHttpServer(): Server { return createServer((request, response) => { const traceId = trace(request); const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { status: "ok", service: "platform" }, traceId); return; }
  if (request.method === "GET" && url.pathname === "/api/v1/platform/tenant") { const id = request.headers["x-tenant-id"]?.toString() || "tenant-demo"; send(response, 200, tenants.find((tenant) => tenant.id === id) ?? tenants[0], traceId); return; }
  if (request.method === "GET" && url.pathname === "/api/v1/platform/roles") { send(response, 200, paged(roles, url.searchParams), traceId); return; }
  if (request.method === "GET" && url.pathname === "/api/v1/platform/audit-logs") { send(response, 200, paged(auditLogs, url.searchParams), traceId); return; }
  send(response, 404, null, traceId, "接口不存在");
}); }
