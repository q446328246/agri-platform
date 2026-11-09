import type { Plot } from '@/types'

/** 解析后的地块边界：Leaflet 使用 [lat, lng]，几何原始数据为 [lng, lat]。 */
export interface PlotBoundary {
  name: string
  parcelCode: string
  /** Leaflet 坐标环，单位：[纬度, 经度] */
  rings: [number, number][][]
  center: [number, number]
  areaMu: number
  crop?: string | undefined
}

/** GeoJSON Polygon 环坐标 */
type Ring = number[][]

function asRing(value: unknown): Ring | null {
  if (!Array.isArray(value)) return null
  return value.filter((point): point is number[] => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
}

function candidateRings(source: unknown): Ring[] {
  if (!source) return []
  if (typeof source === 'string') {
    try {
      return candidateRings(JSON.parse(source))
    } catch {
      return []
    }
  }
  if (Array.isArray(source)) {
    const first = source[0]
    // [lng, lat] 点数组
    if (first && Array.isArray(first) && typeof first[0] === 'number' && typeof first[1] === 'number') {
      return [source as Ring]
    }
    // 嵌套环，或 GeoJSON MultiPolygon
    return source.flatMap((item) => candidateRings(item))
  }
  if (typeof source === 'object') {
    const record = source as { coordinates?: unknown; rings?: unknown; outer?: unknown }
    return [...candidateRings(record.coordinates), ...candidateRings(record.rings), ...candidateRings(record.outer)]
  }
  return []
}

function dedupe(points: [number, number][]): [number, number][] {
  const result: [number, number][] = []
  for (const point of points) {
    const last = result[result.length - 1]
    if (!last || last[0] !== point[0] || last[1] !== point[1]) result.push(point)
  }
  const first = result[0]
  const lastPoint = result[result.length - 1]
  if (result.length > 1 && first && lastPoint && first[0] === lastPoint[0] && first[1] === lastPoint[1]) result.pop()
  return result
}

/**
 * 环面积（亩），入参为 Leaflet 序 [纬度, 经度]。
 * 先以环重心为原点投影到等距圆柱平面再做鞋带公式：逐点乘 cos(lat) 会让 107/30 量级的坐标项
 * 互相抵消，纬度稍有跨度就在真实面积上叠出几十个百分点的误差；平移到重心后各项都是米级小量。
 */
function ringAreaMu(ring: [number, number][]): number {
  if (ring.length < 3) return 0
  const [lat0, lng0] = ringCenter(ring)
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const ky = 110540
  let total = 0
  for (let i = 0; i < ring.length; i += 1) {
    const [lat1, lng1] = ring[i]!
    const [lat2, lng2] = ring[(i + 1) % ring.length]!
    const x1 = (lng1 - lng0) * kx
    const y1 = (lat1 - lat0) * ky
    const x2 = (lng2 - lng0) * kx
    const y2 = (lat2 - lat0) * ky
    total += x1 * y2 - x2 * y1
  }
  // 平方米 -> 亩
  return Math.abs(total / 2) / 666.6667
}

/** 找出面积最大的外环，避免内环、洞或顺序异常的多边形导致展示翻转。 */
function primaryRing(rings: [number, number][][]): [number, number][] | null {
  let best: [number, number][] | null = null
  let bestArea = 0
  for (const ring of rings) {
    const size = ringAreaMu(ring)
    if (size > bestArea) {
      bestArea = size
      best = ring
    }
  }
  return best
}

function ringCenter(ring: [number, number][]): [number, number] {
  let lat = 0
  let lng = 0
  for (const point of ring) {
    lat += point[0]
    lng += point[1]
  }
  const count = ring.length || 1
  return [lat / count, lng / count]
}

/** 地块边界解析，兼容 GeoJSON Polygon/MultiPolygon 和历史数组格式，剔除退化边界。 */
export function parsePlotBoundary(plot: PlotBoundarySource): PlotBoundary | null {
  const rings = candidateRings(plot.geom ?? plot.boundary ?? plot.coordinates)
    .map(asRing)
    .filter((ring): ring is Ring => !!ring && ring.length >= 3)
    .map((ring) => dedupe(ring.map((point) => [Number(point[1]), Number(point[0])] as [number, number])))
    .filter((ring) => ring.length >= 3)
  const ring = primaryRing(rings)
  if (!ring) return null
  const parcelCode = String(plot.parcelCode ?? plot.parcelId ?? plot.id ?? '')
  return {
    name: String(plot.name ?? plot.parcelName ?? parcelCode),
    parcelCode,
    // 主环放首位：调用方按 rings[0] 定位与拟合视野，必须和 center 取自同一个环
    rings: [ring, ...rings.filter((item) => item !== ring)],
    center: ringCenter(ring),
    areaMu: Number(plot.areaMu ?? 0) || 0,
    ...(plot.currentCrop ? { crop: String(plot.currentCrop) } : {}),
  }
}

export type PlotBoundarySource = Partial<Plot> & Record<string, unknown>

export function parsePlotBoundaries(plots: Array<Partial<Plot> | PlotBoundarySource>): PlotBoundary[] {
  return plots.map(parsePlotBoundary).filter((item): item is PlotBoundary => !!item)
}

/** 折线长度（米），入参为 [经度, 纬度]；与后端 estimateLengthM 用同一套等距圆柱近似，便于绘制时实时预览。 */
export function polylineLengthM(points: Array<[number, number]>): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]!
    const to = points[i]!
    const midLat = ((from[1] + to[1]) / 2) * (Math.PI / 180)
    const dx = (to[0] - from[0]) * 111320 * Math.cos(midLat)
    const dy = (to[1] - from[1]) * 110540
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

/** 绘制中的多边形面积（亩），入参为 [经度, 纬度] 顶点，可不闭合；不足 3 点返回 0。 */
export function polygonAreaMu(points: Array<[number, number]>): number {
  if (points.length < 3) return 0
  const ring = points.map(([lng, lat]) => [lat, lng] as [number, number])
  return boundaryAreaMu({ name: '', parcelCode: '', rings: [ring], center: [0, 0], areaMu: 0 })
}

export function boundaryAreaMu(boundary: PlotBoundary): number {
  if (boundary.areaMu > 0) return boundary.areaMu
  const ring = boundary.rings[0]
  return ring ? ringAreaMu(ring) : 0
}


