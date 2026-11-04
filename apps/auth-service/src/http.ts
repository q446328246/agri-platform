import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";

interface User { id: string; username: string; password: string; name: string; roles: string[]; permissions: string[]; tenantId: string }
const users: User[] = [{ id: "user-admin", username: "admin", password: "admin123", name: "管理员", roles: ["admin"], permissions: ["*"], tenantId: "tenant-demo" }];
const sessions = new Map<string, { userId: string; expiresAt: number }>();
function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void { const body: ApiResponse<T> = { code: status >= 400 ? `AUTH-${status}` : "OK", message, data, traceId, timestamp: Date.now() }; res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function trace(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象"); return value as Record<string, unknown>; }
function safeUser(user: User): Omit<User, "password"> { const { password: _password, ...safe } = user; return safe; }
function authorized(request: IncomingMessage): User | null { const token = request.headers.authorization?.replace(/^Bearer\s+/i, ""); const session = token ? sessions.get(token) : undefined; if (!session || session.expiresAt < Date.now()) return null; return users.find((user) => user.id === session.userId) ?? null; }
export function createAuthHttpServer(): Server { return createServer(async (request, response) => { const traceId = trace(request); const url = new URL(request.url ?? "/", "http://localhost"); try {
  if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { status: "ok", service: "auth" }, traceId); return; }
  if (request.method === "POST" && url.pathname === "/api/v1/auth/login") { const body = await readJson(request); const user = users.find((item) => item.username === body.username && item.password === body.password); if (!user) { send(response, 401, null, traceId, "用户名或密码错误"); return; } const token = randomUUID(); sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7200000 }); send(response, 200, { token, expiresIn: 7200, user: safeUser(user) }, traceId); return; }
  if (request.method === "GET" && url.pathname === "/api/v1/auth/userinfo") { const user = authorized(request); if (!user) { send(response, 401, null, traceId, "未授权，请登录"); return; } send(response, 200, safeUser(user), traceId); return; }
  if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") { const token = request.headers.authorization?.replace(/^Bearer\s+/i, ""); if (token) sessions.delete(token); send(response, 200, null, traceId); return; }
  send(response, 404, null, traceId, "接口不存在");
} catch (error) { send(response, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败"); } }); }
