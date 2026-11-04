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

/** 找出面积最大的外环，避免内环、洞或顺序异常的多边形导致展示翻转。 */
function primaryRing(rings: [number, number][][]): [number, number][] | null {
  let best: [number, number][] | null = null
  let bestArea = 0
  for (const ring of rings) {
    let area = 0
    for (let i = 0; i < ring.length; i += 1) {
      const [lat1, lng1] = ring[i]!
      const [lat2, lng2] = ring[(i + 1) % ring.length]!
      area += lat1 * lng2 - lat2 * lng1
    }
    const size = Math.abs(area / 2)
    if (size > bestArea && ring.length >= 3) {
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
    rings,
    center: ringCenter(ring),
    areaMu: Number(plot.areaMu ?? 0) || 0,
    ...(plot.currentCrop ? { crop: String(plot.currentCrop) } : {}),
  }
}

export type PlotBoundarySource = Partial<Plot> & Record<string, unknown>

export function parsePlotBoundaries(plots: Array<Partial<Plot> | PlotBoundarySource>): PlotBoundary[] {
  return plots.map(parsePlotBoundary).filter((item): item is PlotBoundary => !!item)
}

export function boundaryAreaMu(boundary: PlotBoundary): number {
  if (boundary.areaMu > 0) return boundary.areaMu
  const [ring] = boundary.rings
  if (!ring) return 0
  let total = 0
  for (let i = 0; i < ring.length; i += 1) {
    const [lat1, lng1] = ring[i]!
    const [lat2, lng2] = ring[(i + 1) % ring.length]!
    total += (lat1 * lng2 - lat2 * lng1) * Math.cos((lat1 * Math.PI) / 180)
  }
  // 平方度 -> 平方米 -> 亩
  return Math.abs((total / 2) * 111320 * 111320) / 666.6667
}


