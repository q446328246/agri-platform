import type { GeoPolygon } from "@agri/contracts";

/**
 * 拖拉机作业安全验证算法（B2）。
 *
 * 两道防线：
 * 1. 作业前预检：设备、绑定、地块、在途互斥、RTK 质量五道门全部通过才允许排程；
 * 2. 作业期监测：RTK 轨迹逐点与地块边界做围栏判定，越界即暂停、再越界即急停；
 *    RTK 质量劣化、通信失联同样触发处置（由 monitor 消费本模块的判定结果）。
 */

/** 预检门结果 */
export interface SafetyGateResult {
  gate: string;
  passed: boolean;
  message: string;
}

/** 预检输入：由组合根从各服务实时取数后组装 */
export interface SafetyPrecheckInput {
  /** 设备档案：null 表示设备不存在 */
  device: { type: string; status: string; plotCode?: string } | null;
  /** 地块档案：null 表示地块不存在 */
  plot: { status: string; hasBoundary: boolean; boundaryValid: boolean } | null;
  /** 设备台账绑定的地块是否与本次作业地块一致 */
  deviceBoundToPlot: boolean;
  /** 该设备是否存在在途作业指令（控制侧互锁） */
  inTransitJob: boolean;
  /** 最新 RTK 定位质量、位置与采样时刻 */
  rtkQuality: { hdop?: number; hasFix?: boolean; lng?: number; lat?: number; recordedAt?: string } | null;
  /** RTK 当前位置是否位于带安全余量的多边形内 */
  positionInside: boolean;
  /** 返航等非作业阶段不要求仍在原地块内；其余安全门不变 */
  requirePositionInside?: boolean;
}

export interface SafetyOptions {
  /** RTK 水平精度门限（HDOP），超过则拒绝精准作业，缺省 2.0 */
  rtkHdopMax?: number;
  /** RTK 采样最大有效时长（秒），缺省 30 秒 */
  rtkMaxAgeSeconds?: number;
  /** 判定时刻，测试可注入 */
  nowMs?: number;
}

export interface RtkMetricSample {
  value: number;
  recordedAt: string;
}

/**
 * 四个 RTK 指标必须来自同一采样时刻才可拼成有效定位。
 * rtkFix=0（或缺失/非有限值）不是有效 fix，不能因“指标存在”而放行。
 */
export function buildValidRtkSample(metrics: {
  lng: RtkMetricSample | null;
  lat: RtkMetricSample | null;
  hdop: RtkMetricSample | null;
  fix: RtkMetricSample | null;
}): { lng: number; lat: number; hdop: number; hasFix: boolean; recordedAt: string } | null {
  if (!metrics.lng || !metrics.lat || !metrics.hdop || !metrics.fix) return null;
  const values = [metrics.lng.value, metrics.lat.value, metrics.hdop.value, metrics.fix.value];
  if (!values.every(Number.isFinite)) return null;
  const recordedMs = [metrics.lng, metrics.lat, metrics.hdop, metrics.fix].map((metric) => Date.parse(metric.recordedAt));
  if (!recordedMs.every(Number.isFinite) || recordedMs.some((value) => value !== recordedMs[0])) return null;
  return {
    lng: metrics.lng.value,
    lat: metrics.lat.value,
    hdop: metrics.hdop.value,
    hasFix: metrics.fix.value > 0,
    recordedAt: metrics.lng.recordedAt,
  };
}

/**
 * 作业前预检：五道门逐项判定，全部通过才放行。
 * 任何一道不过都返回明确原因，供接口回给调用方与留安全事件。
 */
