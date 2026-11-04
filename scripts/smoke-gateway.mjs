import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const services = [
  ["auth", 3101, "apps/auth-service/dist/main.js"],
  ["plot", 3102, "apps/plot-service/dist/main.js"],
  ["control", 3108, "apps/control-service/dist/main.js"],
  ["gateway", 8180, "apps/gateway-service/dist/main.js"],
];
const children = [];

function startService(name, port, entry) {
  const child = spawn(process.execPath, [path.join(root, entry)], {
    cwd: root,
    env: { ...process.env, SERVICE_MODE: "http", PORT: String(port) },
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
  };
  for (const [name, port, entry] of services) {
    if (name === "gateway") {
      const child = spawn(process.execPath, [path.join(root, entry)], { cwd: root, env: { ...process.env, ...gatewayEnv, SERVICE_MODE: "http", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

  console.log("真实多进程网关链路验证通过: login -> plots -> control confirmation");
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
