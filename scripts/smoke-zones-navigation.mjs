/**
 * 片区与田间导航冒烟：走真实网关，验证片区建档/划入/凸包、机耕道沿路导航与清理。
 *
 * 用法：
 *   node scripts/smoke-zones-navigation.mjs                       # 默认 https://localhost
 *   $env:BASE_URL="http://127.0.0.1:8080"; node scripts/smoke-zones-navigation.mjs
 */
const BASE = (process.env.BASE_URL ?? "https://localhost").replace(/\/+$/, "");
const API = `${BASE}/api/v1`;
if (BASE.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const zoneCode = `ZONE-SMOKE-${Date.now().toString(36).toUpperCase()}`;
const parcel = String(Date.now() % 100000).padStart(5, "0");
const DEMO_GEOM = {
  type: "Polygon",
  srid: 4490,
  coordinates: [[[107.4205, 30.9812], [107.4245, 30.9812], [107.4245, 30.9832], [107.4205, 30.9832], [107.4205, 30.9812]]],
};

let token = "";
const headers = (extra = {}) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, data: payload?.data, message: payload?.message ?? "" };
}

function expect(result, status, label) {
  if (result.status !== status) throw new Error(`${label} 状态码错误: expected=${status}, actual=${result.status}, message=${result.message}`);
  return result.data;
}

async function main() {
  const login = await call("POST", "/auth/login", { username: "admin", password: "admin123" });
  token = expect(login, 200, "登录")?.token;
  if (!token) throw new Error("登录响应缺少 token");

  // 迁移 009 自带的示例片区应已就绪
  const seeded = expect(await call("GET", "/zones/map"), 200, "示例片区");
  if (!Array.isArray(seeded) || !seeded.some((item) => item.zoneCode === "ZONE-01")) throw new Error("缺少迁移 009 的示例片区 ZONE-01");

  // 建档 + 重码冲突
  const created = expect(await call("POST", "/zones", { zoneCode, zoneName: "冒烟片区", color: "#00e676", description: "片区冒烟" }), 201, "新建片区");
  if (created.zoneCode !== zoneCode) throw new Error("新建片区未回写编码");
  expect(await call("POST", "/zones", { zoneCode, zoneName: "重复编码" }), 409, "重复片区编码");

  // 建一块带边界的地块并划入片区
  const plot = expect(await call("POST", "/plots", {
    region: "511723",
    farm: "000001",
    area: "01",
    parcel,
    parcelName: `导航冒烟地块 ${parcel}`,
    areaMu: 18.6,
    soilType: "PADDY_SOIL",
    farmId: "farm-kaijiang-01",
    geom: DEMO_GEOM,
  }), 201, "新建地块");
  const parcelCode = plot.parcelCode;
  const assigned = expect(await call("POST", `/zones/${zoneCode}/plots`, { parcelCode }), 200, "划入地块");
  if (assigned.zoneCode !== zoneCode) throw new Error("地块未写入片区归属");

  // 汇总与凸包：有成员后 plotCount/areaMu/hull 都应有值
  const zoneMap = expect(await call("GET", "/zones/map"), 200, "片区一张图");
  const summary = zoneMap.find((item) => item.zoneCode === zoneCode);
  if (!summary || summary.plotCount !== 1) throw new Error(`片区地块数异常: ${summary?.plotCount}`);
  if (Number(summary.areaMu) !== 18.6) throw new Error(`片区面积汇总异常: ${summary.areaMu}`);
  if (!summary.hull?.coordinates?.[0]?.length) throw new Error("片区缺少成员地块凸包");
  const filtered = expect(await call("GET", `/plots?zoneCode=${encodeURIComponent(zoneCode)}`), 200, "按片区过滤地块");
  if (filtered.total !== 1 || filtered.items[0]?.parcelCode !== parcelCode) throw new Error("按片区过滤地块结果异常");

  // 有归属地块时禁止删片区
  expect(await call("DELETE", `/zones/${zoneCode}`), 409, "有地块时删片区");

  // 导航：把示例机耕道作为路网，站点取地块中心附近两点
  const roads = expect(await call("GET", "/plots/infra-lines?lineType=ROAD"), 200, "机耕道");
  const roadNetwork = roads.filter((line) => Array.isArray(line.geom?.coordinates) && line.geom.coordinates.length >= 2).map((line) => line.geom);
  if (!roadNetwork.length) throw new Error("缺少 ROAD 管线，导航无法验证沿路口径");
  const plan = expect(await call("POST", "/operations/path-plan", {
    start: { code: "START", name: "农机库", lng: 107.4212, lat: 30.9818 },
    stops: [
      { code: parcelCode, name: "冒烟地块", lng: 107.4225, lat: 30.9822 },
      { code: "DEMO-EAST", name: "东侧站点", lng: 107.4300, lat: 30.9820 },
    ],
    speedKmh: 8,
    roadNetwork,
    returnToStart: true,
  }), 200, "导航规划");
  if (!plan?.planId) throw new Error("导航方案缺少 planId");
  if (plan.legs.length !== 3) throw new Error(`闭环作业应有 3 段里程，实际 ${plan.legs.length}`);
  if (!(plan.distanceM > 0) || !(plan.durationMin > 0)) throw new Error("导航里程或耗时异常");
  const history = expect(await call("GET", "/operations/path-plans"), 200, "导航历史");
  if (history[0]?.planId !== plan.planId) throw new Error("导航历史未记录最新方案");

  // 清理：移出地块 -> 删片区 -> 删地块
  expect(await call("DELETE", `/zones/${zoneCode}/plots/${encodeURIComponent(parcelCode)}`), 200, "移出地块");
  expect(await call("DELETE", `/zones/${zoneCode}`), 200, "删除片区");
  expect(await call("DELETE", `/plots/${encodeURIComponent(parcelCode)}`), 200, "删除地块");
  expect(await call("GET", `/zones/${zoneCode}`), 404, "删除后查询片区");

  console.log(`片区与导航冒烟通过: 建档/重码/划入/凸包/过滤/沿路导航(${plan.distanceM.toFixed(0)} 米, ${plan.durationMin.toFixed(0)} 分钟)/清理`);
}

main().catch((error) => {
  console.error("片区与导航冒烟失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
