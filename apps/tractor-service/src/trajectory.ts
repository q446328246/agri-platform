import type { TrajectoryLane, TrajectoryPoint, TrajectorySource } from "./trajectory.repository.js";

/**
 * 拖拉机作业轨迹的构造。
 *
 * 两条来源：
 * - MANUAL：调用方直接传入轨迹点，平台只做校验与里程现算，不猜路径；
 * - AUTO：取地块边界，调 operation-service 的覆盖规划算出牛耕式作业轨迹。
 * 下发时路径点随作业步参数经 MQTT 指令带给拖拉机，由 RTK 跟随运行。
 */

/** 未落库的轨迹草稿，由组合根补 jobId/租户后写入库 */
export interface TrajectoryDraft {
  source: TrajectorySource;
  path: TrajectoryPoint[];
  lanes?: TrajectoryLane[];
  headingDeg?: number;
  implementWidthM?: number;
  totalDistanceM: number;
  durationMin: number;
  warnings: string[];
}

/** operation-service 覆盖规划返回的最小形状（跨服务只取用到的字段） */
export interface CoveragePlanView {
  headingDeg: number;
  implementWidthM: number;
  totalDistanceM: number;
  durationMin: number;
  warnings: string[];
  path: { coordinates: number[][] };
  lanes?: Array<{ index: number; pass: number; coordinates: number[][]; lengthM: number }>;
}

/**
 * 折线里程（米）：等距圆柱近似。
 * 换算常数与覆盖规划、田间导航同口径——里程在平台里只能有一份算式，否则同一条
 * 路径在各处给出的长度会不一致。
 */
export function trajectoryDistanceM(points: TrajectoryPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [lng1, lat1] = points[index - 1]!;
    const [lng2, lat2] = points[index]!;
    const rad = Math.PI / 180;
    const midLat = ((lat1 + lat2) / 2) * rad;
    const dx = (lng2 - lng1) * 111_320 * Math.cos(midLat);
    const dy = (lat2 - lat1) * 110_540;
    total += Math.hypot(dx, dy);
  }
  return Math.round(total * 10) / 10;
}

function toPoints(coordinates: number[][]): TrajectoryPoint[] {
  return coordinates.map((point) => [Number(point[0]), Number(point[1])]) as TrajectoryPoint[];
}

/** 把覆盖规划结果转成轨迹草稿：路径折点 + 作业带 + 方向/幅宽/里程/时长 */
export function trajectoryFromCoverage(plan: CoveragePlanView): TrajectoryDraft {
  return {
    source: "AUTO",
    path: toPoints(plan.path.coordinates),
    ...(plan.lanes === undefined
      ? {}
      : { lanes: plan.lanes.map((lane) => ({ index: lane.index, pass: lane.pass, coordinates: toPoints(lane.coordinates), lengthM: lane.lengthM })) }),
    headingDeg: plan.headingDeg,
    implementWidthM: plan.implementWidthM,
    totalDistanceM: plan.totalDistanceM,
    durationMin: plan.durationMin,
    warnings: plan.warnings ?? [],
  };
}

/**
 * 点到折线的最短距离（米）：等距圆柱近似，与轨迹里程同口径。
 * 作业期监测据此判断拖拉机是否按轨迹运行——RTK 实时位置离折线过远即偏离。
 */
export function distanceToPolylineM(point: { lng: number; lat: number }, path: TrajectoryPoint[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1]!;
    const to = path[index]!;
    const scale = Math.cos((point.lat * Math.PI) / 180);
    const ax = from[0] * scale;
    const ay = from[1];
    const bx = to[0] * scale;
    const by = to[1];
    const px = point.lng * scale;
    const py = point.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    const footLng = (ax + t * dx) / scale;
    const footLat = ay + t * dy;
    const rad = Math.PI / 180;
    const midLat = ((point.lat + footLat) / 2) * rad;
    const ddx = (footLng - point.lng) * 111_320 * Math.cos(midLat);
    const ddy = (footLat - point.lat) * 110_540;
    const distance = Math.hypot(ddx, ddy);
    if (distance < min) min = distance;
  }
  return min;
}
/** 直接传入的轨迹点：只现算里程，时长留空——作业步的时长包络才是权威值，不拿里程反推 */
export function trajectoryFromPoints(points: TrajectoryPoint[]): TrajectoryDraft {
  return {
    source: "MANUAL",
    path: points.map((point) => [point[0], point[1]]),
    totalDistanceM: trajectoryDistanceM(points),
    durationMin: 0,
    warnings: [],
  };
}
