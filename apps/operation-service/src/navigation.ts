import type { GeoLineString } from "@agri/contracts";
import { randomUUID } from "node:crypto";

/**
 * 田间导航规划。
 *
 * 输入是起点与若干待访问地块（站点），输出访问顺序、分段里程与耗时，以及可直接
 * 叠加到一张图上的折线。两件事：
 * 1. 顺序：先按最近邻排一版，再用 2-opt 反向优化，避免「按列表顺序跑」造成的回头路；
 * 2. 里程：请求里带了机耕道折线时，把折点建成无向图跑 Dijkstra，按沿路距离算，
 *    站点离路太远（>300 米）则退回直线并给出提示——宁可少算，也不编造路网。
 *
 * 田间转移速度默认 8 km/h（拖拉机带农具的常见转场速度），可被请求覆盖。
 */

export interface NavPoint {
  lng: number;
  lat: number;
}

export interface NavStop extends NavPoint {
  code: string;
  name?: string;
}

export interface NavLeg {
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  distanceM: number;
  durationMin: number;
  /** 该段是否走机耕道，false 表示直线估算 */
  viaRoad: boolean;
}

export interface NavPlan {
  planId: string;
  /** 优化后的站点编码顺序 */
  order: string[];
  distanceM: number;
  durationMin: number;
  legs: NavLeg[];
  polyline: GeoLineString;
  warnings: string[];
}

export interface NavInput {
  start: NavStop;
  stops: NavStop[];
  speedKmh?: number;
  /** 机耕道折线，来自一张图加载的 ROAD 管线 */
  roadNetwork?: GeoLineString[];
  /** 是否返回起点（闭环作业） */
  returnToStart?: boolean;
}

const DEFAULT_SPEED_KMH = 8;
/** 站点与最近路网节点的允许吸附距离 */
const SNAP_LIMIT_M = 300;
const MAX_STOPS = 20;

/** 经纬度换算为米：等距圆柱近似，与管线长度估算保持同一口径 */
export function distanceM(a: NavPoint, b: NavPoint): number {
  const rad = Math.PI / 180;
  const midLat = ((a.lat + b.lat) / 2) * rad;
  const dx = (b.lng - a.lng) * 111_320 * Math.cos(midLat);
  const dy = (b.lat - a.lat) * 110_540;
  return Math.sqrt(dx * dx + dy * dy);
}

interface RoadSegment {
  from: string;
  to: string;
  fromPoint: NavPoint;
  toPoint: NavPoint;
  lengthM: number;
}

interface RoadGraph {
  nodes: Map<string, NavPoint>;
  edges: Map<string, Array<{ to: string; weight: number }>>;
  segments: RoadSegment[];
  /** 每条线段上已插入的虚拟节点，按沿线比例排序，用于把相邻虚拟点串成链 */
  splits: Map<RoadSegment, Array<{ t: number; key: string }>>;
}

