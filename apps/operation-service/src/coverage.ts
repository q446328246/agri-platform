import { randomUUID } from "node:crypto";
import { polygonAreaMu } from "@agri/shared";
import type { GeoLineString, GeoPolygon } from "@agri/contracts";

/**
 * 全地块覆盖式作业规划（牛耕式 / boustrophedon）。
 *
 * 与 path-plan 的分工：那边管「地块之间怎么走」，这边管「一块地内部怎么耕完」。
 * 输入是地块边界几何 + 农具幅宽，输出是可直接叠加到一张图的连续路径与作业统计。
 *
 * 做法：
 * 1. 以环重心为原点建等距圆柱平面局部坐标（换算常数与 `@agri/shared` 面积口径逐字相同），
 *    再按作业方向旋转成「沿作业带 / 垂直作业带」两轴，不在经纬度上直接算距离；
 * 2. 沿垂直轴按 `幅宽 - 重叠` 的间距逐条扫描线切多边形，用奇偶规则求交区间——
 *    奇偶规则同时吃内环，带池塘/房屋缺口的地块会自动跳过 hole，不必单独抠洞；
 * 3. 扫描线之间蛇形往返，同一条线被切成多段时按行进方向排先后；
 *    缺口小于半个幅宽的碎段并入前一段（跨过去比为此掉头划算），其余缺口一律保留，不编造连通；
 * 4. 里程分「作业里程（沿作业带）+ 转移里程（段间掉头连接与入场）」，分别按作业速度与转移速度计时。
 *
 * 作业方向默认自动挑：每 15° 试一个候选（作业带无向，180° 内足够），取总里程最小者——
 * 丘区地块的长边方向往往不是正南北，自动挑能省掉一截空转里程。
 */

export interface CoveragePoint {
  lng: number;
  lat: number;
}

export interface CoverageInput {
  plotCode: string;
  boundary: GeoPolygon;
  /** 农具一次走过的幅宽，米 */
  implementWidthM: number;
  /** 相邻作业带重叠，米；默认 0 */
  overlapM?: number;
  /** 作业方向，自正北顺时针度数；不传则自动挑总里程最小的方向 */
  headingDeg?: number;
  /** 作业速度 km/h，默认 6 */
  speedKmh?: number;
  /** 转移速度 km/h，默认 8（地头转弯与入场带农具的速度） */
  turnSpeedKmh?: number;
  /** 入场起点，给了才计入场转移里程 */
  start?: CoveragePoint;
  /** 地块台账面积（亩），用于覆盖倍数；不传则按外环几何现算 */
  areaMu?: number;
}

export interface CoverageLane {
  /** 作业顺序，从 1 开始 */
  index: number;
  /** 同一条扫描线上的第几段（地块含凹部或内环时一条线会有多段） */
  pass: number;
  /** 作业带两端，按行进顺序排列，[经度, 纬度] */
  coordinates: number[][];
  lengthM: number;
}

export interface CoveragePlan {
  planId: string;
  plotCode: string;
  /** 实际采用的作业方向，已归一到 0~180 */
  headingDeg: number;
  /** 方向是否为程序自动挑的（手工指定时为 false） */
  headingAuto: boolean;
  implementWidthM: number;
  overlapM: number;
  /** 相邻作业带中心线间距 = 幅宽 - 重叠 */
  laneSpacingM: number;
  laneCount: number;
  turnCount: number;
  lanes: CoverageLane[];
  workDistanceM: number;
  transferDistanceM: number;
  totalDistanceM: number;
  durationMin: number;
  areaMu: number;
  /** 按幅宽铺出的面积 / 地块面积：>1 有重复覆盖，<1 有漏作业 */
  coverageRatio: number;
  /** 连续路径（入场 + 作业带 + 掉头连接），可直接叠加地图 */
  path: GeoLineString;
  warnings: string[];
}

/** 覆盖规划的前置条件错误，HTTP 层按 400 返回 */
export class CoverageError extends Error {}

const DEFAULT_SPEED_KMH = 6;
const DEFAULT_TURN_SPEED_KMH = 8;
/** 等距圆柱换算常数，与 packages/shared/src/area.ts 逐字相同，面积与里程不能两套口径 */
const METERS_PER_DEGREE_LAT = 110_540;
const METERS_PER_DEGREE_LNG = 111_320;
/** 每亩平方米数，同样与面积口径取同一个近似值 */
const SQUARE_METER_PER_MU = 666.6667;
/** 自动挑方向时的角度步长：作业带无向，180° 内取 12 个候选 */
const HEADING_STEP_DEG = 15;
const MAX_LANES = 2000;

