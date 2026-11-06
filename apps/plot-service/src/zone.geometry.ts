import type { GeoPolygon } from "@agri/contracts";

/**
 * 片区的几何工具。
 *
 * 片区边界多数情况下没有单独测绘，只能由成员地块拼出来：这里取所有地块外环的
 * 凸包作为「片区范围」的显示轮廓。凸包只用于一张图的可视化与中心点定位，
 * 不作为面积统计口径——面积一律按成员地块的 areaMu 求和。
 */

export interface LngLat {
  lng: number;
  lat: number;
}

/** 取多边形外环顶点，坐标顺序为 [经度, 纬度] */
export function ringPoints(geom: GeoPolygon | undefined): LngLat[] {
  const ring = geom?.coordinates?.[0];
  if (!Array.isArray(ring)) return [];
  const points: LngLat[] = [];
  for (const pair of ring) {
    const lng = Number(pair[0]);
    const lat = Number(pair[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) points.push({ lng, lat });
  }
  return points;
}

function cross(origin: LngLat, a: LngLat, b: LngLat): number {
  return (a.lng - origin.lng) * (b.lat - origin.lat) - (a.lat - origin.lat) * (b.lng - origin.lng);
}

/** 单调链凸包，返回逆时针顶点（不含重复收尾点） */
export function convexHull(points: LngLat[]): LngLat[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.lng === b.lng ? a.lat - b.lat : a.lng - b.lng));
  const build = (source: LngLat[]): LngLat[] => {
    const stack: LngLat[] = [];
    for (const point of source) {
      while (stack.length >= 2) {
        const last = stack[stack.length - 1];
        const before = stack[stack.length - 2];
        if (!last || !before || cross(before, last, point) > 0) break;
        stack.pop();
      }
      stack.push(point);
    }
    return stack;
  };
  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  // 两端点在上下链中各出现一次，拼接时各去掉尾元素
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 凸包转 GeoJSON Polygon（首尾闭合）；点不足 3 个时返回 null */
export function hullPolygon(points: LngLat[]): GeoPolygon | null {
  const hull = convexHull(points);
  const first = hull[0];
  if (!first || hull.length < 3) return null;
  const ring = [...hull, first];
  return {
    type: "Polygon",
    coordinates: [ring.map((point) => [point.lng, point.lat])],
    srid: 4490,
  };
}

/** 顶点的算术平均，用于地图定位与「片区中心」展示 */
export function centroidOf(points: LngLat[]): LngLat | null {
  if (points.length === 0) return null;
  const total = points.reduce((sum, point) => ({ lng: sum.lng + point.lng, lat: sum.lat + point.lat }), { lng: 0, lat: 0 });
  return { lng: Number((total.lng / points.length).toFixed(6)), lat: Number((total.lat / points.length).toFixed(6)) };
}
