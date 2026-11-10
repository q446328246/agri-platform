/**
 * 测试数据重置：清掉早期在地图上点出来的验证地块，再按「面积 = 边界几何」重建一组测试地块。
 *
 * 用法：
 *   pnpm seed:test-plots                                      # 默认 https://localhost
 *   BASE_URL=http://127.0.0.1:8080 node scripts/seed-test-plots.mjs
 *
 * 约定：
 * 1. 只走网关真实接口，与前端建档/编辑是同一条路径，落库结果就是页面上看到的结果；
 * 2. 面积一律用 @agri/shared 的 polygonAreaMu 现算，不写死申报值（口径见 packages/shared/src/area.ts）；
 * 3. 可重复执行：同名测试地块就地更新，不再新建档。plot_records 的 parcel_code 唯一约束不区分软删行，
 *    删掉再用同一编码建档会撞约束，所以重跑走 PUT；只有首次建档才申请新的编码段；
 * 4. 只动测试地块，迁移 010 的示范数据（parcel 段 00001~00012）不碰；
 * 5. 清理走接口即软删，与页面「删除」按钮一致，不做物理清理。
 */
import { polygonAreaMu, roundAreaMu } from "../packages/shared/dist/index.js";

const BASE = (process.env.BASE_URL ?? "https://localhost").replace(/\/+$/, "");
const API = `${BASE}/api/v1`;
// 边缘用镜像内自签证书，只有回环地址才放宽校验；BASE_URL 指向远端时保持正常证书校验
if (BASE.startsWith("https:") && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const NAME_PREFIX = "测试地块";
const FARM_ID = "farm-kaijiang-01";
const REMARK = "测试数据，由 scripts/seed-test-plots.mjs 生成，面积按边界几何现算";
/** 早期验证残留的名称无规律（测试 / 地块14 / 地块15），只能按编码点名清理 */
const LEGACY_CODES = [
  "511723-000001-01-54813-0000-A",
  "511723-000001-01-04211-0000-I",
  "511723-000001-01-09721-0000-M",
];
/** 迁移 010 的示范地块编码段，重置前后都必须还在 */
const DEMO_PARCELS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(5, "0"));

/**
 * 三块形状各异的测试田，都落在示范田南侧的空白带（纬度 ≤ 30.9784），
 * 不与迁移 010 的边界重叠；顶点为 CGCS2000 [经度, 纬度]，首尾闭合。
 */
const TEST_PLOTS = [
  {
    parcelName: `${NAME_PREFIX}一号`,
    soilType: "LOAM",
    plotType: "FIELD",
    plotStatus: "ACTIVE",
    currentCrop: "水稻",
    ring: [
      [107.4155, 30.9762],
      [107.4169, 30.9756],
      [107.4182, 30.9761],
      [107.4184, 30.9775],
      [107.417, 30.9782],
      [107.4157, 30.9776],
      [107.4155, 30.9762],
    ],
  },
  {
    parcelName: `${NAME_PREFIX}二号`,
    soilType: "CLAY",
    plotType: "FIELD",
    plotStatus: "ACTIVE",
    currentCrop: "玉米",
    ring: [
      [107.4205, 30.9764],
      [107.425, 30.9762],
      [107.4251, 30.9769],
      [107.4206, 30.9771],
      [107.4205, 30.9764],
    ],
  },
  {
    parcelName: `${NAME_PREFIX}三号`,
    soilType: "SAND",
    plotType: "ORCHARD",
    plotStatus: "FALLOW",
    currentCrop: "柑橘",
    ring: [
      [107.4274, 30.9758],
      [107.4284, 30.9753],
      [107.4294, 30.9757],
      [107.4297, 30.9765],
      [107.4293, 30.9773],
      [107.4283, 30.9776],
      [107.4274, 30.9771],
      [107.4271, 30.9764],
      [107.4274, 30.9758],
    ],
  },
];

let token = "";

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

async function listPlots() {
  const page = expect(await call("GET", "/plots?page=1&pageSize=200"), 200, "地块列表");
  if (!Array.isArray(page?.items)) throw new Error("地块列表响应缺少 items");
  if (page.total > page.items.length) throw new Error(`地块超过单页容量，需分页处理: total=${page.total}`);
  return page.items;
}

