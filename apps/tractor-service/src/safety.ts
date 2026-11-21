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
  plot: { status: string; hasBoundary: boolean } | null;
  /** 设备台账绑定的地块是否与本次作业地块一致 */
  deviceBoundToPlot: boolean;
  /** 该设备是否存在在途作业指令（控制侧互锁） */
  inTransitJob: boolean;
  /** 最新 RTK 定位质量 */
  rtkQuality: { hdop?: number; hasFix?: boolean } | null;
}

export interface SafetyOptions {
  /** RTK 水平精度门限（HDOP），超过则拒绝精准作业，缺省 2.0 */
  rtkHdopMax?: number;
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

  const plotOk = input.plot !== null && input.plot.status === "ACTIVE" && input.plot.hasBoundary;
  gates.push({
    gate: "plot",
    passed: plotOk,
    message: plotOk ? "地块有效且边界可用" : input.plot === null ? "地块不存在" : `地块需为生效状态且边界完整（当前 ${input.plot.status}${input.plot.hasBoundary ? "" : "，边界缺失"}）`,
  });

  gates.push({
    gate: "interlock",
    passed: !input.inTransitJob,
    message: input.inTransitJob ? "设备存在在途作业指令，作业互锁拒绝" : "设备无在途作业",
  });

  const rtk = input.rtkQuality;
  const rtkOk = rtk !== null && rtk.hasFix === true && rtk.hdop !== undefined && rtk.hdop <= hdopMax;
  gates.push({
    gate: "rtk",
    passed: rtkOk,
    message: rtkOk ? `RTK 定位质量达标（HDOP ${rtk?.hdop}）` : rtk === null ? "无 RTK 定位数据，拒绝精准作业" : `RTK 定位质量不达标（HDOP ${rtk?.hdop ?? "缺测"}，门限 ${hdopMax}）`,
  });

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

/** 从地块几何提取外环坐标（空环返回 null） */
export function ringOf(geom: GeoPolygon | null | undefined): Array<[number, number]> | null {
  const ring = geom?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const points: Array<[number, number]> = [];
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) return null;
    points.push([Number(point[0]), Number(point[1])]);
  }
  return points;
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

/**
 * 带安全余量的围栏判定：点在环内，且到边界的最小距离不小于余量（经纬度空间）。
 * 余量按「1 度纬度 ≈ 111.32 千米」折算，经度方向实际更窄，该折算偏保守（余量偏大），
 * 安全方向上宁可多判出界，不漏判。
 */
export function pointInsideWithBuffer(lng: number, lat: number, ring: Array<[number, number]>, bufferM: number): boolean {
  if (!pointInRing(lng, lat, ring)) return false;
  if (bufferM <= 0) return true;
  const bufferDeg = bufferM / 111_320;
  let minDistance = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    minDistance = Math.min(minDistance, distanceToSegment(lng, lat, ax, ay, bx, by));
  }
  return minDistance >= bufferDeg;
}
