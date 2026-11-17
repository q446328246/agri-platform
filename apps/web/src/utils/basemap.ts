import L from 'leaflet'
import { gcj02ToWgs84, wgs84ToGcj02 } from '@/utils/gcj02'

/**
 * 底图切换共享模块：一张图驾驶舱与弹出页面（地块详情/边界绘制/片区/导航）共用同一套
 * 底图选项、瓦片源、GCJ-02 显示投影与 localStorage 持久化，保证各处选择互通。
 * 天地图影像在乡村区域分辨率有限，Esri World Imagery 通常更清晰且同为 WGS84 无偏移；
 * 高德影像与手机地图同源（路网/注记密、更新快），但用 GCJ-02 加密坐标，须经显示层投影转换；
 * 谷歌影像经农场中心同号瓦片目视比对确认 WGS84 无偏移，且本区域原生瓦片实测可达 22 级
 * （Esri/高德/天地图原生仅 18 级，19 级起为占位瓦片），深度放大最清晰；
 * 高清影像上叠加天地图中文注记（cia），地名可读性不丢。
 * 另支持自定义 XYZ 影像源（无人机正射/本地瓦片服务），原生与显示级别可配置到 24 级。
 */
export type BaseMapKey = 'tdt-img' | 'esri-img' | 'google-img' | 'amap-img' | 'tdt-vec' | 'custom'

export const BASE_MAP_OPTIONS: Array<{ key: BaseMapKey; label: string; hint: string }> = [
  { key: 'tdt-img', label: '天地图影像', hint: '天地图卫星影像 + 中文注记（原生 18 级）' },
  { key: 'esri-img', label: '高清影像', hint: 'Esri World Imagery 卫星影像（乡村区域通常更清晰，原生 18 级）+ 天地图中文注记' },
  { key: 'google-img', label: '谷歌影像', hint: 'Google 卫星影像（WGS84 无偏移，本区域原生可达 22 级，深度放大最清晰）+ 天地图中文注记' },
  { key: 'amap-img', label: '高德影像', hint: '高德卫星影像 + 路网注记（手机地图同源，GCJ-02 已转换，地块边界不偏移，原生 18 级）' },
  { key: 'tdt-vec', label: '矢量地图', hint: '天地图矢量底图 + 中文注记' },
]

/** 地图显示上限：公共影像源原生 18 级（谷歌 22 级），超出后按瓦片插值放大，便于精确对齐边界顶点 */
export const MAP_MAX_ZOOM = 22

export const BASEMAP_STORAGE_KEY = 'agri-basemap'
export const CUSTOM_STORAGE_KEY = 'agri-basemap-custom'

export interface CustomBaseMapConfig {
  name: string
  url: string
  subdomains: string[]
  maxNativeZoom: number
  maxZoom: number
}

export function readCustomBaseMap(): CustomBaseMapConfig | null {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as CustomBaseMapConfig
    if (typeof cfg?.url !== 'string' || !cfg.url.includes('{x}') || !cfg.url.includes('{y}') || !cfg.url.includes('{z}')) return null
    const native = Math.min(24, Math.max(1, Number(cfg.maxNativeZoom) || 18))
    return {
      name: String(cfg.name || '自定义影像'),
      url: cfg.url,
      subdomains: Array.isArray(cfg.subdomains) ? cfg.subdomains.map(String) : [],
      maxNativeZoom: native,
      maxZoom: Math.min(24, Math.max(native, Number(cfg.maxZoom) || native)),
    }
  } catch {
    return null
  }
}

export function storeCustomBaseMap(cfg: CustomBaseMapConfig): void {
  localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(cfg))
}

export function clearCustomBaseMap(): void {
  localStorage.removeItem(CUSTOM_STORAGE_KEY)
}

export function readStoredBaseMap(): BaseMapKey {
  const stored = localStorage.getItem(BASEMAP_STORAGE_KEY)
  if (stored === 'custom') return readCustomBaseMap() ? 'custom' : 'tdt-img'
  return BASE_MAP_OPTIONS.some((opt) => opt.key === stored) ? (stored as BaseMapKey) : 'tdt-img'
}

export function storeBaseMap(key: BaseMapKey): void {
  localStorage.setItem(BASEMAP_STORAGE_KEY, key)
}

export function baseMapLabelOf(key: BaseMapKey): string {
  if (key === 'custom') return readCustomBaseMap()?.name ?? '自定义影像'
  return BASE_MAP_OPTIONS.find((opt) => opt.key === key)?.label ?? '天地图影像'
}

/** 高德系（GCJ-02）与天地图/Esri/谷歌（WGS84）投影不同，跨系切换须重建地图。自定义源按 WGS84 约定。 */
export function isGcjBaseMap(key: BaseMapKey): boolean {
  return key === 'amap-img'
}

