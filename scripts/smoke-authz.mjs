import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 权限校验冒烟：
 * 1. 网关：未登录 401、伪造身份头无效、按角色读放行/写拒绝；
 * 2. 服务侧：开启 AUTH_GUARD_MODE=enforce 后，直连地块服务缺身份 401、缺权限 403、有权限 200。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = { auth: 3201, platform: 3202, plot: 3203, gateway: 8280 };
const entries = {
  auth: "apps/auth-service/dist/main.js",
  platform: "apps/platform-service/dist/main.js",
  plot: "apps/plot-service/dist/main.js",
  gateway: "apps/gateway-service/dist/main.js",
};
const children = [];
const internalToken = "agri-internal";
const sharedEnv = {
  INTERNAL_TOKEN: internalToken,
  AUTH_SERVICE_URL: `http://127.0.0.1:${ports.auth}`,
  PLATFORM_SERVICE_URL: `http://127.0.0.1:${ports.platform}`,
  PLOT_SERVICE_URL: `http://127.0.0.1:${ports.plot}`,
};

function start(name, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, entries[name])], {
    cwd: root,
    env: { ...process.env, ...sharedEnv, ...extraEnv, SERVICE_MODE: "http", PORT: String(ports[name]) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  children.push(child);
}

async function waitFor(url) {
  const deadline = Date.now() + 15_000;
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

async function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} 状态码错误: expected=${expected}, actual=${response.status}, body=${await response.text()}`);
  }
  return response.json();
}

async function main() {
  for (const name of ["auth", "platform", "gateway"]) start(name);
  // 地块服务开启服务侧守卫，验证网关下发身份的可用性与直连越权拦截
  start("plot", { AUTH_GUARD_MODE: "enforce" });
  for (const port of Object.values(ports)) await waitFor(`http://127.0.0.1:${port}/health`);

  const gateway = `http://127.0.0.1:${ports.gateway}/api/v1`;
  const plotDirect = `http://127.0.0.1:${ports.plot}/api/v1`;

  const login = await expectStatus(
    await fetch(`${gateway}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) }),
    200,
    "管理员登录",
  );
  const adminHeaders = { "content-type": "application/json", authorization: `Bearer ${login.data.token}` };

  // 1. 网关入口校验
  const anonymous = await expectStatus(await fetch(`${gateway}/plots`, { headers: { "x-user-id": login.data.user.id, "x-permissions": "*" } }), 401, "未登录访问");
  if (anonymous.code !== "GATEWAY-401") throw new Error(`未登录响应码异常: ${anonymous.code}`);
  const anonymousAdmin = await expectStatus(await fetch(`${gateway}/auth/users`, { headers: { "x-user-id": login.data.user.id } }), 401, "未登录访问账号管理");
  if (anonymousAdmin.code !== "GATEWAY-401") throw new Error(`未登录响应码异常: ${anonymousAdmin.code}`);

  // 2. 按角色收口：新角色只有 plot:read
  const roleCode = `authz-${Date.now().toString(36)}`;
  const role = await expectStatus(
    await fetch(`${gateway}/platform/roles`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "鉴权冒烟角色", code: roleCode, permissions: ["plot:read"] }) }),
    201,
    "新建只读角色",
  );
  const username = `authz${Date.now().toString(36)}`;
  const user = await expectStatus(
    await fetch(`${gateway}/auth/users`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ username, name: "鉴权冒烟用户", password: "authz123", roles: [roleCode] }) }),
    201,
    "新建只读用户",
  );
  const session = await expectStatus(
    await fetch(`${gateway}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "authz123" }) }),
    200,
    "只读用户登录",
  );
  if (!session.data?.user?.permissions?.includes("plot:read")) throw new Error("登录响应未合并角色权限");
  if (session.data.user.permissions.includes("plot:write")) throw new Error("只读用户不应获得 plot:write");
  const readerHeaders = { "content-type": "application/json", authorization: `Bearer ${session.data.token}` };

  await expectStatus(await fetch(`${gateway}/plots`, { headers: readerHeaders }), 200, "只读用户查地块");
  const forbidden = await expectStatus(
    await fetch(`${gateway}/plots`, { method: "POST", headers: readerHeaders, body: JSON.stringify({ code: `P-SMOKE-AUTHZ-${Date.now()}`, name: "越权地块", areaMu: 1 }) }),
    403,
    "只读用户建地块",
  );
  if (forbidden.code !== "GATEWAY-403") throw new Error(`越权响应码异常: ${forbidden.code}`);

  // 管理员越权访问账号接口以外的系统权限由角色决定，这里确认管理员可用
  await expectStatus(await fetch(`${gateway}/auth/users?keyword=admin`, { headers: adminHeaders }), 200, "管理员查账号");

  // 3. 服务侧守卫：绕过网关直连地块服务
  await expectStatus(await fetch(`${plotDirect}/plots`), 401, "直连缺身份");
  await expectStatus(await fetch(`${plotDirect}/plots`, { headers: { "x-user-id": "user-forged" } }), 403, "直连缺权限");
  await expectStatus(await fetch(`${plotDirect}/plots`, { headers: { "x-user-id": "user-forged", "x-permissions": "plot:read" } }), 200, "直连带权限");
  await expectStatus(
    await fetch(`${plotDirect}/plots`, { method: "POST", headers: { "content-type": "application/json", "x-user-id": "user-forged", "x-permissions": "plot:read" }, body: JSON.stringify({ code: `P-SMOKE-DIRECT-${Date.now()}`, name: "直连越权", areaMu: 1 }) }),
    403,
    "直连写越权",
  );

  // 4. 清理
  await expectStatus(await fetch(`${gateway}/auth/users/${user.data.id}`, { method: "DELETE", headers: adminHeaders }), 200, "删除用户");
  await expectStatus(await fetch(`${gateway}/platform/roles/${role.data.id}`, { method: "DELETE", headers: adminHeaders }), 200, "删除角色");

  console.log("权限校验冒烟通过: 网关 401/403 拦截 + 角色权限合并 + 服务侧守卫");
}

async function cleanup() {
  for (const child of children.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  await delay(300);
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
}

try {
  await main();
} finally {
  await cleanup();
}
