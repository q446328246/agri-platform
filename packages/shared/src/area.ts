/**
 * 地块面积口径：后端服务与冒烟脚本侧的唯一实现。
 *
 * 与 apps/web/src/utils/geo.ts 的 ringAreaMu、infra/postgres/migrations/015_plot_area_from_boundary.sql
 * 三者必须逐位一致：顶点去重 → 去掉闭合点 → 平移到环重心 → 等距圆柱鞋带 → 平方米换算亩。
 * 前端绘制时要实时预览、落库后又要和台账对得上，所以不能改用 PostGIS 的椭球面积（差 0.1%~0.3%）。
 * TS 侧的漂移由 apps/web/test/geo.spec.ts 的一致性用例拦住，SQL 侧改算法时三处一起改。
 */

/** 每亩平方米数，与前端预览、迁移 015 取同一个近似值，不用 unit.ts 的无限小数 */
const SQUARE_METER_PER_MU = 666.6667;

/** 坐标点，至少两维；调用方负责维度顺序 */
type Point = readonly number[];

/** 去掉连续重复顶点与末尾闭合点：重复点会拉偏环重心纬度，进而改变 cos 缩放 */
function cleanRing(ring: ReadonlyArray<Point>): [number, number][] {
  const points: [number, number][] = [];
  for (const point of ring) {
    const lat = Number(point[0]);
    const lng = Number(point[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const last = points[points.length - 1];
    if (!last || last[0] !== lat || last[1] !== lng) points.push([lat, lng]);
  }
  const first = points[0];
  const tail = points[points.length - 1];
  if (points.length > 1 && first && tail && first[0] === tail[0] && first[1] === tail[1]) points.pop();
  return points;
}

/**
 * 环面积（亩），入参维度顺序为 [纬度, 经度]。
 * 先以环重心为原点投影到等距圆柱平面再做鞋带公式：逐点乘 cos(lat) 会让 107/30 量级的坐标项
 * 互相抵消，纬度稍有跨度就在真实面积上叠出几十个百分点的误差。
 */
export function ringAreaMu(ring: ReadonlyArray<Point>): number {
  const points = cleanRing(ring);
  if (points.length < 3) return 0;
  let latSum = 0;
  let lngSum = 0;
  for (const point of points) {
    latSum += point[0];
    lngSum += point[1];
  }
  const lat0 = latSum / points.length;
  const lng0 = lngSum / points.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [lat1, lng1] = points[i]!;
    const [lat2, lng2] = points[(i + 1) % points.length]!;
    const x1 = (lng1 - lng0) * kx;
    const y1 = (lat1 - lat0) * ky;
    const x2 = (lng2 - lng0) * kx;
    const y2 = (lat2 - lat0) * ky;
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total / 2) / SQUARE_METER_PER_MU;
}

/**
 * 多边形面积（亩），入参为 GeoJSON 维度顺序 [经度, 纬度]，可不闭合。
 * 顶点不足三个（去重后）返回 0；多环几何请逐环调用 ringAreaMu 后取最大环。
 */
export function polygonAreaMu(points: ReadonlyArray<Point>): number {
  return ringAreaMu(points.map((point) => [Number(point[1]), Number(point[0])]));
}

/** 落库口径：亩保留两位小数，与 plot_records.area_mu 的 NUMERIC(14,2) 一致 */
export function roundAreaMu(areaMu: number): number {
  return Number(areaMu.toFixed(2));
}