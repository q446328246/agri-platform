import type { GeoPolygon } from "@agri/contracts";

/**
 * 地块内网格长势分布（A14，开发方案 6.2「按地块生成长势分布图」）。
 *
 * 输入是「带坐标的读数样本 + 地块边界」，输出是可直接铺到地图上的网格值面：
 * 1. 以边界外环重心为原点建等距圆柱平面局部坐标（换算常数与 coverage.ts / @agri/shared 面积口径逐字相同）；
 * 2. 按给定边长铺正方形网格，格心落在边界内（奇偶规则，内环缺口自动剔除）才参与插值；
 * 3. 每格用 IDW（反距离加权，幂 2）从样本插值：权重 1/d²，样本与格心重合时直接取该样本均值；
 * 4. 空样本不编造数据——返回空网格 + 降级提示，前端显示「等待上报」而不是假长势。
 *
 * 多光谱影像反演属 B 类外部算法：端点留了 samples 覆盖口，算法节点可直接给
 * 「坐标 + 反演值」样本替换设备读数，本模块不关心样本来源。
 */

/** 插值样本：坐标 + 指标值（来源可以是设备最新读数，也可以是 B 类反演结果） */
export interface GrowthSample {
  lng: number;
  lat: number;
  value: number;
  deviceId?: string;
}

export interface GrowthGridInput {
  plotCode: string;
  metric: string;
  boundary: GeoPolygon;
  /** 网格边长，米；默认 10 */
  cellSizeM?: number;
  samples: GrowthSample[];
}

export interface GrowthGridCell {
  /** 格心 [经度, 纬度] */
  center: number[];
  /** 网格四角 [lng, lat]，闭合环，前端直接画面 */
  corners: number[][];
  value: number;
}

export interface GrowthGrid {
  plotCode: string;
  metric: string;
  cellSizeM: number;
  /** 网格行列数（按边界包络盒铺，边界外的格被剔除） */
  rows: number;
  cols: number;
  cells: GrowthGridCell[];
  samples: GrowthSample[];
  minValue: number | null;
  maxValue: number | null;
  warnings: string[];
}

/** 前置条件错误，HTTP 层按 400 返回 */
export class GrowthGridError extends Error {}

/** 与 coverage.ts / packages/shared/src/area.ts 逐字相同，面积与距离不能两套口径 */
const METERS_PER_DEGREE_LAT = 110_540;
const METERS_PER_DEGREE_LNG = 111_320;
const DEFAULT_CELL_SIZE_M = 10;
const MIN_CELL_SIZE_M = 2;
const MAX_CELL_SIZE_M = 100;
/** 网格总数上限：小田块 2 米格也铺不满，防恶意小格把响应撑爆 */
const MAX_CELLS = 4000;
/** IDW 幂次：2 是惯例，近样本主导、远样本平滑 */
const IDW_POWER = 2;

interface Plane {
  kx: number;
  ky: number;
  originLng: number;
  originLat: number;
}

function planeOf(rings: number[][][]): Plane {
  const points = rings[0]!;
  let latSum = 0;
  let lngSum = 0;
  for (const point of points) {
    lngSum += Number(point[0]);
    latSum += Number(point[1]);
  }
  const originLat = latSum / points.length;
  return { kx: METERS_PER_DEGREE_LNG * Math.cos((originLat * Math.PI) / 180), ky: METERS_PER_DEGREE_LAT, originLng: lngSum / points.length, originLat };
}

function toPlane(plane: Plane, lng: number, lat: number): { x: number; y: number } {
  return { x: (lng - plane.originLng) * plane.kx, y: (lat - plane.originLat) * plane.ky };
}

function toLngLat(plane: Plane, x: number, y: number): number[] {
  return [Number((plane.originLng + x / plane.kx).toFixed(6)), Number((plane.originLat + y / plane.ky).toFixed(6))];
}