export function evaluatePrecheck(input: SafetyPrecheckInput, options: SafetyOptions = {}): { passed: boolean; gates: SafetyGateResult[] } {
  const hdopMax = options.rtkHdopMax ?? 2;
  const gates: SafetyGateResult[] = [];

  const deviceOk = input.device !== null && input.device.type === "AUTO_TRACTOR" && input.device.status === "ONLINE";
  gates.push({
    gate: "device",
    passed: deviceOk,
    message: deviceOk ? "设备为在线拖拉机" : input.device === null ? "设备不存在" : `设备需为在线拖拉机（当前 ${input.device.type}/${input.device.status}）`,
  });

  gates.push({
    gate: "binding",
    passed: input.deviceBoundToPlot,
    message: input.deviceBoundToPlot ? "设备已绑定作业地块" : "设备未绑定作业地块，拒绝作业",
  });

  const plotOk = input.plot !== null && input.plot.status === "ACTIVE" && input.plot.hasBoundary && input.plot.boundaryValid;
  gates.push({
    gate: "plot",
    passed: plotOk,
    message: plotOk ? "地块有效且边界可用" : input.plot === null ? "地块不存在" : `地块需为生效状态且边界完整（当前 ${input.plot.status}${input.plot.hasBoundary ? "" : "，边界缺失"}${input.plot.boundaryValid ? "" : "，多边形非法"}）`,
  });

  gates.push({
    gate: "interlock",
    passed: !input.inTransitJob,
    message: input.inTransitJob ? "设备存在在途作业指令，作业互锁拒绝" : "设备无在途作业",
  });

  const rtk = input.rtkQuality;
  const recordedMs = rtk?.recordedAt ? Date.parse(rtk.recordedAt) : NaN;
  const ageSeconds = (options.nowMs ?? Date.now()) - recordedMs;
  const rtkQualityOk = rtk !== null && rtk.hasFix === true && rtk.hdop !== undefined && Number.isFinite(rtk.hdop) && rtk.hdop <= hdopMax;
  const rtkFresh = Number.isFinite(recordedMs) && ageSeconds >= -60 && ageSeconds <= (options.rtkMaxAgeSeconds ?? 30) * 1000;
  const rtkPositionValid = rtk !== null && Number.isFinite(rtk.lng) && Number.isFinite(rtk.lat)
    && rtk.lng! >= -180 && rtk.lng! <= 180 && rtk.lat! >= -90 && rtk.lat! <= 90;
  const requirePositionInside = input.requirePositionInside ?? true;
  const rtkOk = rtkQualityOk && rtkFresh && rtkPositionValid && (!requirePositionInside || input.positionInside);
  let rtkMessage = rtk === null ? "无 RTK 定位数据，拒绝精准作业"
    : !rtkQualityOk ? `RTK 定位质量不达标（HDOP ${rtk.hdop ?? "缺测"}，门限 ${hdopMax}）`
      : !rtkFresh ? "RTK 定位采样已过期或时刻无效，拒绝精准作业"
        : !rtkPositionValid ? "RTK 经纬度无效，拒绝精准作业"
          : requirePositionInside && !input.positionInside ? "RTK 当前位置位于地块安全边界外，拒绝作业"
            : `RTK 定位质量达标（HDOP ${rtk.hdop}）`;
  gates.push({ gate: "rtk", passed: rtkOk, message: rtkMessage });

  return { passed: gates.every((gate) => gate.passed), gates };
}

/**
 * 射线法判定点是否在多边形环内（作业期围栏判定的内存实现，测试与降级路径使用）。
 * 环为 [lng, lat] 序列，与地块 geom 坐标口径一致。
 */