/** 各源显示上限：自定义源按配置（最高 24），其余统一 MAP_MAX_ZOOM */
export function baseMapMaxZoom(key: BaseMapKey): number {
  return key === 'custom' ? (readCustomBaseMap()?.maxZoom ?? MAP_MAX_ZOOM) : MAP_MAX_ZOOM
}

/** 各源原生瓦片最高级别（实测）：超过后为插值放大，清晰度不再增加 */
export function baseMapNativeZoom(key: BaseMapKey): number {
  if (key === 'custom') return readCustomBaseMap()?.maxNativeZoom ?? 18
  return key === 'google-img' ? 22 : 18
}

// 公共源瓦片原生最高 18 级，地图允许放到 22 级（18 级以上放大渲染），便于精确对齐地块边界顶点
const tileOptions = { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 18 }

function createTiandituTiles(layer: string) {
  const key = import.meta.env.VITE_TIANDITU_KEY
  return L.tileLayer(
    `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}` +
      `&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${key}`,
    { ...tileOptions },
  )
}

function createEsriTiles() {
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 18 })
}

/** 谷歌卫星影像：本区域实测原生 22 级（z23 起 400），WGS84 无偏移，深度放大比 Esri 插值更清晰 */
function createGoogleTiles() {
  return L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { subdomains: ['0', '1', '2', '3'], maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 22 })
}

/** 高德瓦片：style=6 卫星影像，style=8 透明路网+注记（叠在影像上就是手机地图的观感） */
function createAmapTiles(style: '6' | '8') {
  const host = style === '6' ? 'webst0{s}' : 'wprd0{s}'
  const extra = style === '8' ? '&lang=zh_cn&size=1&scl=1' : ''
  return L.tileLayer(`https://${host}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&style=${style}${extra}`, { subdomains: ['1', '2', '3', '4'], maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 18 })
}

/** GCJ-02 显示投影：业务坐标（WGS84）先正算到 GCJ-02 再做墨卡托投影，屏幕点位逆算回 WGS84。
 *  高德瓦片与地块边界自此同一坐标系；入库坐标与面积计算不受影响，仍是 WGS84。 */
export function createGcjCrs() {
  const mercator = L.Projection.SphericalMercator
  const projection = {
    bounds: mercator.bounds,
    project(latlng: any) {
      const [lng, lat] = wgs84ToGcj02(latlng.lng, latlng.lat)
      return mercator.project(L.latLng(lat, lng))
    },
    unproject(point: any) {
      const ll = mercator.unproject(point)
      const [lng, lat] = gcj02ToWgs84(ll.lng, ll.lat)
      return L.latLng(lat, lng)
    },
  }
  return L.extend({}, L.CRS.EPSG3857, { projection })
}

export function baseMapCrs(key: BaseMapKey): any {
  return isGcjBaseMap(key) ? createGcjCrs() : L.CRS.EPSG3857
}

/** 单个底图组工厂：custom 按当前配置即时创建（配置保存后无需重建整张表） */
export function createBaseLayer(key: BaseMapKey): any {
  switch (key) {
    case 'tdt-img':
      return L.layerGroup([createTiandituTiles('img'), createTiandituTiles('cia')])
    case 'esri-img':
      return L.layerGroup([createEsriTiles(), createTiandituTiles('cia')])
    case 'google-img':
      return L.layerGroup([createGoogleTiles(), createTiandituTiles('cia')])
    case 'amap-img':
      return L.layerGroup([createAmapTiles('6'), createAmapTiles('8')])
    case 'tdt-vec':
      return L.layerGroup([createTiandituTiles('vec'), createTiandituTiles('cva')])
    case 'custom': {
      const cfg = readCustomBaseMap()
      if (!cfg) return null
      return L.layerGroup([
        L.tileLayer(cfg.url, {
          subdomains: cfg.subdomains.length ? cfg.subdomains : 'abc',
          maxZoom: cfg.maxZoom,
          maxNativeZoom: cfg.maxNativeZoom,
        }),
      ])
    }
  }
}

export function createBaseLayers(): Record<BaseMapKey, any> {
  const layers = {
    'tdt-img': createBaseLayer('tdt-img'),
    'esri-img': createBaseLayer('esri-img'),
    'google-img': createBaseLayer('google-img'),
    'amap-img': createBaseLayer('amap-img'),
    'tdt-vec': createBaseLayer('tdt-vec'),
  } as Record<BaseMapKey, any>
  const custom = createBaseLayer('custom')
  if (custom) layers.custom = custom
  return layers
}