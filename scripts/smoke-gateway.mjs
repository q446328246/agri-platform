import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const services = [
  ["auth", 3101, "apps/auth-service/dist/main.js"],
  ["plot", 3102, "apps/plot-service/dist/main.js"],
  ["control", 3108, "apps/control-service/dist/main.js"],
  ["platform", 3114, "apps/platform-service/dist/main.js"],
  ["gateway", 8180, "apps/gateway-service/dist/main.js"],
];
const children = [];

// auth 需要回查平台角色权限，冒烟环境端口与默认值不同，统一注入
const sharedEnv = {
  PLATFORM_SERVICE_URL: "http://127.0.0.1:3114",
  INTERNAL_TOKEN: "agri-internal",
};

function startService(name, port, entry) {
  const child = spawn(process.execPath, [path.join(root, entry)], {
    cwd: root,
    env: { ...process.env, ...sharedEnv, SERVICE_MODE: "http", PORT: String(port) },
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
  const gatewayEnv = {
    AUTH_SERVICE_URL: "http://127.0.0.1:3101",
    PLOT_SERVICE_URL: "http://127.0.0.1:3102",
    CONTROL_SERVICE_URL: "http://127.0.0.1:3108",
    PLATFORM_SERVICE_URL: "http://127.0.0.1:3114",
  };
  for (const [name, port, entry] of services) {
    if (name === "gateway") {
      const child = spawn(process.execPath, [path.join(root, entry)], { cwd: root, env: { ...process.env, ...sharedEnv, ...gatewayEnv, SERVICE_MODE: "http", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
      child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
      children.push(child);
    } else {
      startService(name, port, entry);
    }
  }
  for (const [, port] of services) await waitFor(`http://127.0.0.1:${port}/health`);

  const gateway = "http://127.0.0.1:8180/api/v1";
  const loginResponse = await fetch(`${gateway}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const login = await expectStatus(loginResponse, 200, "登录");
  if (!login.data?.token) throw new Error("登录响应缺少 token");
  if (!login.data.user?.permissions?.includes("*")) throw new Error("管理员登录响应缺少全量权限");

  // 未登录（即使伪造身份头）也不能访问业务接口
  const anonymous = await fetch(`${gateway}/plots`, { headers: { "x-user-id": login.data.user.id, "x-permissions": "*" } });
  const anonymousBody = await expectStatus(anonymous, 401, "未登录访问地块");
  if (anonymousBody.code !== "GATEWAY-401") throw new Error(`未登录响应码异常: ${anonymousBody.code}`);

  const plotsResponse = await fetch(`${gateway}/plots`, { headers: { authorization: `Bearer ${login.data.token}` } });
  const plots = await expectStatus(plotsResponse, 200, "地块查询");
  if (!Array.isArray(plots.data?.items)) throw new Error("地块查询响应缺少 items");

  const rejected = await fetch(`${gateway}/control/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${login.data.token}` },
    body: JSON.stringify({ deviceId: "device-soil-003", type: "IRRIGATION" }),
  });
  await expectStatus(rejected, 409, "未确认控制指令");

  const acceptedResponse = await fetch(`${gateway}/control/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${login.data.token}`, "x-user-id": login.data.user.id, "x-confirm-action": "CONFIRM" },
    body: JSON.stringify({ deviceId: "device-soil-003", type: "IRRIGATION", parameters: { duration: 5 } }),
  });
  const accepted = await expectStatus(acceptedResponse, 202, "已确认控制指令");
  if (accepted.data?.operatorId !== login.data.user.id || accepted.data?.status !== "QUEUED") throw new Error("控制指令响应未进入队列");

  // 系统管理：通过网关新建角色、按角色建用户、停用用户后登录被拒，最后清理
  const adminHeaders = { "content-type": "application/json", authorization: `Bearer ${login.data.token}`, "x-user-id": login.data.user.id };
  const roleCode = `smoke-role-${Date.now().toString(36)}`;
  const roleResponse = await fetch(`${gateway}/platform/roles`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "冒烟角色", code: roleCode, permissions: ["plot:read", "message:read"] }) });
  const role = await expectStatus(roleResponse, 201, "新建角色");

  const username = `smoke${Date.now().toString(36)}`;
  const userResponse = await fetch(`${gateway}/auth/users`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ username, name: "冒烟用户", password: "smoke123", roles: [role.data.code] }) });
  const user = await expectStatus(userResponse, 201, "新建用户");
  if (user.data?.roles?.[0] !== role.data.code) throw new Error("用户角色未按编码写入");

  const userLogin = await fetch(`${gateway}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "smoke123" }) });
  const userSession = await expectStatus(userLogin, 200, "新用户登录");
  // 登录响应应把角色权限合并进来，前端菜单才能按权限收口
  if (!userSession.data?.user?.permissions?.includes("plot:read")) throw new Error("登录响应未合并角色权限");

  // 角色只有 plot:read：读地块放行，写地块在网关就被拒绝
  const userRead = await fetch(`${gateway}/plots`, { headers: { authorization: `Bearer ${userSession.data.token}` } });
  await expectStatus(userRead, 200, "按角色读地块");
  const userWrite = await fetch(`${gateway}/plots`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userSession.data.token}` },
    body: JSON.stringify({ code: `P-SMOKE-AUTHZ-${Date.now()}`, name: "越权地块", areaMu: 1 }),
  });
  const userWriteBody = await expectStatus(userWrite, 403, "无写权限新建地块");
  if (userWriteBody.code !== "GATEWAY-403") throw new Error(`越权响应码异常: ${userWriteBody.code}`);

  const disableResponse = await fetch(`${gateway}/auth/users/${user.data.id}`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ status: "DISABLED" }) });
  await expectStatus(disableResponse, 200, "停用用户");
  const deniedLogin = await fetch(`${gateway}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "smoke123" }) });
  await expectStatus(deniedLogin, 403, "停用用户登录");

  const auditResponse = await fetch(`${gateway}/platform/audit-logs?keyword=role.create`, { headers: adminHeaders });
  const audit = await expectStatus(auditResponse, 200, "审计日志查询");
  if (!audit.data?.items?.some((item) => item.resource === `role:${role.data.id}`)) throw new Error("角色变更未写入审计日志");

  await expectStatus(await fetch(`${gateway}/auth/users/${user.data.id}`, { method: "DELETE", headers: adminHeaders }), 200, "删除用户");
  await expectStatus(await fetch(`${gateway}/platform/roles/${role.data.id}`, { method: "DELETE", headers: adminHeaders }), 200, "删除角色");

  console.log("真实多进程网关链路验证通过: login -> 401/403 拦截 -> plots -> control confirmation -> role/user management");
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
