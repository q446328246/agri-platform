<template>
  <div class="page-container">
    <div class="card-container nav-toolbar">
      <el-form :inline="true" @submit.prevent="plan">
        <el-form-item label="起点">
          <el-input v-model.number="start.lng" class="coord-input" placeholder="经度">
            <template #prepend>经度</template>
          </el-input>
          <el-input v-model.number="start.lat" class="coord-input" placeholder="纬度">
            <template #prepend>纬度</template>
          </el-input>
        </el-form-item>
        <el-form-item label="行进速度">
          <el-input-number v-model="speedKmh" :min="2" :max="30" :step="1" size="small" />
          <span class="nav-unit">km/h</span>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="returnToStart">作业后返回起点</el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button size="small" :type="picking ? 'warning' : 'default'" @click="picking = !picking">
            {{ picking ? '在地图上点选起点…' : '地图拾取起点' }}
          </el-button>
          <el-button size="small" type="primary" :loading="planning" :disabled="!selected.length" @click="plan">
            规划路线
          </el-button>
          <el-button size="small" :disabled="!planResult" @click="clearPlan">清除方案</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div class="card-container nav-map-wrap">
      <div ref="mapEl" class="nav-map"></div>
      <div class="nav-map__tip">{{ mapTip }}</div>
    </div>

    <div class="nav-columns">
      <div class="card-container nav-panel">
        <div class="nav-panel__head">
          <span>作业地块</span>
          <span class="nav-panel__meta">已选 {{ selected.length }} / {{ candidates.length }}</span>
        </div>
        <el-table
          :data="candidates"
          height="268"
          size="small"
          border
          empty-text="暂无带边界的地块档案"
          @selection-change="onSelection"
        >
          <el-table-column type="selection" width="44" />
          <el-table-column prop="name" label="地块" min-width="130" />
          <el-table-column prop="parcelCode" label="编码" width="220" />
          <el-table-column label="面积(亩)" width="90" align="right">
            <template #default="{ row }">{{ Number(row.areaMu ?? 0).toFixed(1) }}</template>
          </el-table-column>
        </el-table>
      </div>

      <div class="card-container nav-panel">
        <div class="nav-panel__head">
          <span>导航方案</span>
          <span v-if="planResult" class="nav-panel__meta">
            总里程 {{ planResult.distanceM.toFixed(0) }} 米 · 约 {{ planResult.durationMin.toFixed(0) }} 分钟
          </span>
        </div>
        <el-empty v-if="!planResult" description="勾选地块后点「规划路线」" :image-size="60" />
        <template v-else>
          <el-alert
            v-for="(warning, index) in planResult.warnings"
            :key="index"
            :title="warning"
            type="warning"
            :closable="false"
            show-icon
            class="nav-warning"
          />
          <el-table :data="planResult.legs" size="small" border max-height="236">
            <el-table-column type="index" label="#" width="46" />
            <el-table-column label="路段" min-width="170">
              <template #default="{ row }">{{ row.fromName }} → {{ row.toName }}</template>
            </el-table-column>
            <el-table-column label="里程(米)" width="96" align="right">
              <template #default="{ row }">{{ row.distanceM.toFixed(0) }}</template>
            </el-table-column>
            <el-table-column label="耗时(分)" width="92" align="right">
              <template #default="{ row }">{{ row.durationMin.toFixed(1) }}</template>
            </el-table-column>
            <el-table-column label="口径" width="86" align="center">
              <template #default="{ row }">
                <el-tag size="small" :type="row.viaRoad ? 'success' : 'info'">{{ row.viaRoad ? '机耕道' : '直线' }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { operationApi, plotApi } from '@/api'
import type { GeoLineString, NavPlan } from '@/api'
import type { Plot } from '@/types'
import { parsePlotBoundary } from '@/utils/geo'

/**
 * 田间导航：勾选作业地块作为站点，起点可在地图上拾取。
 * 机耕道来自地块管线（ROAD），有路网时按沿路里程计算，否则退回直线估算。
 */
const CENTER: [number, number] = [30.982425, 107.421325]

const start = reactive({ lng: 107.421325, lat: 30.982425 })
const speedKmh = ref(8)
const returnToStart = ref(false)
const picking = ref(false)
const planning = ref(false)
const mapTip = ref('加载地图数据中')

const allPlots = ref<Plot[]>([])
const candidates = ref<Plot[]>([])
const selected = ref<Plot[]>([])
const roadNetwork = ref<GeoLineString[]>([])
const planResult = ref<NavPlan | null>(null)
/** 站点坐标，绘制顺序号时复用 */
const stopPoints = ref<Array<{ code: string; name: string; lat: number; lng: number }>>([])

const mapEl = ref<HTMLElement | null>(null)
let map: any = null
let tiles: any[] = []
let plotLayer: any = null
let roadLayer: any = null
let routeLayer: any = null

function tianditu(layerName: string) {
  const key = import.meta.env.VITE_TIANDITU_KEY
  return L.tileLayer(
    'https://t{s}.tianditu.gov.cn/' + layerName + '_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layerName +
      '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=' + key,
    { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: 18 },
  )
}

function label(html: string, background = '#00d4ff'): any {
  return L.divIcon({ className: 'nav-label', html: `<span style="background:${background}">${html}</span>`, iconSize: [0, 0] })
}

/** 画全部地块与机耕道，作为选站点的底图。 */
function renderBase() {
  if (!map) return
  if (plotLayer) map.removeLayer(plotLayer)
  if (roadLayer) map.removeLayer(roadLayer)
  plotLayer = L.layerGroup()
  roadLayer = L.layerGroup()
  const bounds = L.latLngBounds([])
  for (const plot of allPlots.value) {
    const boundary = parsePlotBoundary(plot as any)
    for (const ring of boundary?.rings ?? []) {
      L.polygon(ring, { color: '#7fd4ff', weight: 1, fillColor: '#7fd4ff', fillOpacity: 0.12 })
        .bindTooltip(`<strong>${boundary?.name ?? ''}</strong><br>${Number(plot.areaMu ?? 0).toFixed(2)} 亩`)
        .addTo(plotLayer)
      for (const point of ring) bounds.extend(point)
    }
  }
  for (const road of roadNetwork.value) {
    const points = road.coordinates.map((point) => [Number(point[1]), Number(point[0])] as [number, number])
    if (points.length >= 2) L.polyline(points, { color: '#b0bec5', weight: 3, dashArray: '6 6' }).bindTooltip('机耕道').addTo(roadLayer)
  }
  plotLayer.addTo(map)
  roadLayer.addTo(map)
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] })
}