/** 奇偶规则判点是否在多边形内（含内环）：与 coverage 扫描线同一套几何口径 */
function pointInRings(rings: number[][][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = Number(ring[i]![0]);
      const yi = Number(ring[i]![1]);
      const xj = Number(ring[j]![0]);
      const yj = Number(ring[j]![1]);
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** IDW 插值：重合样本取均值，其余按 1/d² 加权；样本为空在调用侧已降级 */
function idw(plane: Plane, samples: Array<{ x: number; y: number; value: number }>, x: number, y: number): number {
  let weightSum = 0;
  let valueSum = 0;
  const coincident: number[] = [];
  for (const sample of samples) {
    const d2 = (sample.x - x) ** 2 + (sample.y - y) ** 2;
    if (d2 < 1e-6) {
      coincident.push(sample.value);
      continue;
    }
    const weight = 1 / d2 ** (IDW_POWER / 2);
    weightSum += weight;
    valueSum += weight * sample.value;
  }
  if (coincident.length > 0) return coincident.reduce((sum, value) => sum + value, 0) / coincident.length;
  return valueSum / weightSum;
}

export function planGrowthGrid(input: GrowthGridInput): GrowthGrid {
  const rings = input.boundary.coordinates;
  const malformed = rings.find((ring) => !Array.isArray(ring) || ring.length < 3);
  if (malformed !== undefined || rings.length === 0) throw new GrowthGridError("地块边界含顶点不足 3 个的环，无法铺网格");
  const cellSizeM = input.cellSizeM ?? DEFAULT_CELL_SIZE_M;
  if (!(cellSizeM >= MIN_CELL_SIZE_M && cellSizeM <= MAX_CELL_SIZE_M)) {
    throw new GrowthGridError(`cellSizeM 需在 ${MIN_CELL_SIZE_M}~${MAX_CELL_SIZE_M} 米之间`);
  }

  const plane = planeOf(rings);
  const flat = rings[0]!.map((point) => toPlane(plane, Number(point[0]), Number(point[1])));
  const minX = Math.min(...flat.map((point) => point.x));
  const maxX = Math.max(...flat.map((point) => point.x));
  const minY = Math.min(...flat.map((point) => point.y));
  const maxY = Math.max(...flat.map((point) => point.y));
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSizeM));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellSizeM));
  if (rows * cols > MAX_CELLS) throw new GrowthGridError(`网格 ${rows}×${cols} 超过 ${MAX_CELLS} 格上限，请加大 cellSizeM`);

  const warnings: string[] = [];
  const samples = input.samples.filter((sample) => Number.isFinite(sample.lng) && Number.isFinite(sample.lat) && Number.isFinite(sample.value));
  if (samples.length < input.samples.length) warnings.push(`${input.samples.length - samples.length} 个样本坐标或数值非法，已剔除`);

  const cells: GrowthGridCell[] = [];
  if (samples.length === 0) {
    // 空数据降级：不编造长势，返回空网格让前端显示「等待上报」
    warnings.push("该地块暂无可用读数样本，长势网格为空；等待设备上报或接入多光谱反演结果");
  } else {
    const flatSamples = samples.map((sample) => ({ ...toPlane(plane, sample.lng, sample.lat), value: sample.value }));
    const half = cellSizeM / 2;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cx = minX + (col + 0.5) * cellSizeM;
        const cy = minY + (row + 0.5) * cellSizeM;
        const centerLngLat = toLngLat(plane, cx, cy);
        if (!pointInRings(rings, centerLngLat[0]!, centerLngLat[1]!)) continue;
        const value = idw(plane, flatSamples, cx, cy);
        cells.push({
          center: centerLngLat,
          corners: [
            toLngLat(plane, cx - half, cy - half),
            toLngLat(plane, cx + half, cy - half),
            toLngLat(plane, cx + half, cy + half),
            toLngLat(plane, cx - half, cy + half),
            toLngLat(plane, cx - half, cy - half),
          ],
          value: round(value),
        });
      }
    }
    if (samples.length === 1) warnings.push("仅 1 个读数样本，整块地按该值均一显示，空间差异需更多监测点");
    if (cells.length === 0) warnings.push("边界内未铺出任何网格，请核对边界几何");
  }

  const values = cells.map((cell) => cell.value);
  return {
    plotCode: input.plotCode,
    metric: input.metric,
    cellSizeM,
    rows,
    cols,
    cells,
    samples,
    minValue: values.length > 0 ? Math.min(...values) : null,
    maxValue: values.length > 0 ? Math.max(...values) : null,
    warnings,
  };
}