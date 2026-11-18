import { randomUUID } from "node:crypto";
import { CoverageError, parseCoverageRequest, planCoverage } from "./coverage.js";
import type { CoverageInput, CoveragePlan } from "./coverage.js";

/**
 * 网格级变量播种/施肥规划（A15，开发方案 8.3/9.3）。
 *
 * 与 coverage 的分工：那边管「一块地怎么走完」，这边在同样的作业带上回答
 * 「每一带该下多少种/多少肥」。输入是覆盖规划入参 + A14 长势网格（遥测 IDW
 * 或多光谱反演样本），输出逐带速率表与用量汇总，路径里程口径与覆盖方案完全一致。
 *
 * 做法：
 * 1. 先按 coverage 铺带（方向/间距/蛇形/里程全部复用，不另算一套路径）；
 * 2. 沿每条作业带按网格分辨率等距采样，采样点落到长势网格最近格心取值——
 *    网格按格尺寸分桶哈希，lookup 只看 3×3 邻桶，带数×格数不做全量两两比；
 * 3. 格值归一后线性映射到 [minRate, maxRate]：invert 时低值高率（弱苗补肥），
 *    否则高值高率；采样未命中网格的点按基础速率兜底，不编造格值；
 * 4. 用量 = 速率 × 该带扫过面积（带长 × 幅宽），汇总给总用量与面积加权平均速率。
 *
 * 空网格降级：全部作业带按基础速率均一作业并给警告，与 A14「不编造长势」同一口径。
 */

export const VARIABLE_OPERATION_TYPES = ["SEEDING", "FERTILIZATION"] as const;
export type VariableOperationType = typeof VARIABLE_OPERATION_TYPES[number];

/** 长势网格单元格：center 为 [经度, 纬度]，与遥测 growth-grid 输出同形 */
export interface RateGridCell {
  center: number[];
  value: number;
}

export interface RateGrid {
  /** 格边长（米），决定沿带采样步长与分桶尺寸 */
  cellSizeM: number;
  minValue?: number | null;
  maxValue?: number | null;
  cells: RateGridCell[];
}

export interface VariableRateInput {
  coverage: CoverageInput;
  operationType: VariableOperationType;
  /** 网格对应的遥测指标编码，留痕用（如 canopyCoverage） */
  metric: string;
  /** 基础速率（公斤/亩）：未命中网格的采样点与空网格降级都用它 */
  baseRateKgMu: number;
  minRateKgMu: number;
  maxRateKgMu: number;
  /** true = 格值越低速率越高（弱苗补肥口径）；缺省高值高率 */
  invert?: boolean;
  rateGrid?: RateGrid;
}

export interface VariableLane {
  /** 与覆盖方案作业带顺序一一对应，从 1 开始 */
  index: number;
  pass: number;
  lengthM: number;
  /** 该带平均速率（公斤/亩） */
  rateKgMu: number;
  /** 该带扫过面积 = 带长 × 幅宽（亩） */
  areaMu: number;
  /** 该带用量 = 速率 × 面积（公斤） */
  amountKg: number;
  /** 沿带采样命中的格值均值；一个都没命中为 null */
  avgGridValue: number | null;
}

export interface VariableRatePlan {
  planId: string;
  plotCode: string;
  operationType: VariableOperationType;
  metric: string;
  invert: boolean;
  baseRateKgMu: number;
  minRateKgMu: number;
  maxRateKgMu: number;
  /** 覆盖路径本体：里程/耗时/覆盖倍数与单独规划完全一致 */
  coverage: CoveragePlan;
  lanes: VariableLane[];
  totalAmountKg: number;
  /** 面积加权平均速率 = 总用量 / 总扫过面积 */
  avgRateKgMu: number;
  workDistanceM: number;
  transferDistanceM: number;
  totalDistanceM: number;
  durationMin: number;
  warnings: string[];
}

/** 等距圆柱换算常数，与 coverage.ts / packages/shared 面积口径逐字相同 */
const METERS_PER_DEGREE_LAT = 110_540;
const METERS_PER_DEGREE_LNG = 111_320;
const SQUARE_METER_PER_MU = 666.6667;
/** 与 A14 网格上限同口径：一次方案最多消费 4000 格 */
const MAX_GRID_CELLS = 4000;

interface Plane {
  kx: number;
  ky: number;
  originLng: number;
  originLat: number;
}

/** 外环顶点均值重心建局部平面，与 coverage.ts planeOf 同一口径 */
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

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface BucketCell {
  x: number;
  y: number;
  value: number;
}