function assertDemoIntact(plots, label) {
  const missing = DEMO_PARCELS.filter((parcel) => !plots.some((plot) => plot.parcelCode?.split("-")[3] === parcel));
  if (missing.length) throw new Error(`${label}后示范地块缺失: ${missing.join(", ")}`);
}

/** 建档 body：面积由边界现算，其余档案字段与前端编辑页一致 */
function plotBody(spec, areaMu) {
  return {
    parcelName: spec.parcelName,
    areaMu,
    soilType: spec.soilType,
    plotType: spec.plotType,
    plotStatus: spec.plotStatus,
    currentCrop: spec.currentCrop,
    remark: REMARK,
    geom: { type: "Polygon", srid: 4490, coordinates: [spec.ring] },
  };
}

/** 首次建档才需要编码段：取 90000 以上的高段，避开示范数据的 00001~00012 */
async function register(spec, areaMu) {
  const start = 90000 + (Date.now() % 9000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parcel = String(90000 + ((start - 90000 + attempt) % 9000));
    const result = await call("POST", "/plots", {
      ...plotBody(spec, areaMu),
      region: "511723",
      farm: "000001",
      area: "01",
      parcel,
      farmId: FARM_ID,
    });
    if (result.status === 201) return result.data;
    // 软删行仍占着 parcel_code 唯一约束，换一段重试；其余错误直接抛出
    if (result.status === 400 && result.message.includes("duplicate key")) continue;
    expect(result, 201, `建档 ${spec.parcelName}`);
  }
  throw new Error(`${spec.parcelName} 找不到空闲的地块编码段`);
}

async function main() {
  token = expect(await call("POST", "/auth/login", { username: "admin", password: "admin123" }), 200, "登录")?.token;
  if (!token) throw new Error("登录响应缺少 token");

  const before = await listPlots();
  assertDemoIntact(before, "重置");

  // 清理：遗留编码，以及本脚本历史版本生成、当前清单里已不存在的同名地块
  const wanted = new Set(TEST_PLOTS.map((spec) => spec.parcelName));
  const stale = before.filter((plot) => LEGACY_CODES.includes(plot.parcelCode)
    || (String(plot.parcelName ?? "").startsWith(NAME_PREFIX) && !wanted.has(plot.parcelName)));
  for (const plot of stale) {
    expect(await call("DELETE", `/plots/${encodeURIComponent(plot.parcelCode)}`), 200, `删除 ${plot.parcelName}`);
  }

  const results = [];
  for (const spec of TEST_PLOTS) {
    const areaMu = roundAreaMu(polygonAreaMu(spec.ring));
    if (!(areaMu > 0)) throw new Error(`${spec.parcelName} 边界退化，算不出面积`);
    const existing = before.find((plot) => plot.parcelName === spec.parcelName);
    const plot = existing
      ? expect(await call("PUT", `/plots/${encodeURIComponent(existing.parcelCode)}`, plotBody(spec, areaMu)), 200, `更新 ${spec.parcelName}`)
      : await register(spec, areaMu);
    if (Number(plot.areaMu) !== areaMu) throw new Error(`${spec.parcelName} 面积与边界不符: ${plot.areaMu} != ${areaMu}`);
    results.push({ parcelCode: plot.parcelCode, parcelName: spec.parcelName, areaMu, vertices: spec.ring.length - 1, action: existing ? "更新" : "建档" });
  }

  // 回查：接口返回的面积不算数，落库后再读一次才是台账上的数
  const after = await listPlots();
  assertDemoIntact(after, "重置");
  for (const item of results) {
    const stored = after.find((plot) => plot.parcelCode === item.parcelCode);
    if (!stored) throw new Error(`${item.parcelName} 重置后查不到`);
    if (Number(stored.areaMu) !== item.areaMu) throw new Error(`${item.parcelName} 落库面积与边界不符: ${stored.areaMu} != ${item.areaMu}`);
  }
  if (after.some((plot) => LEGACY_CODES.includes(plot.parcelCode))) throw new Error("遗留测试地块未清理干净");

  const detail = results.map((item) => `${item.parcelName} ${item.vertices} 顶点 ${item.areaMu} 亩(${item.action})`).join("、");
  console.log(`测试数据重置完成: 清理 ${stale.length} 块；${detail}；活地块 ${after.length} 块，示范数据 12 块完好`);
}

main().catch((error) => {
  console.error("测试数据重置失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});