function nodeKey(point: NavPoint): string {
  return `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
}

/** 折线折点建图：相邻折点一条无向边，边权为米；同时保留线段供站点投影吸附 */
export function buildRoadGraph(lines: GeoLineString[]): RoadGraph {
  const nodes = new Map<string, NavPoint>();
  const edges = new Map<string, Array<{ to: string; weight: number }>>();
  const segments: RoadSegment[] = [];
  const addNode = (point: NavPoint): string => {
    const key = nodeKey(point);
    if (!nodes.has(key)) {
      nodes.set(key, point);
      edges.set(key, []);
    }
    return key;
  };
  for (const line of lines) {
    for (let index = 1; index < line.coordinates.length; index += 1) {
      const from = line.coordinates[index - 1];
      const to = line.coordinates[index];
      if (!from || !to) continue;
      const fromPoint = { lng: Number(from[0]), lat: Number(from[1]) };
      const toPoint = { lng: Number(to[0]), lat: Number(to[1]) };
      if (![fromPoint.lng, fromPoint.lat, toPoint.lng, toPoint.lat].every(Number.isFinite)) continue;
      const fromKey = addNode(fromPoint);
      const toKey = addNode(toPoint);
      if (fromKey === toKey) continue;
      const weight = distanceM(fromPoint, toPoint);
      edges.get(fromKey)?.push({ to: toKey, weight });
      edges.get(toKey)?.push({ to: fromKey, weight });
      segments.push({ from: fromKey, to: toKey, fromPoint, toPoint, lengthM: weight });
    }
  }
  return { nodes, edges, segments, splits: new Map() };
}

/** 把点投影到线段上，返回垂足与沿线段的比例 */
function projectOnSegment(point: NavPoint, segment: RoadSegment): { t: number; foot: NavPoint; distance: number } {
  const scale = Math.cos((point.lat * Math.PI) / 180);
  const ax = segment.fromPoint.lng * scale;
  const ay = segment.fromPoint.lat;
  const bx = segment.toPoint.lng * scale;
  const by = segment.toPoint.lat;
  const px = point.lng * scale;
  const py = point.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const foot = t === 0 ? segment.fromPoint : t === 1 ? segment.toPoint : { lng: (ax + t * dx) / scale, lat: ay + t * dy };
  return { t, foot, distance: distanceM(point, foot) };
}

/**
 * 站点吸附到路网。
 *
 * 投影可能落在两个折点之间：此时在图上临时插一个虚拟节点，按比例拆开原边，
 * 这样稀疏折线也能沿路走，而不是「离折点远就退回直线」。
 */
function snapToGraph(graph: RoadGraph, point: NavPoint): { key: string; distance: number } | null {
  let best: { segment: RoadSegment; t: number; foot: NavPoint; distance: number } | null = null;
  for (const segment of graph.segments) {
    const projection = projectOnSegment(point, segment);
    if (!best || projection.distance < best.distance) best = { segment, ...projection };
  }
  if (!best) return null;
  if (best.t <= 0.001) return { key: best.segment.from, distance: best.distance };
  if (best.t >= 0.999) return { key: best.segment.to, distance: best.distance };

  const key = `virtual:${nodeKey(best.foot)}`;
  if (!graph.nodes.has(key)) {
    graph.nodes.set(key, best.foot);
    graph.edges.set(key, []);
    const splits = graph.splits.get(best.segment) ?? [];
    // 只与同线段上相邻的虚拟点/端点相连，保证链上的边长之和等于整段长度
    let leftKey = best.segment.from;
    let leftT = 0;
    let rightKey = best.segment.to;
    let rightT = 1;
    for (const item of splits) {
      if (item.t < best.t && item.t > leftT) {
        leftT = item.t;
        leftKey = item.key;
      }
      if (item.t > best.t && item.t < rightT) {
        rightT = item.t;
        rightKey = item.key;
      }
    }
    const leftWeight = (best.t - leftT) * best.segment.lengthM;
    const rightWeight = (rightT - best.t) * best.segment.lengthM;
    graph.edges.get(leftKey)?.push({ to: key, weight: leftWeight });
    graph.edges.get(key)?.push({ to: leftKey, weight: leftWeight });
    graph.edges.get(rightKey)?.push({ to: key, weight: rightWeight });
    graph.edges.get(key)?.push({ to: rightKey, weight: rightWeight });
    splits.push({ t: best.t, key });
    graph.splits.set(best.segment, splits);
  }
  return { key, distance: best.distance };
}

/** 单源最短路，节点量级是几十到几百，用线性取最小值即可 */
function shortestPath(graph: RoadGraph, from: string, to: string): { distance: number; keys: string[] } | null {
  if (from === to) return { distance: 0, keys: [from] };
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  while (true) {
    let current: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const [key, value] of dist) {
      if (visited.has(key) || value >= currentDistance) continue;
      current = key;
      currentDistance = value;
    }
    if (current === null) return null;
    if (current === to) break;
    visited.add(current);
    for (const edge of graph.edges.get(current) ?? []) {
      const next = currentDistance + edge.weight;
      if (next < (dist.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        dist.set(edge.to, next);
        prev.set(edge.to, current);
      }
    }
  }
  const keys: string[] = [to];
  let cursor = to;
  while (cursor !== from) {
    const parent = prev.get(cursor);
    if (!parent) return null;
    keys.unshift(parent);
    cursor = parent;
  }
  return { distance: dist.get(to) ?? 0, keys };
}

interface LegPath {
  points: NavPoint[];
  distanceM: number;
  viaRoad: boolean;
  /** 站点到路网的吸附距离，用于提示 */
  snapM: number;
}

function straightPath(from: NavPoint, to: NavPoint): LegPath {
  return { points: [from, to], distanceM: distanceM(from, to), viaRoad: false, snapM: 0 };
}

function roadPath(graph: RoadGraph | null, from: NavPoint, to: NavPoint): LegPath {
  if (!graph || graph.nodes.size === 0) return straightPath(from, to);
  const start = snapToGraph(graph, from);
  const end = snapToGraph(graph, to);
  if (!start || !end) return straightPath(from, to);
  const snapM = Math.max(start.distance, end.distance);
  if (snapM > SNAP_LIMIT_M) return { ...straightPath(from, to), snapM };
  const path = shortestPath(graph, start.key, end.key);
  if (!path) return { ...straightPath(from, to), snapM };
  const nodes: NavPoint[] = path.keys.map((key) => graph.nodes.get(key)).filter((node): node is NavPoint => node !== undefined);
  return {
    points: [from, ...nodes, to],
    distanceM: start.distance + path.distance + end.distance,
    viaRoad: true,
    snapM,
  };
}

/** 最近邻 + 2-opt：站点数上限 20，直接枚举反向片段即可 */
function optimizeOrder(cost: number[][]): number[] {
  const count = cost.length - 1;
  const visited = new Array<boolean>(count + 1).fill(false);
  visited[0] = true;
  const order: number[] = [];
  let current = 0;
  for (let step = 0; step < count; step += 1) {
    let next = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 1; candidate <= count; candidate += 1) {
      if (visited[candidate]) continue;
      const value = cost[current]?.[candidate] ?? Number.POSITIVE_INFINITY;
      if (value < best) {
        best = value;
        next = candidate;
      }
    }
    if (next === -1) break;
    visited[next] = true;
    order.push(next);
    current = next;
  }

  const pathCost = (sequence: number[]): number => {
    let total = 0;
    let from = 0;
    for (const index of sequence) {
      total += cost[from]?.[index] ?? Number.POSITIVE_INFINITY;
      from = index;
    }
    return total;
  };

  let bestOrder = [...order];
  let bestCost = pathCost(bestOrder);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < bestOrder.length - 1; i += 1) {
      for (let j = i + 1; j < bestOrder.length; j += 1) {
        const candidate = [...bestOrder];
        const segment = candidate.slice(i, j + 1).reverse();
        candidate.splice(i, j - i + 1, ...segment);
        const candidateCost = pathCost(candidate);
        if (candidateCost + 1e-6 < bestCost) {
          bestOrder = candidate;
          bestCost = candidateCost;
          improved = true;
        }
      }
    }
  }
  return bestOrder;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 生成导航方案；调用方需保证 stops 非空（HTTP 层已校验） */
export function planNavigation(input: NavInput): NavPlan {
  const speedKmh = input.speedKmh && input.speedKmh > 0 ? input.speedKmh : DEFAULT_SPEED_KMH;
  const graph = input.roadNetwork && input.roadNetwork.length > 0 ? buildRoadGraph(input.roadNetwork) : null;
  const stops = input.stops;
  const points: NavPoint[] = [input.start, ...stops];

  // 预计算两两代价：起点记为 0 号，站点 1..n
  const cost: number[][] = points.map((from) => points.map((to) => roadPath(graph, from, to).distanceM));
  const order = optimizeOrder(cost);
  const sequence = order;

  const route: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const index of sequence) {
    route.push({ from: cursor, to: index });
    cursor = index;
  }
  if (input.returnToStart) route.push({ from: cursor, to: 0 });

  const warnings: string[] = [];
  const legs: NavLeg[] = [];
  const coordinates: number[][] = [];
  let totalDistance = 0;

  for (const segment of route) {
    const fromPoint = points[segment.from];
    const toPoint = points[segment.to];
    if (!fromPoint || !toPoint) continue;
    const path = roadPath(graph, fromPoint, toPoint);
    totalDistance += path.distanceM;
    const fromStop = segment.from === 0 ? input.start : stops[segment.from - 1];
    const toStop = segment.to === 0 ? input.start : stops[segment.to - 1];
    const leg: NavLeg = {
      fromCode: segment.from === 0 ? "START" : fromStop?.code ?? `STOP-${segment.from}`,
      fromName: segment.from === 0 ? input.start.name ?? "起点" : fromStop?.name ?? fromStop?.code ?? "",
      toCode: segment.to === 0 ? "START" : toStop?.code ?? `STOP-${segment.to}`,
      toName: segment.to === 0 ? input.start.name ?? "起点" : toStop?.name ?? toStop?.code ?? "",
      distanceM: round(path.distanceM),
      durationMin: round(path.distanceM / ((speedKmh * 1000) / 60)),
      viaRoad: path.viaRoad,
    };
    legs.push(leg);
    if (!path.viaRoad && path.snapM > SNAP_LIMIT_M) {
      warnings.push(`站点 ${leg.toCode} 距机耕道 ${Math.round(path.snapM)} 米，按直线估算里程`);
    }
    for (const point of path.points) {
      const last = coordinates[coordinates.length - 1];
      if (last && last[0] === point.lng && last[1] === point.lat) continue;
      coordinates.push([Number(point.lng.toFixed(6)), Number(point.lat.toFixed(6))]);
    }
  }

  if (!graph) warnings.push("未提供机耕道，里程按直线距离估算");

  const plan: NavPlan = {
    planId: randomUUID(),
    order: sequence.map((index) => stops[index - 1]?.code ?? `STOP-${index}`),
    distanceM: round(totalDistance),
    durationMin: round(totalDistance / ((speedKmh * 1000) / 60)),
    legs,
    polyline: { type: "LineString", coordinates: coordinates.length >= 2 ? coordinates : [[input.start.lng, input.start.lat], [input.start.lng, input.start.lat]], srid: 4490 },
    warnings,
  };
  return plan;
}

function readPoint(value: unknown): NavPoint | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const lng = Number(record.lng);
  const lat = Number(record.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return { lng, lat };
}

export interface NavParseResult {
  ok: boolean;
  errors: string[];
  input?: NavInput;
}

/** HTTP 入参解析：把「缺字段/坐标越界/站点过多」一次说清，避免逐条报错 */
export function parseNavigationRequest(body: Record<string, unknown>): NavParseResult {
  const errors: string[] = [];
  const startPoint = readPoint(body.start);
  if (!startPoint) errors.push("start 需为 { lng, lat } 且坐标在合法范围内");
  const rawStops = Array.isArray(body.stops) ? body.stops : [];
  if (rawStops.length === 0) errors.push("stops 至少需要一个待访问站点");
  if (rawStops.length > MAX_STOPS) errors.push(`stops 最多 ${MAX_STOPS} 个`);
  const stops: NavStop[] = [];
  rawStops.forEach((item, index) => {
    const point = readPoint(item);
    const record = (item ?? {}) as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code.trim() : "";
    if (!point) errors.push(`第 ${index + 1} 个站点坐标非法`);
    if (code === "") errors.push(`第 ${index + 1} 个站点缺少 code`);
    if (point && code !== "") {
      const stop: NavStop = { code, lng: point.lng, lat: point.lat };
      if (typeof record.name === "string" && record.name !== "") stop.name = record.name;
      stops.push(stop);
    }
  });

  const speedKmh = body.speedKmh === undefined ? undefined : Number(body.speedKmh);
  if (speedKmh !== undefined && (!Number.isFinite(speedKmh) || speedKmh <= 0 || speedKmh > 60)) errors.push("speedKmh 需在 0~60 之间");

  const roadNetwork: GeoLineString[] = [];
  if (body.roadNetwork !== undefined) {
    if (!Array.isArray(body.roadNetwork)) errors.push("roadNetwork 需为 LineString 数组");
    else {
      for (const item of body.roadNetwork) {
        const record = (item ?? {}) as Partial<GeoLineString>;
        if (record.type !== "LineString" || !Array.isArray(record.coordinates) || record.coordinates.length < 2) continue;
        roadNetwork.push({ type: "LineString", coordinates: record.coordinates, srid: Number(record.srid ?? 4490) });
      }
      if (roadNetwork.length === 0) errors.push("roadNetwork 中没有可用的 LineString");
    }
  }

  if (errors.length > 0 || !startPoint) return { ok: false, errors };
  const input: NavInput = {
    start: { code: typeof (body.start as Record<string, unknown>)?.code === "string" ? String((body.start as Record<string, unknown>).code) : "START", name: typeof (body.start as Record<string, unknown>)?.name === "string" ? String((body.start as Record<string, unknown>).name) : "起点", lng: startPoint.lng, lat: startPoint.lat },
    stops,
  };
  if (speedKmh !== undefined) input.speedKmh = speedKmh;
  if (roadNetwork.length > 0) input.roadNetwork = roadNetwork;
  if (body.returnToStart === true) input.returnToStart = true;
  return { ok: true, errors: [], input };
}