interface Plane {
  kx: number;
  ky: number;
  originLng: number;
  originLat: number;
}

interface Axis {
  /** 沿作业带方向 */
  along: number;
  /** 垂直作业带方向（扫描推进方向） */
  across: number;
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

/** 平面坐标 → 经纬度：保留 6 位小数，与地块几何、折线输出同一精度 */
function toLngLat(plane: Plane, x: number, y: number): number[] {
  return [Number((plane.originLng + x / plane.kx).toFixed(6)), Number((plane.originLat + y / plane.ky).toFixed(6))];
}

function toPlane(plane: Plane, lng: number, lat: number): { x: number; y: number } {
  return { x: (lng - plane.originLng) * plane.kx, y: (lat - plane.originLat) * plane.ky };
}

/** 自正北顺时针的方位角 → 平面（东 x、北 y）单位向量 */
function headingVector(deg: number): { dx: number; dy: number } {
  const rad = (deg * Math.PI) / 180;
  return { dx: Math.sin(rad), dy: Math.cos(rad) };
}

/** 平面点 → (沿作业带, 垂直作业带)：垂直轴取方向向量右手法则，扫描线只依赖它单调 */
function toAxis(x: number, y: number, direction: { dx: number; dy: number }): Axis {
  return { along: x * direction.dx + y * direction.dy, across: -x * direction.dy + y * direction.dx };
}

/** 轴坐标 → 平面点，是 toAxis 的逆变换 */
function fromAxis(axis: Axis, direction: { dx: number; dy: number }): { x: number; y: number } {
  return { x: axis.along * direction.dx - axis.across * direction.dy, y: axis.along * direction.dy + axis.across * direction.dx };
}

function ringToEdges(ring: number[][], plane: Plane, direction: { dx: number; dy: number }): Array<[Axis, Axis]> {
  const vertices = ring.map((point) => {
    const flat = toPlane(plane, Number(point[0]), Number(point[1]));
    return toAxis(flat.x, flat.y, direction);
  });
  const edges: Array<[Axis, Axis]> = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const from = vertices[index]!;
    const to = vertices[(index + 1) % vertices.length]!;
    // 与扫描线平行的边不参与求交，否则除零
    if (from.across === to.across) continue;
    edges.push([from, to]);
  }
  return edges;
}

/** 扫描线与多边形（含内环）的交区间：奇偶规则，半开区间让顶点不被重复计数 */
function scanIntervals(edges: Array<[Axis, Axis]>, level: number): Array<[number, number]> {
  const crossings: number[] = [];
  for (const [from, to] of edges) {
    const low = Math.min(from.across, to.across);
    const high = Math.max(from.across, to.across);
    if (level < low || level >= high) continue;
    crossings.push(from.along + ((level - from.across) / (to.across - from.across)) * (to.along - from.along));
  }
  crossings.sort((a, b) => a - b);
  const intervals: Array<[number, number]> = [];
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const start = crossings[index]!;
    const end = crossings[index + 1]!;
    if (end - start > 0) intervals.push([start, end]);
  }
  return intervals;
}

/** 缺口小于半个幅宽的碎段并入前一段：跨过去的油耗远低于为此单独掉头 */
function mergeSlivers(intervals: Array<[number, number]>, mergeGapM: number): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start - last[1] < mergeGapM) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * 扫描线高度序列。
 *
 * 首条离边界半个间距，让最外侧作业带居中、两端留白均分；总宽不是间距整数倍时，
 * 余量过半就多条线，并把最后一条往回收 `spacing/2`，保证作业带整体落在地块内。
 */
function scanLevels(min: number, max: number, spacing: number): number[] {
  const extent = max - min;
  if (extent <= 0) return [min];
  const count = Math.max(1, Math.ceil(extent / spacing));
  const levels: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const level = min + (index + 0.5) * spacing;
    levels.push(level > max ? max - spacing / 2 : level);
  }
  return levels.filter((level, index, all) => index === 0 || level - all[index - 1]! > spacing / 4);
}

