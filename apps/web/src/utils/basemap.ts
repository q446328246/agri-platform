import L from 'leaflet'
import { gcj02ToWgs84, wgs84ToGcj02 } from '@/utils/gcj02'

/**
 * 底图切换共享模块：一张图驾驶舱与弹出页面（地块详情/边界绘制/片区/导航）共用同一套
 * 底图选项、瓦片源、GCJ-02 显示投影与 localStorage 持久化，保证各处选择互通。
 * 天地图影像在乡村区域分辨率有限，Esri World Imagery 通常更清晰且同为 WGS84 无偏移；
 * 高德影像与手机地图同源（路网/注记密、更新快），但用 GCJ-02 加密坐标，须经显示层投影转换；
 * 高清影像上叠加天地图中文注记（cia），地名可读性不丢。
 */
export type BaseMapKey = 'tdt-img' | 'esri-img' | 'amap-img' | 'tdt-vec'

export const BASE_MAP_OPTIONS: Array<{ key: BaseMapKey; label: string; hint: string }> = [
  { key: 'tdt-img', label: '天地图影像', hint: '天地图卫星影像 + 中文注记' },
  { key: 'esri-img', label: '高清影像', hint: 'Esri World Imagery 卫星影像（乡村区域通常更清晰）+ 天地图中文注记' },
  { key: 'amap-img', label: '高德影像', hint: '高德卫星影像 + 路网注记（手机地图同源，GCJ-02 已转换，地块边界不偏移）' },
  { key: 'tdt-vec', label: '矢量地图', hint: '天地图矢量底图 + 中文注记' },
]

export const BASEMAP_STORAGE_KEY = 'agri-basemap'

export function readStoredBaseMap(): BaseMapKey {
  const stored = localStorage.getItem(BASEMAP_STORAGE_KEY)
  return BASE_MAP_OPTIONS.some((opt) => opt.key === stored) ? (stored as BaseMapKey) : 'tdt-img'
}

export function storeBaseMap(key: BaseMapKey): void {
  localStorage.setItem(BASEMAP_STORAGE_KEY, key)
}

/** 高德系（GCJ-02）与天地图/Esri（WGS84）投影不同，跨系切换须重建地图。 */
export function isGcjBaseMap(key: BaseMapKey): boolean {
  return key === 'amap-img'
}

// 瓦片原生最高 18 级，地图允许放到 20 级（18 级以上放大渲染），便于精确对齐地块边界顶点
const tileOptions = { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: 20, maxNativeZoom: 18 }

function createTiandituTiles(layer: string) {
  const key = import.meta.env.VITE_TIANDITU_KEY
  return L.tileLayer(
    `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}` +
      `&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${key}`,
    { ...tileOptions },
  )
}

function createEsriTiles() {
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18 })
}

/** 高德瓦片：style=6 卫星影像，style=8 透明路网+注记（叠在影像上就是手机地图的观感） */
function createAmapTiles(style: '6' | '8') {
  const host = style === '6' ? 'webst0{s}' : 'wprd0{s}'
  const extra = style === '8' ? '&lang=zh_cn&size=1&scl=1' : ''
  return L.tileLayer(`https://${host}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&style=${style}${extra}`, { subdomains: ['1', '2', '3', '4'], maxZoom: 20, maxNativeZoom: 18 })
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

export function createBaseLayers(): Record<BaseMapKey, any> {
  return {
    'tdt-img': L.layerGroup([createTiandituTiles('img'), createTiandituTiles('cia')]),
    'esri-img': L.layerGroup([createEsriTiles(), createTiandituTiles('cia')]),
    'amap-img': L.layerGroup([createAmapTiles('6'), createAmapTiles('8')]),
    'tdt-vec': L.layerGroup([createTiandituTiles('vec'), createTiandituTiles('cva')]),
  }
}