/** 画起点、站点顺序号与规划路线。 */
function renderRoute() {
  if (!map) return
  if (routeLayer) map.removeLayer(routeLayer)
  routeLayer = L.layerGroup()
  L.marker([start.lat, start.lng], { icon: label('起', '#f3c969') }).bindTooltip('起点').addTo(routeLayer)
  const plan = planResult.value
  if (plan) {
    const order = new Map(plan.order.map((code, index) => [code, index + 1]))
    for (const stop of stopPoints.value) {
      L.marker([stop.lat, stop.lng], { icon: label(String(order.get(stop.code) ?? '·'), '#00d4ff') })
        .bindTooltip(`${order.get(stop.code) ?? ''}. ${stop.name}`)
        .addTo(routeLayer)
    }
    const points = plan.polyline.coordinates.map((point) => [Number(point[1]), Number(point[0])] as [number, number])
    if (points.length >= 2) {
      L.polyline(points, { color: '#00e676', weight: 4, opacity: 0.9 })
        .bindTooltip(`规划路线 · ${plan.distanceM.toFixed(0)} 米`)
        .addTo(routeLayer)
    }
  }
  routeLayer.addTo(map)
}

async function loadData() {
  try {
    const [plots, lines] = await Promise.all([plotApi.getList({ page: 1, pageSize: 200 }), plotApi.getInfraLines('ROAD')])
    allPlots.value = plots.items
    roadNetwork.value = lines
      .filter((line) => Array.isArray(line.geom?.coordinates) && line.geom.coordinates.length >= 2)
      .map((line) => line.geom)
    candidates.value = plots.items.filter((plot) => !!parsePlotBoundary(plot as any))
    renderBase()
    mapTip.value = `已加载 ${candidates.value.length} 块地块边界 · ${roadNetwork.value.length} 条机耕道`
  } catch (error) {
    mapTip.value = '地块或机耕道加载失败，仍可按直线距离规划'
    console.error('加载导航底图失败', error)
  }
}

