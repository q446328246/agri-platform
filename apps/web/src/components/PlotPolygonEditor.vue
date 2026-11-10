<template>
  <div class="polygon-editor">
    <div ref="mapEl" class="polygon-editor__map"></div>
    <div ref="toolbarEl" class="polygon-editor__toolbar">
      <el-button size="small" :disabled="points.length === 0" @click="undo">撤销上一点</el-button>
      <el-button size="small" :disabled="points.length === 0" @click="clear">清空</el-button>
      <span class="polygon-editor__count">
        {{ points.length }} 个顶点<span v-if="points.length >= 3"> · {{ areaMu.toFixed(2) }} 亩</span>
      </span>
    </div>
    <div class="polygon-editor__hint">单击地图添加顶点，至少 3 个顶点自动闭合成多边形，支持不规则边界。</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { polygonAreaMu } from '@/utils/geo'

const props = defineProps<{ modelValue?: [number, number][] | undefined }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: [number, number][]): void
  (e: 'area-change', value: number): void
}>()

/** Leaflet 使用 [纬度, 经度]，表单与后端使用 [经度, 纬度]。 */
const DEFAULT_CENTER: [number, number] = [30.982425, 107.421325]
const DEFAULT_ZOOM = 16

const mapEl = ref<HTMLElement | null>(null)
const toolbarEl = ref<HTMLElement | null>(null)
const points = ref<[number, number][]>([])
const areaMu = ref(0)

let map: any = null
let shapeLayer: any = null
let tiles: any[] = []

function tianditu(layerName: string) {
  const key = import.meta.env.VITE_TIANDITU_KEY
  return L.tileLayer(
    'https://t{s}.tianditu.gov.cn/' + layerName + '_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layerName +
      '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=' + key,
    { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: 18 },
  )
}

function normalize(value?: [number, number][]): [number, number][] {
  return (value ?? [])
    .filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
    .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
}

function samePoints(a: [number, number][], b: [number, number][]): boolean {
  return a.length === b.length && a.every((point, index) => point[0] === b[index]?.[0] && point[1] === b[index]?.[1])
}

function draw() {
  if (!map || !shapeLayer) return
  shapeLayer.clearLayers()
  const latlngs = points.value.map(([lng, lat]) => [lat, lng] as [number, number])
  latlngs.forEach((latlng, index) => {
    L.circleMarker(latlng, {
      radius: 5,
      color: '#ffffff',
      weight: 2,
      fillColor: '#409eff',
      fillOpacity: 1,
    })
      .bindTooltip(String(index + 1), { permanent: true, direction: 'top', offset: [0, -6], className: 'polygon-vertex-label' })
      .addTo(shapeLayer)
  })
  if (latlngs.length >= 3) {
    L.polygon(latlngs, { color: '#409eff', weight: 2, fillColor: '#409eff', fillOpacity: 0.18 }).addTo(shapeLayer)
  } else if (latlngs.length === 2) {
    L.polyline(latlngs, { color: '#409eff', weight: 2, dashArray: '6 4' }).addTo(shapeLayer)
  }
}

function fitToPoints() {
  if (!map || points.value.length === 0) return
  const latlngs = points.value.map(([lng, lat]) => [lat, lng] as [number, number])
  map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 17 })
}

function syncFromProps(value?: [number, number][], fit = false) {
  const next = normalize(value)
  if (samePoints(next, points.value)) return
  points.value = next
  areaMu.value = polygonAreaMu(next)
  draw()
  if (fit) fitToPoints()
}

function commit() {
  areaMu.value = polygonAreaMu(points.value)
  draw()
  emit('update:modelValue', points.value.map((point) => [...point] as [number, number]))
  emit('area-change', areaMu.value)
}

function handleMapClick(event: any) {
  const lng = Number(Number(event.latlng.lng).toFixed(6))
  const lat = Number(Number(event.latlng.lat).toFixed(6))
  const last = points.value[points.value.length - 1]
  if (last && last[0] === lng && last[1] === lat) return
  points.value = [...points.value, [lng, lat]]
  commit()
}

function undo() {
  if (points.value.length === 0) return
  points.value = points.value.slice(0, -1)
  commit()
}

function clear() {
  if (points.value.length === 0) return
  points.value = []
  commit()
}

onMounted(async () => {
  await nextTick()
  if (!mapEl.value) return
  map = L.map(mapEl.value, { zoomControl: true, attributionControl: false }).setView(DEFAULT_CENTER, DEFAULT_ZOOM)
  tiles = [tianditu('img'), tianditu('cia')]
  tiles.forEach((tile) => tile.addTo(map))
  shapeLayer = L.layerGroup().addTo(map)
  map.on('click', handleMapClick)
  if (toolbarEl.value) L.DomEvent.disableClickPropagation(toolbarEl.value)
  syncFromProps(props.modelValue, true)
  // 表单容器完成布局后再校正画布尺寸，避免地图只渲染左上角
  window.setTimeout(() => map?.invalidateSize(), 0)
})

watch(() => props.modelValue, (value) => syncFromProps(value, true), { deep: true })

onBeforeUnmount(() => {
  if (map) map.off('click', handleMapClick)
  tiles.forEach((tile) => tile.remove())
  tiles = []
  if (shapeLayer && map) map.removeLayer(shapeLayer)
  shapeLayer = null
  if (map) map.remove()
  map = null
})
</script>

<style scoped lang="scss">
.polygon-editor {
  position: relative;
  width: 100%;
  height: 420px;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  overflow: hidden;
}

.polygon-editor__map {
  width: 100%;
  height: 100%;
}

.polygon-editor__toolbar {
  position: absolute;
  z-index: 500;
  top: 12px;
  left: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.polygon-editor__count {
  color: #606266;
  font-size: 12px;
  white-space: nowrap;
}

.polygon-editor__hint {
  position: absolute;
  z-index: 500;
  right: 12px;
  bottom: 12px;
  padding: 6px 10px;
  color: #606266;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 4px;
  font-size: 12px;
}

:deep(.polygon-vertex-label) {
  padding: 0 4px;
  color: #fff;
  background: #409eff;
  border: 0;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
}

:deep(.polygon-vertex-label::before) {
  border-top-color: #409eff;
}
</style>
