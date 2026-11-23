<template>
  <div class="boundary-map">
    <div ref="mapEl" class="boundary-map__canvas"></div>
    <BaseMapSwitch :model-value="baseMapKey" :map="mapHandle" @update:model-value="switchBaseMap" @custom-updated="onCustomUpdated" />
    <div v-if="message" class="boundary-map__tip" :class="{ 'boundary-map__tip--empty': empty }">{{ message }}</div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import BaseMapSwitch from '@/components/BaseMapSwitch.vue'
import { baseMapCrs, baseMapMaxZoom, createBaseLayer, createBaseLayers, isGcjBaseMap, readStoredBaseMap, storeBaseMap, type BaseMapKey } from '@/utils/basemap'
import { parsePlotBoundary, type PlotBoundary, type PlotBoundarySource } from '@/utils/geo'
import type { Trajectory } from '@/types'

const props = defineProps<{ source?: PlotBoundarySource | null; trajectory?: Trajectory | null }>()

const mapEl = ref<HTMLElement | null>(null)
const message = ref('')
const empty = ref(false)
const baseMapKey = ref<BaseMapKey>(readStoredBaseMap())
let map: any = null
let layer: any = null
let baseLayers: Record<BaseMapKey, any> | null = null
// 缩放条/框选放大需要响应式 map 句柄（map 本体为普通变量，重建时同步刷新句柄）
const mapHandle = shallowRef<any>(null)

/** 把地块边界与作业轨迹画到地图上；都没有时保留提示，避免空白画布。 */
function render(boundary: PlotBoundary | null, trajectory: Trajectory | null) {
  if (!map) return
  if (layer) map.removeLayer(layer)
  layer = L.layerGroup()
  if (!boundary && !trajectory) {
    empty.value = true
    message.value = '服务端暂无地块边界与作业轨迹'
    map.setView([30.982425, 107.421325], 15)
    return
  }
  empty.value = false
  // 地块边界
  if (boundary) {
    boundary.rings.forEach((ring) => {
      L.polygon(ring, { color: '#00d4ff', weight: 2, fillColor: '#00d4ff', fillOpacity: 0.16 }).addTo(layer)
    })
    L.marker(boundary.center, {
      icon: L.divIcon({ className: 'boundary-label', html: '<span>' + boundary.name + '</span>', iconSize: [0, 0] }),
      interactive: false,
    }).addTo(layer)
  }
  // 作业带（仅 AUTO）：每条扫描线两端连线，浅色虚线，供复核覆盖是否铺满
  if (trajectory?.lanes) {
    trajectory.lanes.forEach((lane) => {
      const coords = lane.coordinates.map((point) => [point[1], point[0]] as [number, number])
      if (coords.length >= 2) L.polyline(coords, { color: '#ffb74d', weight: 1, dashArray: '4 4', opacity: 0.7 }).addTo(layer)
    })
  }
  // 轨迹折线：拖拉机按此跟随，醒目实线 + 起终点标记
  if (trajectory?.path && trajectory.path.length >= 2) {
    const coords = trajectory.path.map((point) => [point[1], point[0]] as [number, number])
    L.polyline(coords, { color: '#ff6b35', weight: 3, opacity: 0.9 }).addTo(layer)
    L.marker(coords[0]!, { icon: L.divIcon({ className: 'trajectory-point', html: '<span>起</span>', iconSize: [0, 0] }), interactive: false }).addTo(layer)
    L.marker(coords[coords.length - 1]!, { icon: L.divIcon({ className: 'trajectory-point', html: '<span>终</span>', iconSize: [0, 0] }), interactive: false }).addTo(layer)
  }
  layer.addTo(map)
  // 视野拟合：合并边界环与轨迹折点，取整体范围
  const points: [number, number][] = []
  if (boundary) boundary.rings.forEach((ring) => ring.forEach((point) => points.push(point)))
  if (trajectory?.path) trajectory.path.forEach((point) => points.push([point[1], point[0]]))
  const bounds = L.latLngBounds(points)
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] })
  message.value = trajectory
    ? `${trajectory.source === 'AUTO' ? '自动' : '手动'}轨迹 · ${trajectory.totalDistanceM.toFixed(0)} 米 · ${trajectory.durationMin.toFixed(0)} 分钟`
    : (boundary ? boundary.name + ' · ' + boundary.areaMu.toFixed(2) + ' 亩' : '')
}

function sync() {
  render(props.source ? parsePlotBoundary(props.source) : null, props.trajectory ?? null)
}

function initMap() {
  map = L.map(mapEl.value!, { zoomControl: true, attributionControl: false, maxZoom: baseMapMaxZoom(baseMapKey.value), crs: baseMapCrs(baseMapKey.value) })
  baseLayers = createBaseLayers()
  baseLayers[baseMapKey.value].addTo(map)
  mapHandle.value = map
}

/** 底图热切换：同坐标系只换底图组；跨系（高德 GCJ-02）Leaflet CRS 不能热改，
 *  重建地图并按原视野重绘边界；选择持久化与一张图共用。
 *  force 用于自定义源配置变更：同系也重建，确保新瓦片参数生效。 */
function switchBaseMap(key: BaseMapKey, force = false) {
  const prev = baseMapKey.value
  if (key === prev && !force) return
  baseMapKey.value = key
  storeBaseMap(key)
  if (!map || !baseLayers) return
  map.setMaxZoom(baseMapMaxZoom(key))
  if (!force && isGcjBaseMap(prev) === isGcjBaseMap(key)) {
    const next = baseLayers[key] ?? (baseLayers[key] = createBaseLayer(key))
    if (!next) return
    map.removeLayer(baseLayers[prev])
    next.addTo(map)
    return
  }
  const center = map.getCenter()
  const zoom = map.getZoom()
  map.remove()
  map = null
  layer = null
  mapHandle.value = null
  initMap()
  map.setView(center, zoom)
  sync()
}

function onCustomUpdated() {
  switchBaseMap('custom', true)
}

onMounted(() => {
  if (!mapEl.value) return
  initMap()
  sync()
})

watch(() => [props.source, props.trajectory], sync, { deep: true })

onBeforeUnmount(() => {
  if (layer && map) map.removeLayer(layer)
  layer = null
  baseLayers = null
  mapHandle.value = null
  map?.remove()
  map = null
})
</script>

<style scoped lang="scss">
.boundary-map { position: relative; width: 100%; height: 400px; border-radius: 8px; overflow: hidden; }
.boundary-map__canvas { width: 100%; height: 100%; }
.boundary-map__tip { position: absolute; z-index: 400; top: 10px; left: 10px; padding: 6px 12px; font-size: 12px; color: #fff; background: rgba(9, 30, 66, .82); border-radius: 4px; }
.boundary-map__tip--empty { color: #ff9c65; }
/* 顶部已有名称/面积提示条：切换条放右下空位 */
:deep(.basemap-switch) { top: auto; bottom: 12px; }
:deep(.boundary-label) { background: none; border: 0; }
:deep(.boundary-label span) { display: inline-block; padding: 2px 8px; font-size: 12px; color: #dff4f8; background: rgba(9, 30, 66, .78); border-radius: 4px; white-space: nowrap; }
:deep(.trajectory-point) { background: none; border: 0; }
:deep(.trajectory-point span) { display: inline-block; padding: 1px 6px; font-size: 11px; color: #fff; background: #ff6b35; border-radius: 4px; white-space: nowrap; }
</style>