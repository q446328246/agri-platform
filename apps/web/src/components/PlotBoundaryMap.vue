<template>
  <div class="boundary-map">
    <div ref="mapEl" class="boundary-map__canvas"></div>
    <div v-if="message" class="boundary-map__tip" :class="{ 'boundary-map__tip--empty': empty }">{{ message }}</div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { parsePlotBoundary, type PlotBoundary, type PlotBoundarySource } from '@/utils/geo'

const props = defineProps<{ source?: PlotBoundarySource | null }>()

const mapEl = ref<HTMLElement | null>(null)
const message = ref('')
const empty = ref(false)
let map: any = null
let layer: any = null
let tiles: any[] = []

function tianditu(layerName: string) {
  const key = import.meta.env.VITE_TIANDITU_KEY
  return L.tileLayer(
    'https://t{s}.tianditu.gov.cn/' + layerName + '_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layerName +
      '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=' + key,
    { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: 18 },
  )
}

/** 把地块边界画到地图上；没有边界时保留提示，避免空白画布。 */
function render(boundary: PlotBoundary | null) {
  if (!map) return
  if (layer) map.removeLayer(layer)
  layer = L.layerGroup()
  if (!boundary) {
    empty.value = true
    message.value = '服务端暂无地块边界，可先补全边界后查看'
    map.setView([30.982425, 107.421325], 15)
    return
  }
  empty.value = false
  boundary.rings.forEach((ring) => {
    L.polygon(ring, { color: '#00d4ff', weight: 2, fillColor: '#00d4ff', fillOpacity: 0.16 }).addTo(layer)
  })
  L.marker(boundary.center, {
    icon: L.divIcon({ className: 'boundary-label', html: '<span>' + boundary.name + '</span>', iconSize: [0, 0] }),
    interactive: false,
  }).addTo(layer)
  layer.addTo(map)
  const bounds = L.latLngBounds(boundary.rings[0] ?? [])
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] })
  message.value = boundary.name + ' · ' + boundary.areaMu.toFixed(2) + ' 亩'
}

function sync() {
  render(props.source ? parsePlotBoundary(props.source) : null)
}

onMounted(() => {
  if (!mapEl.value) return
  map = L.map(mapEl.value, { zoomControl: true, attributionControl: false })
  tiles = [tianditu('img'), tianditu('cia')]
  tiles.forEach((tile) => tile.addTo(map))
  sync()
})

watch(() => props.source, sync, { deep: true })

onBeforeUnmount(() => {
  tiles.forEach((tile) => tile.remove())
  tiles = []
  if (layer && map) map.removeLayer(layer)
  layer = null
  map.remove()
  map = null
})
</script>

<style scoped lang="scss">
.boundary-map { position: relative; width: 100%; height: 400px; border-radius: 8px; overflow: hidden; }
.boundary-map__canvas { width: 100%; height: 100%; }
.boundary-map__tip { position: absolute; z-index: 400; top: 10px; left: 10px; padding: 6px 12px; font-size: 12px; color: #fff; background: rgba(9, 30, 66, .82); border-radius: 4px; }
.boundary-map__tip--empty { color: #ff9c65; }
:deep(.boundary-label) { background: none; border: 0; }
:deep(.boundary-label span) { display: inline-block; padding: 2px 8px; font-size: 12px; color: #dff4f8; background: rgba(9, 30, 66, .78); border-radius: 4px; white-space: nowrap; }
</style>