interface Band {
  level: number;
  /** 行进起点与终点的沿作业带坐标，start 不一定小于 end */
  start: number;
  end: number;
}

interface SweepResult {
  bands: Band[];
  workDistanceM: number;
  transferDistanceM: number;
  splitLines: number;
}

/** 按扫描线蛇形往返：偶数条线正向、奇数条线反向，同线多段沿用同一行进方向 */
function sweep(edges: Array<[Axis, Axis]>, levels: number[], spacing: number): SweepResult {
  const groups = levels
    .map((level) => ({ level, intervals: mergeSlivers(scanIntervals(edges, level), spacing / 2) }))
    .filter((group) => group.intervals.length > 0);

  const bands: Band[] = [];
  let workDistanceM = 0;
  let transferDistanceM = 0;
  let splitLines = 0;
  let cursor: { along: number; across: number } | null = null;

  groups.forEach((group, groupIndex) => {
    const forward = groupIndex % 2 === 0;
    if (group.intervals.length > 1) splitLines += 1;
    const ordered = forward ? group.intervals : [...group.intervals].reverse();
    for (const [left, right] of ordered) {
      const head = { along: forward ? left : right, across: group.level };
      const tail = { along: forward ? right : left, across: group.level };
      if (cursor) transferDistanceM += Math.hypot(head.along - cursor.along, head.across - cursor.across);
      bands.push({ level: group.level, start: head.along, end: tail.along });
      workDistanceM += Math.abs(tail.along - head.along);
      cursor = tail;
    }
  });

  return { bands, workDistanceM, transferDistanceM, splitLines };
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeHeading(deg: number): number {
  const value = deg % 180;
  return value < 0 ? value + 180 : value;
}

export function planCoverage(input: CoverageInput): CoveragePlan {
  // 顶点不足的环直接拒算而不是悄悄丢掉：内环被丢掉等于让拖拉机从塘里开过去
  const malformed = input.boundary.coordinates.find((ring) => !Array.isArray(ring) || ring.length < 3);
  if (malformed !== undefined || input.boundary.coordinates.length === 0) {
    throw new CoverageError("地块边界含顶点不足 3 个的环，无法铺作业带");
  }
  const rings = input.boundary.coordinates;
  if (!(polygonAreaMu(rings[0]!) > 0)) throw new CoverageError("地块边界退化成一条线（面积为 0），铺不出作业带");
  const plane = planeOf(rings);
  const spacing = input.implementWidthM - (input.overlapM ?? 0);
  if (spacing <= 0) throw new CoverageError("幅宽减去重叠必须为正，否则作业带没有间距");
  const speedKmh = input.speedKmh && input.speedKmh > 0 ? input.speedKmh : DEFAULT_SPEED_KMH;
  const turnSpeedKmh = input.turnSpeedKmh && input.turnSpeedKmh > 0 ? input.turnSpeedKmh : DEFAULT_TURN_SPEED_KMH;
  const headings = input.headingDeg === undefined
    ? Array.from({ length: Math.floor(180 / HEADING_STEP_DEG) }, (_, index) => index * HEADING_STEP_DEG)
    : [normalizeHeading(input.headingDeg)];

  let best: { heading: number; sweep: SweepResult; lanes: CoverageLane[]; path: number[][]; entryM: number; total: number } | null = null;
  for (const heading of headings) {
    const direction = headingVector(heading);
    const edges = rings.flatMap((ring) => ringToEdges(ring, plane, direction));
    if (edges.length === 0) continue;
    const across = edges.flatMap(([from, to]) => [from.across, to.across]);
    const levels = scanLevels(Math.min(...across), Math.max(...across), spacing);
    const swept = sweep(edges, levels, spacing);
    if (swept.bands.length === 0) continue;
    if (swept.bands.length > MAX_LANES) throw new CoverageError(`作业带 ${swept.bands.length} 条超过 ${MAX_LANES} 条上限，请核对幅宽是否填小`);

    const axisToPoint = (level: number, along: number): number[] => {
      const flat = fromAxis({ along, across: level }, direction);
      return toLngLat(plane, flat.x, flat.y);
    };
    const lanes: CoverageLane[] = [];
    const coordinates: number[][] = [];
    let entryM = 0;
    let lastLevel: number | null = null;
    let pass = 0;

    swept.bands.forEach((band, index) => {
      const head = axisToPoint(band.level, band.start);
      const tail = axisToPoint(band.level, band.end);
      if (index === 0 && input.start) {
        const entry = toPlane(plane, input.start.lng, input.start.lat);
        const first = fromAxis({ along: band.start, across: band.level }, direction);
        entryM = Math.hypot(first.x - entry.x, first.y - entry.y);
        coordinates.push([Number(input.start.lng.toFixed(6)), Number(input.start.lat.toFixed(6))]);
      }
      // 同一条扫描线上的多段共用一个 pass 序号，前端据此识别「回头」
      pass = band.level === lastLevel ? pass + 1 : 1;
      lastLevel = band.level;
      lanes.push({ index: index + 1, pass, coordinates: [head, tail], lengthM: round(Math.abs(band.end - band.start)) });
      for (const point of [head, tail]) {
        const last = coordinates[coordinates.length - 1];
        if (last && last[0] === point[0] && last[1] === point[1]) continue;
        coordinates.push(point);
      }
    });

    const total = swept.workDistanceM + swept.transferDistanceM + entryM;
    if (!best || total < best.total) best = { heading, sweep: swept, lanes, path: coordinates, entryM, total };
  }

  if (!best) throw new CoverageError("按给定幅宽铺不出任何作业带，请检查地块边界是否退化");
  const { heading, sweep: swept, lanes, path, entryM } = best;
  const transferDistanceM = swept.transferDistanceM + entryM;
  const areaMu = input.areaMu ?? Number(polygonAreaMu(rings[0]!).toFixed(2));
  const coverageRatio = areaMu > 0 ? (swept.workDistanceM * input.implementWidthM) / SQUARE_METER_PER_MU / areaMu : 0;

  const warnings: string[] = [];
  if ((input.overlapM ?? 0) > 0) warnings.push(`已预留 ${input.overlapM} 米重叠，实际按 ${round(spacing)} 米间距布带`);
  if (coverageRatio < 0.98) warnings.push(`按 ${input.implementWidthM} 米幅宽铺不满整块地（覆盖倍数 ${round(coverageRatio, 2)}），末端可能漏作业，请复核幅宽或换作业方向`);
  if (coverageRatio > 1.15) warnings.push(`作业带有重复覆盖（覆盖倍数 ${round(coverageRatio, 2)}），可加大间距或调小重叠`);
  if (swept.splitLines > 0) warnings.push(`${swept.splitLines} 条扫描线被地块凹部或内环切成多段，路径已按行进方向串接`);
  if (input.headingDeg === undefined) warnings.push(`作业方向由程序在 0°~${180 - HEADING_STEP_DEG}° 间按总里程最小自动选定，可改为手工指定`);

  return {
    planId: randomUUID(),
    plotCode: input.plotCode,
    headingDeg: round(heading, 0),
    headingAuto: input.headingDeg === undefined,
    implementWidthM: input.implementWidthM,
    overlapM: input.overlapM ?? 0,
    laneSpacingM: round(spacing),
    laneCount: lanes.length,
    turnCount: Math.max(0, lanes.length - 1) + (input.start ? 1 : 0),
    lanes,
    workDistanceM: round(swept.workDistanceM),
    transferDistanceM: round(transferDistanceM),
    totalDistanceM: round(swept.workDistanceM + transferDistanceM),
    durationMin: round(swept.workDistanceM / ((speedKmh * 1000) / 60) + transferDistanceM / ((turnSpeedKmh * 1000) / 60)),
    areaMu,
    coverageRatio: round(coverageRatio, 2),
    path: { type: "LineString", coordinates: path.length >= 2 ? path : [path[0] ?? [plane.originLng, plane.originLat], path[0] ?? [plane.originLng, plane.originLat]], srid: input.boundary.srid ?? 4490 },
    warnings,
  };
}

export interface CoverageParseResult {
  ok: boolean;
  errors: string[];
  input?: CoverageInput;
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** HTTP 入参解析：一次把「缺字段 / 幅宽非法 / 边界退化」说清，避免逐条试 */
export function parseCoverageRequest(body: Record<string, unknown>): CoverageParseResult {
  const errors: string[] = [];

  const plotCode = typeof body.plotCode === "string" ? body.plotCode.trim() : "";
  if (plotCode === "") errors.push("plotCode 不能为空");

  const rawBoundary = body.boundary as Partial<GeoPolygon> | undefined;
  let boundary: GeoPolygon | null = null;
  if (!rawBoundary || rawBoundary.type !== "Polygon" || !Array.isArray(rawBoundary.coordinates)) {
    errors.push('boundary 需为 { type: "Polygon", coordinates: [[[经度, 纬度]…]] }');
  } else {
    const rings = rawBoundary.coordinates
      .map((ring) => (ring ?? []).map((point): [number, number] => [Number(point?.[0]), Number(point?.[1])]))
      .filter((ring) => ring.length > 0);
    if (rings.length === 0) errors.push("boundary 外环顶点少于 3 个");
    else if (rings.some((ring) => ring.length < 3)) errors.push("boundary 含顶点不足 3 个的环，内环也要闭合");
    else if (!rings[0]!.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90)) errors.push("boundary 含非法坐标");
    else if (!(polygonAreaMu(rings[0]!) > 0)) errors.push("boundary 外环退化成一条线（面积为 0），铺不出作业带");
    else boundary = { type: "Polygon", coordinates: rings, srid: Number(rawBoundary.srid ?? 4490) };
  }

  const implementWidthM = readNumber(body.implementWidthM);
  if (implementWidthM === null) errors.push("implementWidthM（农具幅宽，米）必填且为数字");
  else if (implementWidthM <= 0 || implementWidthM > 50) errors.push("implementWidthM 需在 0~50 米之间");

  let overlapM = 0;
  if (body.overlapM !== undefined) {
    const parsed = readNumber(body.overlapM);
    if (parsed === null) errors.push("overlapM 需为数字");
    else if (parsed < 0 || parsed > 20) errors.push("overlapM 需在 0~20 米之间");
    else overlapM = parsed;
  }
  if (implementWidthM !== null && implementWidthM > 0 && overlapM >= implementWidthM) errors.push("overlapM 必须小于幅宽，否则作业带间距不为正");

  let headingDeg: number | undefined;
  if (body.headingDeg !== undefined) {
    const parsed = readNumber(body.headingDeg);
    if (parsed === null || parsed < 0 || parsed >= 360) errors.push("headingDeg 需在 0~360 之间（自正北顺时针）");
    else headingDeg = parsed;
  }

  let speedKmh: number | undefined;
  if (body.speedKmh !== undefined) {
    const parsed = readNumber(body.speedKmh);
    if (parsed === null || parsed <= 0 || parsed > 60) errors.push("speedKmh 需在 0~60 之间");
    else speedKmh = parsed;
  }
  let turnSpeedKmh: number | undefined;
  if (body.turnSpeedKmh !== undefined) {
    const parsed = readNumber(body.turnSpeedKmh);
    if (parsed === null || parsed <= 0 || parsed > 60) errors.push("turnSpeedKmh 需在 0~60 之间");
    else turnSpeedKmh = parsed;
  }

  let areaMu: number | undefined;
  if (body.areaMu !== undefined) {
    const parsed = readNumber(body.areaMu);
    if (parsed === null || parsed < 0) errors.push("areaMu 需为非负数字");
    else areaMu = parsed;
  }

  let start: CoveragePoint | undefined;
  if (body.start !== undefined) {
    const record = (body.start ?? {}) as Record<string, unknown>;
    const lng = readNumber(record.lng);
    const lat = readNumber(record.lat);
    if (lng === null || lat === null || lng < -180 || lng > 180 || lat < -90 || lat > 90) errors.push("start 需为 { lng, lat } 且坐标合法");
    else start = { lng, lat };
  }

  if (errors.length > 0 || !boundary || implementWidthM === null) return { ok: false, errors };
  const input: CoverageInput = { plotCode, boundary, implementWidthM };
  if (overlapM > 0) input.overlapM = overlapM;
  if (headingDeg !== undefined) input.headingDeg = headingDeg;
  if (speedKmh !== undefined) input.speedKmh = speedKmh;
  if (turnSpeedKmh !== undefined) input.turnSpeedKmh = turnSpeedKmh;
  if (start) input.start = start;
  if (areaMu !== undefined) input.areaMu = areaMu;
  return { ok: true, errors: [], input };
}
