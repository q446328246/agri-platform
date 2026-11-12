import type { LngLat } from "./zone.geometry.js";

/**
 * 合并地块的相邻判定。
 *
 * 合并后的边界取源地块顶点的凸包，凸包只在成员地块首尾相接时才等于真并集：
 * 隔着一块别人的田做凸包，会把中间空地一并圈进自家台账，在账面积凭空增长。
 * 所以合并前要求所选地块连成一片，判定口径只有「边界够近」这一条。
 *
 * 坐标是经纬度，判定前先把两个环一起投影到等距圆柱平面（米），常数与
 * `packages/shared/src/area.ts` 的面积口径、`infra-line.repository.ts` 的长度估算同源：
 * 田间尺度（公里级）误差可忽略，更高精度应改用 PostGIS 的 ST_DWithin / ST_Touches。
 */

/** 默认间隙容差（米）：实地共边的地块多是分别测绘/手绘，顶点错位一两米属正常 */
export const DEFAULT_ADJACENCY_TOLERANCE_M = 5;

const METERS_PER_DEGREE_LAT = 110_540;
const METERS_PER_DEGREE_LNG = 111_320;

interface Flat {
  x: number;
  y: number;
}

/** 以两环合并后的重心为原点投影成平面米制坐标，同一对环共用一套缩放避免形变 */
function flatten(a: LngLat[], b: LngLat[]): { a: Flat[]; b: Flat[] } {
  const all = [...a, ...b];
  const lat0 = all.reduce((sum, point) => sum + point.lat, 0) / all.length;
  const lng0 = all.reduce((sum, point) => sum + point.lng, 0) / all.length;
  const kx = METERS_PER_DEGREE_LNG * Math.cos((lat0 * Math.PI) / 180);
  const map = (point: LngLat): Flat => ({ x: (point.lng - lng0) * kx, y: (point.lat - lat0) * METERS_PER_DEGREE_LAT });
  return { a: a.map(map), b: b.map(map) };
}

function orient(from: Flat, to: Flat, point: Flat): number {
  return (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
}

/** 严格相交：两段跨过彼此所在的直线，共线与端点相接交给下面的距离判定处理 */
function crosses(p1: Flat, p2: Flat, q1: Flat, q2: Flat): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function distanceToSegment(point: Flat, from: Flat, to: Flat): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq));
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

/** 闭合环的边（末点不重复时自动补回起点） */
function edges(ring: Flat[]): Array<[Flat, Flat]> {
  const result: Array<[Flat, Flat]> = [];
  for (let index = 0; index < ring.length; index += 1) {
    result.push([ring[index]!, ring[(index + 1) % ring.length]!]);
  }
  return result;
}

function containsPoint(ring: Flat[], point: Flat): boolean {
  let inside = false;
  const segments = edges(ring);
  for (const [a, b] of segments) {
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * 两个外环是否相邻：相交、一块套进另一块，或边界间隙不超过容差。
 * 顶点不足 3 个的退化环一律不算相邻，交由上层按边界非法处理。
 */
export function ringsAdjacent(a: LngLat[], b: LngLat[], toleranceM = DEFAULT_ADJACENCY_TOLERANCE_M): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const projected = flatten(a, b);
  if (containsPoint(projected.b, projected.a[0]!) || containsPoint(projected.a, projected.b[0]!)) return true;
  const first = edges(projected.a);
  const second = edges(projected.b);
  for (const [p1, p2] of first) {
    for (const [q1, q2] of second) {
      if (crosses(p1, p2, q1, q2)) return true;
      const gap = Math.min(
        distanceToSegment(p1, q1, q2),
        distanceToSegment(p2, q1, q2),
        distanceToSegment(q1, p1, p2),
        distanceToSegment(q2, p1, p2),
      );
      if (gap <= toleranceM) return true;
    }
  }
  return false;
}

/**
 * 按相邻关系把地块切成连通的几组（组内首尾相接可延续，组之间互不相接）。
 * 结果只有一组才说明这批地块能合并成一块。
 */
export function adjacencyGroups<T>(items: Array<{ key: T; ring: LngLat[] }>, toleranceM = DEFAULT_ADJACENCY_TOLERANCE_M): T[][] {
  const visited = new Set<number>();
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += 1) {
    if (visited.has(start)) continue;
    visited.add(start);
    const queue = [start];
    const group: T[] = [];
    // 广度优先扩散：新入组的成员要继续和未访问成员比，A-B、B-C 这种串也能并成一组
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      group.push(items[current]!.key);
      for (const [index, candidate] of items.entries()) {
        if (visited.has(index)) continue;
        if (!ringsAdjacent(items[current]!.ring, candidate.ring, toleranceM)) continue;
        visited.add(index);
        queue.push(index);
      }
    }
    groups.push(group);
  }
  return groups;
}