function onSelection(rows: Plot[]) {
  selected.value = rows
}

async function plan() {
  if (!selected.value.length) return
  if (!Number.isFinite(Number(start.lng)) || !Number.isFinite(Number(start.lat))) {
    ElMessage.warning('请填写有效的起点经纬度，或在地图上拾取起点')
    return
  }
  planning.value = true
  try {
    stopPoints.value = selected.value.map((plot) => {
      const center = parsePlotBoundary(plot as any)?.center ?? CENTER
      return { code: plot.parcelCode, name: plot.name, lat: center[0], lng: center[1] }
    })
    planResult.value = await operationApi.planNavigation({
      start: { code: 'START', name: '起点', lng: Number(start.lng), lat: Number(start.lat) },
      stops: stopPoints.value,
      speedKmh: speedKmh.value,
      returnToStart: returnToStart.value,
      roadNetwork: roadNetwork.value,
    })
    renderRoute()
  } catch (error) {
    console.error('规划路线失败', error)
  } finally {
    planning.value = false
  }
}

function clearPlan() {
  planResult.value = null
  stopPoints.value = []
  renderRoute()
}

onMounted(async () => {
  if (!mapEl.value) return
  map = L.map(mapEl.value, { center: CENTER, zoom: 15, attributionControl: false })
  tiles = [tianditu('img'), tianditu('cia')]
  tiles.forEach((tile) => tile.addTo(map))
  routeLayer = L.layerGroup().addTo(map)
  renderRoute()
  map.on('click', (event: any) => {
    if (!picking.value) return
    start.lat = Number(event.latlng.lat.toFixed(6))
    start.lng = Number(event.latlng.lng.toFixed(6))
    picking.value = false
    renderRoute()
  })
  await loadData()
})

onBeforeUnmount(() => {
  tiles.forEach((tile) => tile.remove())
  tiles = []
  for (const layer of [plotLayer, roadLayer, routeLayer]) if (layer && map) map.removeLayer(layer)
  plotLayer = roadLayer = routeLayer = null
  map?.remove()
  map = null
})
</script>

<style scoped lang="scss">
.nav-toolbar { margin-bottom: 12px; }
.nav-toolbar :deep(.el-form-item) { margin-bottom: 0; }
.coord-input { width: 190px; margin-right: 8px; }
.nav-unit { margin-left: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.nav-map-wrap { position: relative; margin-bottom: 12px; padding: 0; overflow: hidden; }
.nav-map { height: 420px; width: 100%; }
.nav-map__tip { position: absolute; z-index: 400; left: 12px; bottom: 12px; padding: 6px 10px; font-size: 12px; color: #fff; background: rgba(9, 30, 66, .78); border-radius: 4px; }
.nav-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.nav-panel { display: flex; flex-direction: column; }
.nav-panel__head { display: flex; align-items: center; gap: 6px; padding-bottom: 10px; font-size: 13px; font-weight: 600; }
.nav-panel__meta { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--el-text-color-secondary); }
.nav-warning { margin-bottom: 8px; }
:deep(.nav-label) { background: none; border: 0; }
:deep(.nav-label span) { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 4px; font-size: 12px; font-weight: 600; color: #04202c; border-radius: 10px; box-shadow: 0 0 8px rgba(0, 212, 255, .6); }
@media (max-width: 1100px) { .nav-columns { grid-template-columns: 1fr; } }
</style>
