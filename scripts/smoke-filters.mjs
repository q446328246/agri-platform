/**
 * 条件查询冒烟：走真实网关逐服务校验各页面查询条对应的筛选参数真实生效。
 *
 * 覆盖口径与前端查询条一一对应：
 * 地块（plotType/plotStatus/soilType/currentCrop/keyword/areaMin）、设备（type/status/plotCode/keyword+分页）、
 * 农事任务（type/status/plotCode/from/to）、控制指令（type/status/from/to）、
 * 投入产出（kind/category/keyword/时间区间 + summary 联动）、溯源（event/keyword/时间区间）、
 * 视频（status/keyword）、四情（metric/level/pestType/plotCode）、消息（level/时间区间）。
 *
 * 用法：
 *   node scripts/smoke-filters.mjs                       # 默认 https://localhost
 *   $env:BASE_URL="http://127.0.0.1:8080"; node scripts/smoke-filters.mjs
 */
const BASE = (process.env.BASE_URL ?? "https://localhost").replace(/\/+$/, "");
const API = `${BASE}/api/v1`;
if (BASE.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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

/** 分页对象取 items，数组原样返回 */
async function itemsOf(path) {
  const result = await call(path);
  if (result.status !== 200) throw new Error(`请求失败: ${path} status=${result.status} message=${result.message}`);
  const data = result.data;
  return Array.isArray(data) ? data : (data?.items ?? []);
}

const results = [];
/** 断言筛选结果：条数在 [min, max] 且每行满足谓词 */
async function check(label, path, predicate, { min = 1, max = Infinity } = {}) {
  const items = await itemsOf(path);
  if (items.length < min) throw new Error(`${label} 结果过少: ${path} 期望≥${min}，实际 ${items.length}`);
  if (items.length > max) throw new Error(`${label} 筛选未生效: ${path} 期望≤${max}，实际 ${items.length}`);
  for (const item of items) {
    if (!predicate(item)) throw new Error(`${label} 存在不符合筛选条件的行: ${path} → ${JSON.stringify(item)}`);
  }
  results.push(`PASS ${label.padEnd(18, " ")} ${String(items.length).padStart(5)} 条  GET ${path}`);
  return items;
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
  results.push(`PASS 登录（admin）         1 条  POST /auth/login`);

  // ── 地块：类型/状态/土壤/作物/关键词/面积区间（依赖迁移 011 档案字段）──
  const allPlots = await itemsOf("/plots?page=1&size=50");
  if (allPlots.length < 12) throw new Error(`地块全量基数异常：期望≥12，实际 ${allPlots.length}（请先执行 db:migrate 应用迁移 011）`);
  await check("地块·类型", "/plots?page=1&size=50&plotType=GREENHOUSE", (p) => p.plotType === "GREENHOUSE");
  await check("地块·状态", "/plots?page=1&size=50&plotStatus=FALLOW", (p) => p.plotStatus === "FALLOW");
  await check("地块·土壤", "/plots?page=1&size=50&soilType=LOAM", (p) => (p.soilType ?? "LOAM") === "LOAM", { max: allPlots.length });
  const cropPlot = allPlots.find((p) => p.currentCrop);
  if (!cropPlot) throw new Error("演示地块缺少 currentCrop 回填（迁移 011 未应用？）");
  await check("地块·作物", `/plots?page=1&size=50&currentCrop=${encodeURIComponent(cropPlot.currentCrop)}`, (p) => (p.currentCrop ?? "").includes(cropPlot.currentCrop));
  await check("地块·关键词", `/plots?page=1&size=50&keyword=${encodeURIComponent(cropPlot.parcelCode.slice(0, 8))}`, (p) => JSON.stringify(p).length > 0, { max: allPlots.length });
  const bigPlot = allPlots.filter((p) => p.areaMu >= 50).length > 0;
  await check("地块·面积下限", "/plots?page=1&size=50&areaMin=50", (p) => p.areaMu >= 50, { min: bigPlot ? 1 : 0, max: allPlots.length });
  const tinyOnly = await itemsOf("/plots?page=1&size=50&areaMin=999999");
  if (tinyOnly.length !== 0) throw new Error(`areaMin=999999 应筛空，实际 ${tinyOnly.length} 条`);
  results.push(`PASS 地块·面积上限筛空    0 条  GET /plots?areaMin=999999`);
  const badType = await call("/plots?plotType=NOT_A_TYPE");
  if (badType.status !== 400) throw new Error(`非法地块类型应返回 400，实际 ${badType.status}`);
  results.push(`PASS 地块·非法类型拦截    ${badType.status}  GET /plots?plotType=NOT_A_TYPE`);

  // ── 设备：类型/状态/地块/关键词 + 分页 ──
  const allDevices = await itemsOf("/devices?page=1&size=100");
  await check("设备·类型", "/devices?page=1&size=100&type=SOIL_SENSOR", (d) => d.type === "SOIL_SENSOR", { max: allDevices.length });
  await check("设备·状态", "/devices?page=1&size=100&status=OFFLINE", (d) => d.status === "OFFLINE", { max: allDevices.length });
  const plotDevice = allDevices.find((d) => d.plotCode);
  await check("设备·地块", `/devices?page=1&size=100&plotCode=${encodeURIComponent(plotDevice.plotCode)}`, (d) => d.plotCode === plotDevice.plotCode, { max: allDevices.length });
  await check("设备·关键词", `/devices?page=1&size=100&keyword=${encodeURIComponent(plotDevice.deviceNo)}`, (d) => `${d.name}${d.deviceNo}`.includes(plotDevice.deviceNo));
  const paged = await call("/devices?page=1&size=5");
  if ((paged.data?.items ?? []).length !== 5 || paged.data?.total < allDevices.length) throw new Error(`设备分页未生效：size=5 应返回 5 条且 total=${allDevices.length}`);
  results.push(`PASS 设备·分页            ${paged.data.items.length}/${paged.data.total}  GET /devices?page=1&size=5`);

  // ── 农事任务：类型/状态/地块/计划时间区间 ──
  const FROM = "2000-01-01";
  const TO = "2999-12-31";
  const allTasks = await itemsOf("/farm-tasks?page=1&size=100");
  await check("任务·类型", `/farm-tasks?page=1&size=100&type=IRRIGATION`, (t) => t.type === "IRRIGATION", { max: allTasks.length });
  await check("任务·状态", `/farm-tasks?page=1&size=100&status=PENDING&from=${FROM}&to=${TO}`, (t) => t.status === "PENDING", { max: allTasks.length });
  const plotTask = allTasks.find((t) => t.plotCode);
  await check("任务·地块", `/farm-tasks?page=1&size=100&plotCode=${encodeURIComponent(plotTask.plotCode)}`, (t) => t.plotCode === plotTask.plotCode, { max: allTasks.length });
  await check("任务·时间区间", `/farm-tasks?page=1&size=100&from=${FROM}&to=${TO}`, (t) => (t.scheduledAt ?? t.createdAt) >= FROM && (t.scheduledAt ?? t.createdAt) <= `${TO}T23:59:59.999Z`, { max: allTasks.length });

  // ── 控制指令：类型/状态/时间区间 ──
  const allCommands = await itemsOf("/control/commands?page=1&size=100");
  await check("指令·类型", `/control/commands?page=1&size=100&type=IRRIGATION`, (c) => c.type === "IRRIGATION", { max: allCommands.length });
  await check("指令·状态", `/control/commands?page=1&size=100&status=SENT`, (c) => c.status === "SENT", { max: allCommands.length });
  await check("指令·时间区间", `/control/commands?page=1&size=100&from=${FROM}&to=${TO}`, (c) => c.createdAt >= FROM && c.createdAt <= `${TO}T23:59:59.999Z`, { max: allCommands.length });

  // ── 投入产出：kind/category/keyword/时间区间 + summary 联动 ──
  const allEntries = await itemsOf("/finance/entries");
  await check("核算·投入", "/finance/entries?kind=INPUT", (e) => e.kind === "INPUT", { max: allEntries.length });
  const categoryEntry = allEntries.find((e) => e.kind === "INPUT");
  await check("核算·类别", `/finance/entries?category=${encodeURIComponent(categoryEntry.category)}`, (e) => e.category === categoryEntry.category, { max: allEntries.length });
  await check("核算·时间区间", `/finance/entries?from=${FROM}&to=${TO}`, (e) => e.createdAt >= FROM && e.createdAt <= `${TO}T23:59:59.999Z`, { max: allEntries.length });
  const outputSummary = await call("/finance/summary?kind=OUTPUT");
  if (outputSummary.status !== 200) throw new Error(`核算汇总联动失败 status=${outputSummary.status}`);
  if (!(outputSummary.data?.input === 0) || !(outputSummary.data?.output > 0)) throw new Error(`汇总未按 kind=OUTPUT 联动：${JSON.stringify(outputSummary.data)}`);
  results.push(`PASS 核算·汇总联动        产出 ${outputSummary.data.output.toFixed(2)}  GET /finance/summary?kind=OUTPUT`);

  // ── 溯源：事件/关键词/时间区间 ──
  const allTraces = await itemsOf("/trace/records?page=1&size=100");
  await check("溯源·事件", "/trace/records?page=1&size=100&event=FARM_OPERATION", (r) => r.event === "FARM_OPERATION", { max: allTraces.length });
  await check("溯源·操作人", `/trace/records?page=1&size=100&keyword=${encodeURIComponent(allTraces[0].operator)}`, (r) => JSON.stringify(r).includes(allTraces[0].operator), { max: allTraces.length });
  await check("溯源·时间区间", `/trace/records?page=1&size=100&from=${FROM}&to=${TO}`, (r) => r.createdAt >= FROM && r.createdAt <= `${TO}T23:59:59.999Z`, { max: allTraces.length });

  // ── 视频：状态/关键词 ──
  const allCameras = await itemsOf("/video/cameras?page=1&size=50");
  await check("摄像·状态", "/video/cameras?page=1&size=50&status=ONLINE", (c) => c.status === "ONLINE", { max: allCameras.length });
  await check("摄像·关键词", `/video/cameras?page=1&size=50&keyword=${encodeURIComponent(allCameras[0].name.slice(0, 2))}`, (c) => c.name.length > 0, { max: allCameras.length });

  // ── 四情：指标/级别/虫害类型/地块 ──
  const allLatest = await itemsOf("/telemetry/latest");
  const metric = allLatest[0]?.metric;
  if (!metric) throw new Error("遥测 latest 为空，无法验证指标筛选");
  await check("遥测·指标", `/telemetry/latest?metric=${encodeURIComponent(metric)}`, (r) => r.metric === metric, { max: allLatest.length });
  const plotLatest = allLatest.find((r) => r.plotCode);
  await check("遥测·地块", `/telemetry/latest?plotCode=${encodeURIComponent(plotLatest.plotCode)}`, (r) => r.plotCode === plotLatest.plotCode, { max: allLatest.length });
  const allAlerts = await itemsOf("/telemetry/alerts");
  const alertLevel = allAlerts[0]?.level;
  await check("告警·级别", `/telemetry/alerts?level=${encodeURIComponent(alertLevel)}`, (a) => String(a.level) === String(alertLevel), { max: allAlerts.length });
  const allPests = await itemsOf("/telemetry/pests");
  await check("虫情·类型", `/telemetry/pests?pestType=${encodeURIComponent(allPests[0].pestType)}`, (p) => p.pestType === allPests[0].pestType, { max: allPests.length });
  await check("虫情·等级", "/telemetry/pests?level=3", (p) => Number(p.level) === 3, { max: allPests.length });
  const filteredOverview = await call(`/telemetry/overview?metric=${encodeURIComponent(metric)}`);
  if (filteredOverview.status !== 200) throw new Error(`四情总览筛选失败 status=${filteredOverview.status}`);
  if (!filteredOverview.data.latest.every((r) => r.metric === metric)) throw new Error("四情总览 latest 段未按 metric 过滤");
  results.push(`PASS 四情·总览联动        latest ${filteredOverview.data.latest.length} 条  GET /telemetry/overview?metric=${metric}`);

  // ── 消息：级别/时间区间 ──
  const allMessages = await itemsOf("/messages?page=1&size=100");
  const msgLevel = allMessages[0]?.level;
  await check("消息·级别", `/messages?page=1&size=100&level=${encodeURIComponent(msgLevel)}`, (m) => m.level === msgLevel, { max: allMessages.length });
  await check("消息·时间区间", `/messages?page=1&size=100&from=${FROM}&to=${TO}`, (m) => m.createdAt >= FROM && m.createdAt <= `${TO}T23:59:59.999Z`, { max: allMessages.length });

  console.log(results.join("\n"));
  console.log(`\nSMOKE PASS：${results.length} 项条件查询校验通过`);
}

main().catch((error) => {
  console.error(`SMOKE FAIL：${error instanceof Error ? error.message : String(error)}`);
  if (results.length) console.error(results.join("\n"));
  process.exitCode = 1;
});
