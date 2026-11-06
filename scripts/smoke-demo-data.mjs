/**
 * 演示数据冒烟：走真实网关逐页校验，确保每个业务页面登录后都有可用数据。
 *
 * 校验口径与前端页面对应：一张图/地块/片区（plot）、实时监控与四情（telemetry）、
 * 设备台账（iot）、农事任务（operation）、控制指令（control）、决策处方（decision）、
 * 视频（video）、消息（message）、投入产出（finance）、溯源（trace）、系统管理（auth/platform）。
 *
 * 用法：
 *   node scripts/smoke-demo-data.mjs                       # 默认 https://localhost
 *   $env:BASE_URL="http://127.0.0.1:8080"; node scripts/smoke-demo-data.mjs
 */
const BASE = (process.env.BASE_URL ?? "https://localhost").replace(/\/+$/, "");
const API = `${BASE}/api/v1`;
if (BASE.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const EAST_1 = "511723-000001-01-00001-0000-5";
const WEST_1 = "511723-000001-02-00005-0000-C";

let token = "";
const headers = () => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function call(path) {
  const response = await fetch(`${API}${path}`, { headers: headers() });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, data: payload?.data, message: payload?.message ?? "" };
}

/** 统一取数据条数：数组取长度，分页对象取 total，对象按键数计 */
function countOf(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    if (typeof data.total === "number") return data.total;
    if (Array.isArray(data.items)) return data.items.length;
    return Object.keys(data).length;
  }
  return data === null || data === undefined ? 0 : 1;
}

const results = [];
async function check(label, path, min) {
  const result = await call(path);
  if (result.status !== 200) throw new Error(`${label} 请求失败: ${path} status=${result.status} message=${result.message}`);
  const count = countOf(result.data);
  if (count < min) throw new Error(`${label} 数据不足: ${path} 期望≥${min}，实际 ${count}`);
  results.push(`PASS ${label.padEnd(14, " ")} ${String(count).padStart(5)} 条  GET ${path}`);
  return result.data;
}

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const session = await login.json();
  token = session?.data?.token;
  if (!token) throw new Error(`admin 登录失败 status=${login.status}`);
  results.push(`PASS 登录（admin）      1 条  POST /auth/login`);

  // 一张图与地块管理
  await check("地块列表", `/plots?page=1&size=50`, 12);
  await check("片区地图", "/zones/map", 3);
  await check("田间线路", "/plots/infra-lines", 10);
  await check("地块统计", "/plots/stats", 1);

  // 设备与实时监控
  await check("设备台账", "/devices", 12);
  const overview = await check("四情总览", "/telemetry/overview", 4);
  for (const [key, min] of [["latest", 20], ["alerts", 4], ["pests", 6], ["rules", 7]]) {
    const count = countOf(overview?.[key]);
    if (count < min) throw new Error(`四情总览缺少 ${key}：期望≥${min}，实际 ${count}`);
    results.push(`PASS 四情·${key.padEnd(9, " ")} ${String(count).padStart(5)} 条  GET /telemetry/overview → ${key}`);
  }
  await check("最新读数", `/telemetry/latest?deviceId=device-soil-003`, 8);
  await check("墒情曲线", `/telemetry/history/series?deviceId=device-soil-003&metric=soilMoisture`, 100);
  await check("风速曲线", `/telemetry/history/series?deviceId=device-weather-001&metric=windSpeed`, 100);
  await check("待处置告警", "/telemetry/alerts", 4);
  await check("虫情记录", "/telemetry/pests", 6);
  await check("气象预报", "/weather/forecast", 1);

  // 农事、控制与决策
  await check("农事任务", "/farm-tasks?page=1&size=20", 8);
  await check("控制指令", "/control/commands?page=1&size=20", 6);
  await check("决策规则", "/decision/rules", 5); // 服务默认 1 条 + 迁移 010 补 4 条
  await check("处方记录", "/decision/prescriptions?page=1&size=20", 4);

  // 视频、消息
  await check("摄像头", "/video/cameras?page=1&size=20", 4);
  await check("录像索引", "/video/recordings?page=1&size=20", 3);
  await check("消息中心", "/messages?page=1&size=20", 10);

  // 核算与溯源
  await check("投入产出", "/finance/entries", 90);
  const summary = await check("核算汇总", "/finance/summary", 1);
  if (!(summary?.input > 0) || !(summary?.output > 0)) throw new Error(`核算汇总金额异常: ${JSON.stringify(summary)}`);
  results.push(`PASS 核算金额      ${summary.input.toFixed(2)} 投入 / ${summary.output.toFixed(2)} 产出  GET /finance/summary`);
  await check("按地块核算", `/finance/entries?plotCode=${WEST_1}`, 6);
  await check("溯源档案", "/trace/records?page=1&size=50", 22);
  await check("按地块溯源", `/trace/records?plotCode=${EAST_1}&page=1&size=50`, 6);

  // 系统管理与演示账号
  await check("用户列表", "/auth/users?page=1&size=20", 5);
  await check("角色列表", "/platform/roles", 4);
  await check("权限目录", "/platform/permissions", 1);
  for (const username of ["agronomist", "operator01", "viewer01"]) {
    const response = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ username, password: "demo123" }),
    });
    const body = await response.json();
    if (response.status !== 200 || !body?.data?.token) throw new Error(`演示账号 ${username} 登录失败 status=${response.status} message=${body?.message}`);
    results.push(`PASS 登录（${username.padEnd(11, " ")}）  1 条  POST /auth/login`);
  }
  const disabled = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username: "temp01", password: "demo123" }),
  });
  if (disabled.status === 200) throw new Error("已停用账号 temp01 不应登录成功");
  results.push(`PASS 停用账号拦截  ${disabled.status}  POST /auth/login (temp01)`);

  console.log(results.join("\n"));
  console.log(`\nSMOKE PASS：${results.length} 项演示数据校验通过`);
}

main().catch((error) => {
  console.error(`SMOKE FAIL：${error instanceof Error ? error.message : String(error)}`);
  if (results.length) console.error(results.join("\n"));
  process.exitCode = 1;
});