export function pointInRing(lng: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const crosses = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** 校验并提取 Polygon 全部环；外环不得自交，内环须完整位于外环且互不重叠。 */
export function polygonRingsOf(geom: GeoPolygon | null | undefined): Array<Array<[number, number]>> | null {
  if (geom?.type !== "Polygon" || !Array.isArray(geom.coordinates) || geom.coordinates.length === 0) return null;
  const rings: Array<Array<[number, number]>> = [];
  for (const rawRing of geom.coordinates) {
    if (!Array.isArray(rawRing) || rawRing.length < 4) return null;
    const ring: Array<[number, number]> = [];
    for (const point of rawRing) {
      if (!Array.isArray(point) || point.length < 2) return null;
      const lng = Number(point[0]);
      const lat = Number(point[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      ring.push([lng, lat]);
    }
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
    rings.push(ring);
  }
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex]!;
    const vertices = ring.slice(0, -1);
    for (let edge = 0; edge < vertices.length; edge += 1) {
      for (let other = edge + 1; other < vertices.length; other += 1) {
        if (other === edge + 1 || (edge === 0 && other === vertices.length - 1)) continue;
        if (segmentsIntersect(vertices[edge]!, vertices[(edge + 1) % vertices.length]!, vertices[other]!, vertices[(other + 1) % vertices.length]!)) return null;
      }
    }
    if (ringIndex > 0) {
      const outer = rings[0]!;
      if (ring.some(([lng, lat]) => !pointInRing(lng, lat, outer))) return null;
      for (let edge = 0; edge < ring.length; edge += 1) {
        for (let other = 0; other < outer.length; other += 1) {
          if (segmentsIntersect(ring[edge]!, ring[(edge + 1) % ring.length]!, outer[other]!, outer[(other + 1) % outer.length]!)) return null;
        }
      }
      for (const previous of rings.slice(1, ringIndex)) {
        if (ring.some(([lng, lat]) => pointInRing(lng, lat, previous)) || previous.some(([lng, lat]) => pointInRing(lng, lat, ring))) return null;
        for (let edge = 0; edge < ring.length; edge += 1) {
          for (let other = 0; other < previous.length; other += 1) {
            if (segmentsIntersect(ring[edge]!, ring[(edge + 1) % ring.length]!, previous[other]!, previous[(other + 1) % previous.length]!)) return null;
          }
        }
      }
    }
  }
  return rings;
}

/** 从地块几何提取外环坐标（空环返回 null） */
export function ringOf(geom: GeoPolygon | null | undefined): Array<[number, number]> | null {
  return polygonRingsOf(geom)?.[0] ?? null;
}

/** 点到线段的最小距离（经纬度坐标空间） */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

function segmentsProperlyIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const abC = orientation(a[0], a[1], b[0], b[1], c[0], c[1]);
  const abD = orientation(a[0], a[1], b[0], b[1], d[0], d[1]);
  const cdA = orientation(c[0], c[1], d[0], d[1], a[0], a[1]);
  const cdB = orientation(c[0], c[1], d[0], d[1], b[0], b[1]);
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  return segmentsProperlyIntersect(a, b, c, d)
    || (orientation(a[0], a[1], b[0], b[1], c[0], c[1]) === 0 && onSegment(a[0], a[1], b[0], b[1], c[0], c[1]))
    || (orientation(a[0], a[1], b[0], b[1], d[0], d[1]) === 0 && onSegment(a[0], a[1], b[0], b[1], d[0], d[1]))
    || (orientation(c[0], c[1], d[0], d[1], a[0], a[1]) === 0 && onSegment(c[0], c[1], d[0], d[1], a[0], a[1]))
    || (orientation(c[0], c[1], d[0], d[1], b[0], b[1]) === 0 && onSegment(c[0], c[1], d[0], d[1], b[0], b[1]));
}

function pointOnRingEdge(lng: number, lat: number, ring: Array<[number, number]>): boolean {
  return ring.some((point, index) => orientation(point[0], point[1], ring[(index + 1) % ring.length]![0], ring[(index + 1) % ring.length]![1], lng, lat) === 0
    && onSegment(point[0], point[1], ring[(index + 1) % ring.length]![0], ring[(index + 1) % ring.length]![1], lng, lat));
}

function pointInPolygonOrOuterBoundary(lng: number, lat: number, rings: Array<Array<[number, number]>>): boolean {
  return pointInPolygon(lng, lat, rings) || pointOnRingEdge(lng, lat, rings[0]!);
}

