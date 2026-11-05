import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 系统账号与角色落库冒烟。
 *
 * 以 SQL 模式启动 auth 与 platform，创建角色与用户后**重启两个进程**，
 * 再验证账号仍能登录、角色与审计日志仍在库中，最后清理测试数据。
 * 需要先执行 `pnpm db:migrate` 应用 004 迁移，并设置 DB_URL。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_PORT = 3301;
const PLATFORM_PORT = 3314;
const dbUrl = process.env.DB_URL;
if (!dbUrl) {
  console.error("SMOKE FAIL: 需要设置 DB_URL 指向已迁移的 PostgreSQL");
  process.exit(1);
}

const children = [];

function startService(name, port, entry) {
  const child = spawn(process.execPath, [path.join(root, entry)], {
    cwd: root,
    env: { ...process.env, DB_URL: dbUrl, SERVICE_MODE: "http", PORT: String(port), AUTH_REPOSITORY_MODE: "sql", PLATFORM_REPOSITORY_MODE: "sql" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  children.push(child);
  return child;
}

async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 服务仍在启动，继续轮询。
    }
    await delay(250);
  }
  throw new Error(`服务健康检查超时: ${url}`);
}

async function startAll() {
  startService("auth", AUTH_PORT, "apps/auth-service/dist/main.js");
  startService("platform", PLATFORM_PORT, "apps/platform-service/dist/main.js");
  await waitFor(`http://127.0.0.1:${AUTH_PORT}/health`);
  await waitFor(`http://127.0.0.1:${PLATFORM_PORT}/health`);
}

async function stopAll() {
  for (const child of children.splice(0).reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  await delay(600);
}

async function call(url, init = {}, expected = 200) {
  const response = await fetch(url, init);
  const raw = await response.text();
  if (response.status !== expected) throw new Error(`${init.method ?? "GET"} ${url} 状态码错误: expected=${expected}, actual=${response.status}, body=${raw}`);
  return raw ? JSON.parse(raw) : null;
}

function jsonHeaders(extra = {}) {
  return { "content-type": "application/json", ...extra };
}

const authBase = `http://127.0.0.1:${AUTH_PORT}/api/v1`;
const platformBase = `http://127.0.0.1:${PLATFORM_PORT}/api/v1`;
const roleCode = `smoke-identity-${Date.now().toString(36)}`;
const username = `smokeid${Date.now().toString(36)}`;

async function main() {
  await startAll();

  const login = await call(`${authBase}/auth/login`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ username: "admin", password: "admin123" }) });
  const token = login.data.token;
  const adminHeaders = jsonHeaders({ authorization: `Bearer ${token}`, "x-user-id": login.data.user.id });

  const role = await call(`${platformBase}/platform/roles`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "落库冒烟角色", code: roleCode, description: "smoke-identity", permissions: ["plot:read", "message:read"] }) }, 201);

  const user = await call(`${authBase}/auth/users`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ username, name: "落库冒烟用户", phone: "13900000000", password: "smoke123", roles: [role.data.code] }) }, 201);
  if (user.data.roles?.[0] !== role.data.code) throw new Error("用户角色未按编码写入");

  console.log("第一次启动：角色与用户已创建，开始重启服务验证落库……");
  await stopAll();
  await startAll();

  // 重启后：账号仍可登录、角色与审计日志仍在
  const userLogin = await call(`${authBase}/auth/login`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ username, password: "smoke123" }) });
  if (userLogin.data.user.roles?.[0] !== role.data.code) throw new Error("重启后用户角色丢失");

  const users = await call(`${authBase}/auth/users?keyword=${encodeURIComponent(username)}`, { headers: adminHeaders });
  if (users.data.total !== 1) throw new Error(`重启后账号查询异常: total=${users.data.total}`);

  const roles = await call(`${platformBase}/platform/roles?keyword=${encodeURIComponent(roleCode)}`, { headers: adminHeaders });
  if (roles.data.total !== 1 || roles.data.items[0]?.permissions?.length !== 2) throw new Error("重启后角色或权限丢失");

  const audit = await call(`${platformBase}/platform/audit-logs?keyword=role.create`, { headers: adminHeaders });
  if (!audit.data.items?.some((item) => item.resource === `role:${role.data.id}`)) throw new Error("重启后审计日志丢失");

  // 清理：删除账号与角色，保持脚本可重复执行
  await call(`${authBase}/auth/users/${user.data.id}`, { method: "DELETE", headers: adminHeaders });
  await call(`${platformBase}/platform/roles/${role.data.id}`, { method: "DELETE", headers: adminHeaders });
  const after = await call(`${authBase}/auth/users?keyword=${encodeURIComponent(username)}`, { headers: adminHeaders });
  if (after.data.total !== 0) throw new Error("测试账号清理失败");

  console.log("SMOKE PASS: 账号、角色、权限与审计日志均已落库，重启后仍可登录");
}

async function cleanup() {
  await stopAll();
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
}

try {
  await main();
} catch (error) {
  console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