/** 格心按格尺寸分桶：采样点只查 3×3 邻桶取最近格心，避免带数×格数全量比 */
function buildBuckets(cells: RateGridCell[], plane: Plane, cellSizeM: number): Map<string, BucketCell[]> {
  const buckets = new Map<string, BucketCell[]>();
  for (const cell of cells) {
    const flat = toPlane(plane, Number(cell.center[0]), Number(cell.center[1]));
    const key = `${Math.floor(flat.x / cellSizeM)},${Math.floor(flat.y / cellSizeM)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push({ ...flat, value: cell.value });
    else buckets.set(key, [{ ...flat, value: cell.value }]);
  }
  return buckets;
}

function nearestValue(buckets: Map<string, BucketCell[]>, x: number, y: number, cellSizeM: number): number | null {
  const bx = Math.floor(x / cellSizeM);
  const by = Math.floor(y / cellSizeM);
  let best: BucketCell | null = null;
  let bestD2 = Infinity;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const cell of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
        const d2 = (cell.x - x) ** 2 + (cell.y - y) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = cell;
        }
      }
    }
  }
  // 超过一个格距的「最近」不算命中：网格边缘外按基础速率兜底
  if (!best || bestD2 > cellSizeM * cellSizeM) return null;
  return best.value;
}

export function planVariableRate(input: VariableRateInput): VariableRatePlan {
  if (!(input.baseRateKgMu >= 0)) throw new CoverageError("baseRateKgMu 需为非负数");
  if (!(input.minRateKgMu >= 0) || !(input.maxRateKgMu >= 0)) throw new CoverageError("minRateKgMu / maxRateKgMu 需为非负数");
  if (input.minRateKgMu > input.maxRateKgMu) throw new CoverageError("minRateKgMu 不能大于 maxRateKgMu");
  const coverage = planCoverage(input.coverage);
  const grid = input.rateGrid;
  const cells = (grid?.cells ?? []).filter((cell) => Array.isArray(cell.center) && Number.isFinite(Number(cell.center[0])) && Number.isFinite(Number(cell.center[1])) && Number.isFinite(cell.value));
  if (cells.length > MAX_GRID_CELLS) throw new CoverageError(`长势网格 ${cells.length} 格超过 ${MAX_GRID_CELLS} 格上限，请加大格边长`);
  const cellSizeM = grid?.cellSizeM ?? 10;
  if (!(cellSizeM > 0)) throw new CoverageError("rateGrid.cellSizeM 需为正数");

  const warnings: string[] = [...coverage.warnings];
  const invert = input.invert === true;
  const span = input.maxRateKgMu - input.minRateKgMu;
  if (span === 0) warnings.push("速率上下限相同，变量方案退化为均一速率作业");

  let buckets: Map<string, BucketCell[]> | null = null;
  let gridMin = 0;
  let gridMax = 0;
  if (cells.length === 0) {
    warnings.push(`无长势网格样本，全部作业带按基础速率 ${round(input.baseRateKgMu, 2)} 公斤/亩均一作业，等待遥测上报或接入多光谱反演`);
  } else {
    const plane = planeOf(input.coverage.boundary.coordinates);
    buckets = buildBuckets(cells, plane, cellSizeM);
    const values = cells.map((cell) => cell.value);
    gridMin = Number.isFinite(Number(grid?.minValue)) ? Number(grid?.minValue) : Math.min(...values);
    gridMax = Number.isFinite(Number(grid?.maxValue)) ? Number(grid?.maxValue) : Math.max(...values);
  }

  /** 格值 → 速率：归一后线性映射；格值均一时取区间中点，不偏向任一极端 */
  const rateOf = (value: number): number => {
    let ratio = gridMax > gridMin ? Math.min(1, Math.max(0, (value - gridMin) / (gridMax - gridMin))) : 0.5;
    if (invert) ratio = 1 - ratio;
    return input.minRateKgMu + span * ratio;
  };

  const plane = planeOf(input.coverage.boundary.coordinates);
  const lanes: VariableLane[] = [];
  let missedLanes = 0;
  let totalAmountKg = 0;
  let totalAreaMu = 0;
  for (const lane of coverage.lanes) {
    const head = lane.coordinates[0]!;
    const tail = lane.coordinates[1]!;
    const from = toPlane(plane, Number(head[0]), Number(head[1]));
    const to = toPlane(plane, Number(tail[0]), Number(tail[1]));
    // 沿带按格分辨率采样（至少首尾两点），未命中网格的点按基础速率兜底
    const steps = Math.max(2, Math.ceil(lane.lengthM / cellSizeM));
    let rateSum = 0;
    let valueSum = 0;
    let hits = 0;
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      const x = from.x + (to.x - from.x) * ratio;
      const y = from.y + (to.y - from.y) * ratio;
      const value = buckets ? nearestValue(buckets, x, y, cellSizeM) : null;
      if (value === null) rateSum += input.baseRateKgMu;
      else {
        rateSum += rateOf(value);
        valueSum += value;
        hits += 1;
      }
    }
    if (hits === 0) missedLanes += 1;
    const rateKgMu = round(rateSum / (steps + 1), 2);
    const areaMu = (lane.lengthM * coverage.implementWidthM) / SQUARE_METER_PER_MU;
    const amountKg = rateKgMu * areaMu;
    totalAmountKg += amountKg;
    totalAreaMu += areaMu;
    lanes.push({ index: lane.index, pass: lane.pass, lengthM: lane.lengthM, rateKgMu, areaMu: round(areaMu, 3), amountKg: round(amountKg, 2), avgGridValue: hits > 0 ? round(valueSum / hits, 2) : null });
  }
  if (buckets && missedLanes > 0) warnings.push(`${missedLanes} 条作业带未命中长势网格，按基础速率 ${round(input.baseRateKgMu, 2)} 公斤/亩兜底`);

  return {
    planId: randomUUID(),
    plotCode: input.coverage.plotCode,
    operationType: input.operationType,
    metric: input.metric,
    invert,
    baseRateKgMu: input.baseRateKgMu,
    minRateKgMu: input.minRateKgMu,
    maxRateKgMu: input.maxRateKgMu,
    coverage,
    lanes,
    totalAmountKg: round(totalAmountKg, 1),
    avgRateKgMu: totalAreaMu > 0 ? round(totalAmountKg / totalAreaMu, 2) : 0,
    workDistanceM: coverage.workDistanceM,
    transferDistanceM: coverage.transferDistanceM,
    totalDistanceM: coverage.totalDistanceM,
    durationMin: coverage.durationMin,
    warnings,
  };
}

export interface VariableRateParseResult {
  ok: boolean;
  errors: string[];
  input?: VariableRateInput;
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** HTTP 入参解析：覆盖部分复用 parseCoverageRequest，速率与网格一次说清 */
export function parseVariableRateRequest(body: Record<string, unknown>): VariableRateParseResult {
  const covered = parseCoverageRequest(body);
  const errors: string[] = [...covered.errors];

  const operationType = body.operationType === undefined ? "FERTILIZATION" : String(body.operationType);
  if (!VARIABLE_OPERATION_TYPES.includes(operationType as VariableOperationType)) errors.push("operationType 需为 SEEDING（变量播种）或 FERTILIZATION（变量施肥）");

  const metric = typeof body.metric === "string" ? body.metric.trim() : "";

  const baseRateKgMu = readNumber(body.baseRateKgMu);
  if (baseRateKgMu === null || baseRateKgMu < 0) errors.push("baseRateKgMu（基础速率，公斤/亩）必填且为非负数");
  const minRateKgMu = readNumber(body.minRateKgMu);
  if (minRateKgMu === null || minRateKgMu < 0) errors.push("minRateKgMu 必填且为非负数");
  const maxRateKgMu = readNumber(body.maxRateKgMu);
  if (maxRateKgMu === null || maxRateKgMu < 0) errors.push("maxRateKgMu 必填且为非负数");
  if (minRateKgMu !== null && maxRateKgMu !== null && minRateKgMu > maxRateKgMu) errors.push("minRateKgMu 不能大于 maxRateKgMu");

  const invert = body.invert === true;

  let rateGrid: RateGrid | undefined;
  if (body.rateGrid !== undefined && body.rateGrid !== null) {
    const raw = body.rateGrid as Record<string, unknown>;
    const cellSizeM = readNumber(raw.cellSizeM);
    const rawCells = Array.isArray(raw.cells) ? raw.cells : null;
    if (cellSizeM === null || cellSizeM <= 0 || cellSizeM > 100) errors.push("rateGrid.cellSizeM 需在 0~100 米之间");
    if (!rawCells) errors.push("rateGrid.cells 需为 [{ center: [经度, 纬度], value }] 数组");
    else if (rawCells.length > MAX_GRID_CELLS) errors.push(`rateGrid.cells 超过 ${MAX_GRID_CELLS} 格上限，请加大格边长`);
    else {
      const cells: RateGridCell[] = [];
      for (const item of rawCells) {
        const record = (item ?? {}) as Record<string, unknown>;
        const center = Array.isArray(record.center) ? record.center.map(Number) : [];
        const value = readNumber(record.value);
        if (center.length < 2 || !Number.isFinite(center[0]) || !Number.isFinite(center[1]) || value === null) {
          errors.push("rateGrid.cells 含非法格：center 需为 [经度, 纬度]，value 需为数字");
          break;
        }
        cells.push({ center: [center[0]!, center[1]!], value });
      }
      if (errors.length === 0 && cellSizeM !== null) {
        const minValue = readNumber(raw.minValue);
        const maxValue = readNumber(raw.maxValue);
        rateGrid = { cellSizeM, cells, ...(minValue !== null ? { minValue } : {}), ...(maxValue !== null ? { maxValue } : {}) };
      }
    }
  }

  if (errors.length > 0 || !covered.ok || !covered.input || baseRateKgMu === null || minRateKgMu === null || maxRateKgMu === null) return { ok: false, errors };
  const input: VariableRateInput = {
    coverage: covered.input,
    operationType: operationType as VariableOperationType,
    metric,
    baseRateKgMu,
    minRateKgMu,
    maxRateKgMu,
    invert,
    ...(rateGrid ? { rateGrid } : {}),
  };
  return { ok: true, errors: [], input };
}