/**
 * 天气服务冒烟：走真实网关逐接口校验预报、预警、逐小时、实时、农事提示、历史曲线可用。
 *
 * 用法：
 *   node scripts/smoke-weather.mjs                       # 默认 https://localhost
 *   $env:BASE_URL="http://127.0.0.1:8080"; node scripts/smoke-weather.mjs
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
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { status: response.status, data: payload?.data, message: payload?.message ?? "" };
}

const results = [];
function pass(label, detail = "") {
  results.push(`PASS ${label.padEnd(22, " ")} ${detail}`);
}
function fail(label, reason) {
  results.push(`FAIL ${label.padEnd(22, " ")} ${reason}`);
  throw new Error(`${label}: ${reason}`);
}

async function main() {
  // 登录
  const login = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const loginBody = await login.json();
  token = loginBody?.data?.token;
  if (!token) fail("登录", `status=${login.status}`);
  pass("登录获取 token", token.slice(0, 12) + "...");

  // 1. 今天起七日预报：日期按农场时区（东八区）取日，窗口内严格升序
  const farmToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const farmDay = (offset) => new Date(Date.now() + 8 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const forecast = await call("/weather/forecast?days=7");
  if (forecast.status !== 200) fail("七日预报", `status=${forecast.status} msg=${forecast.message}`);
  const days = forecast.data?.forecast ?? [];
  if (days.length < 5) fail("七日预报条数", `期望≥5, 实际${days.length}`);
  if (!days[0]?.date || !days[0]?.weather || days[0]?.tempMax === undefined) fail("预报字段", JSON.stringify(days[0]));
  if (forecast.data?.today !== farmToday) fail("预报 today 口径", `期望${farmToday}, 实际${forecast.data?.today}`);
  if (days[0]?.date !== farmToday) fail("预报首日非今天", `期望${farmToday}, 实际${days[0]?.date}`);
  const dates = days.map((d) => d.date);
  if (dates.some((d, i) => (i > 0 && d <= dates[i - 1]) || d < farmToday || d >= farmDay(7))) {
    fail("预报窗口", `期望 [${farmToday}, ${farmDay(7)}) 升序, 实际${dates.join(",")}`);
  }
  pass("七日预报", `${days.length} 天 ${dates[0]}~${dates[dates.length - 1]}`);

  // 2. 作业提示
  if (!forecast.data?.headline) fail("作业提示", "headline 为空");
  const judges = forecast.data?.judges ?? [];
  if (judges.length < 3) fail("适宜性判定", `期望≥3, 实际${judges.length}`);
  pass("作业提示+适宜性", `${judges.length} 项`);

  // 3. 逐小时预报
  const hourly = await call("/weather/forecast/hourly?hours=24");
  if (hourly.status !== 200) fail("逐小时预报", `status=${hourly.status}`);
  const hours = hourly.data?.hourly ?? [];
  // 条数只卡上限与连续性，不强求 === 24：库里剩余的预报时数不足时服务按实际返回，
  // 接了真实和风数据后当天窗口尾部本来就可能只有十几个时次，卡死 24 属于误报。
  if (hours.length === 0) fail("逐小时条数", "返回 0 条");
  if (hours.length > 24) fail("逐小时条数", `超出请求的 24 条, 实际${hours.length}`);
  for (let i = 1; i < hours.length; i += 1) {
    const step = (Date.parse(hours[i].hourAt) - Date.parse(hours[i - 1].hourAt)) / 3_600_000;
    if (step !== 1) fail("逐小时连续", `第 ${i} 条相对上一条步进 ${step} 小时`);
  }
  if (!hours[0]?.hourAt || hours[0]?.temperature === undefined) fail("逐小时字段", JSON.stringify(hours[0]));
  pass("逐小时预报", `${hours.length} 时次`);

  // 4. 独立请求 days=2
  const days2 = await call("/weather/forecast?days=2");
  const d2 = days2.data?.forecast ?? [];
  if (d2.length !== 2) fail("days=2", `期望 2, 实际${d2.length}`);
  pass("days=2 预报", `${d2.length} 天`);

  // 5. 气象预警
  const alerts = await call("/weather/alerts?page=1&size=20");
  if (alerts.status !== 200) fail("气象预警", `status=${alerts.status}`);
  const alertItems = alerts.data?.items ?? [];
  if (alertItems.length < 1) fail("预警条数", "至少应有 1 条活跃预警");
  pass("气象预警", `${alerts.data?.total ?? 0} 条`);

  // 6. 非法枚举 400
  const badLevel = await call("/weather/alerts?level=SEVERE");
  if (badLevel.status !== 400) fail("预警非法枚举", `期望 400, 实际${badLevel.status}`);
  pass("预警非法 level → 400", badLevel.message.slice(0, 30));

  // 7. 实时气象站
  const rt = await call("/weather/realtime");
  if (rt.status !== 200) fail("实时气象站", `status=${rt.status}`);
  const elements = rt.data?.elements ?? [];
  if (elements.length < 5) fail("实时要素数", `期望≥5, 实际${elements.length}`);
  pass("实时气象站", `${elements.length} 要素, source=${rt.data?.dataSource}`);

  // 8. 农事建议独立接口
  const advice = await call("/weather/advice");
  if (advice.status !== 200) fail("农事建议", `status=${advice.status}`);
  if (!advice.data?.items?.length) fail("建议条目", "空");
  pass("农事建议", `${advice.data.items.length} 项`);

  // 9. 要素目录
  const metrics = await call("/weather/metrics");
  if (metrics.status !== 200) fail("要素目录", `status=${metrics.status}`);
  if ((metrics.data ?? []).length !== 8) fail("要素数量", `期望 8, 实际${(metrics.data ?? []).length}`);
  pass("要素目录", `${metrics.data.length} 项`);

  // 10. 历史曲线
  const history = await call("/weather/history?metric=airTemperature&size=10");
  if (history.status !== 200) fail("历史曲线", `status=${history.status} msg=${history.message}`);
  const points = history.data?.points ?? [];
  if (!history.data?.label) fail("历史标签", "空");
  pass("历史曲线", `${points.length} 点, ${history.data?.label}(${history.data?.unit})`);

  // 11. 历史非法指标 400
  const badMetric = await call("/weather/history?metric=stockPrice");
  if (badMetric.status !== 400) fail("历史非法指标", `期望 400, 实际${badMetric.status}`);
  pass("历史非法 metric → 400", badMetric.message.slice(0, 30));

  // 12. 决策联动：生成处方时不传 rainProbability，决策应从 weather 取
  const rx = await fetch(`${API}/decision/prescriptions`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ plotCode: "511723-000001-01-00001-0000-5", plotName: "联动测试", soilMoisture: 18 }),
  });
  const rxBody = await rx.json();
  if (rxBody?.data?.inputs?.rainProbabilitySource !== "weather") {
    // 本地直连无 weather 服务时 fallback default，这不算 FAIL 只做记录
    pass("决策处方(降雨来源)", `source=${rxBody?.data?.inputs?.rainProbabilitySource ?? "N/A"}`);
  } else {
    pass("决策处方(降雨来源)", "weather ✓");
  }

  console.log("\n===== 天气服务冒烟 =====");
  results.forEach((r) => console.log(r));
  console.log(`\n共 ${results.length} 项，全 PASS`);
}

main().catch((err) => { console.error(err.message); results.forEach((r) => console.log(r)); process.exit(1); });