/** 整条折线必须位于多边形内；除端点外还检查线段，防止凹多边形内两端点之间穿出边界。 */
export function pathInsideRing(path: Array<[number, number]>, ring: Array<[number, number]>): boolean {
  return pathInsidePolygon(path, [ring]);
}

export function pointInPolygon(lng: number, lat: number, rings: Array<Array<[number, number]>>): boolean {
  if (rings.length === 0 || !pointInRing(lng, lat, rings[0]!)) return false;
  return !rings.slice(1).some((ring) => pointInRing(lng, lat, ring));
}

function segmentIntersectionParameters(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): number[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const ex = d[0] - c[0];
  const ey = d[1] - c[1];
  const denominator = dx * ey - dy * ex;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  if (denominator === 0) {
    if (orientation(a[0], a[1], b[0], b[1], c[0], c[1]) !== 0) return [];
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return [];
    const tc = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / lengthSq;
    const td = ((d[0] - a[0]) * dx + (d[1] - a[1]) * dy) / lengthSq;
    return [tc, td].filter((value) => value >= 0 && value <= 1);
  }
  const t = (qx * ey - qy * ex) / denominator;
  const u = (qx * dy - qy * dx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t] : [];
}

function segmentInsideOuterBoundary(a: [number, number], b: [number, number], rings: Array<Array<[number, number]>>): boolean {
  if (a[0] === b[0] && a[1] === b[1]) return true;
  const outer = rings[0]!;
  const cuts = [0, 1];
  for (let index = 0; index < outer.length; index += 1) {
    cuts.push(...segmentIntersectionParameters(a, b, outer[index]!, outer[(index + 1) % outer.length]!));
  }
  const sorted = [...new Set(cuts)].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    const start = sorted[index - 1]!;
    const end = sorted[index]!;
    if (start === end) continue;
    const t = (start + end) / 2;
    const lng = a[0] + (b[0] - a[0]) * t;
    const lat = a[1] + (b[1] - a[1]) * t;
    if (!pointInPolygonOrOuterBoundary(lng, lat, rings)) return false;
  }
  return true;
}

export function pathInsidePolygon(path: Array<[number, number]>, rings: Array<Array<[number, number]>>): boolean {
  if (path.length < 2 || rings.length === 0 || rings.some((ring) => ring.length < 4)) return false;
  if (path.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat) || !pointInPolygonOrOuterBoundary(lng, lat, rings))) return false;
  for (let index = 1; index < path.length; index += 1) {
    if (!segmentInsideOuterBoundary(path[index - 1]!, path[index]!, rings)) return false;
    for (const ring of rings.slice(1)) {
      for (let edge = 0; edge < ring.length; edge += 1) {
        if (segmentsIntersect(path[index - 1]!, path[index]!, ring[edge]!, ring[(edge + 1) % ring.length]!)) return false;
      }
    }
  }
  return true;
}

/**
 * 带安全余量的围栏判定：点在环内，且到边界的最小距离不小于余量。
 * 田间尺度用点所在纬度的等距圆柱投影换算成米，避免经度方向随纬度收缩后低估距离。
 */
export function pointInsideWithBuffer(lng: number, lat: number, ring: Array<[number, number]>, bufferM: number): boolean {
  return pointInsidePolygonWithBuffer(lng, lat, [ring], bufferM);
}

export function pointInsidePolygonWithBuffer(lng: number, lat: number, rings: Array<Array<[number, number]>>, bufferM: number): boolean {
  if (!pointInPolygon(lng, lat, rings)) return false;
  if (bufferM <= 0) return true;
  const scale = Math.cos((lat * Math.PI) / 180);
  const px = lng * 111_320 * scale;
  const py = lat * 110_540;
  let minDistance = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[(i + 1) % ring.length]!;
      minDistance = Math.min(minDistance, distanceToSegment(
        px,
        py,
        ax * 111_320 * scale,
        ay * 110_540,
        bx * 111_320 * scale,
        by * 110_540,
      ));
    }
  }
  return minDistance >= bufferM;
}
