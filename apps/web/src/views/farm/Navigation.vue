<template>
  <div class="page-container">
    <div class="card-container nav-toolbar">
      <el-radio-group v-model="mode" size="small" class="nav-mode" @change="onModeChange">
        <el-radio-button value="transfer">地块间转场</el-radio-button>
        <el-radio-button value="coverage">全地块覆盖</el-radio-button>
      </el-radio-group>

      <el-form :inline="true" @submit.prevent="plan">
        <el-form-item label="起点">
          <el-input v-model.number="start.lng" class="coord-input" placeholder="经度">
            <template #prepend>经度</template>
          </el-input>
          <el-input v-model.number="start.lat" class="coord-input" placeholder="纬度">
            <template #prepend>纬度</template>
          </el-input>
        </el-form-item>

        <template v-if="mode === 'transfer'">
          <el-form-item label="行进速度">
            <el-input-number v-model="speedKmh" :min="2" :max="30" :step="1" size="small" />
            <span class="nav-unit">km/h</span>
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="returnToStart">作业后返回起点</el-checkbox>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="幅宽">
            <el-input-number v-model="implementWidthM" :min="0.5" :max="24" :step="0.5" :precision="1" size="small" />
            <span class="nav-unit">m</span>
          </el-form-item>
          <el-form-item label="重叠">
            <el-input-number v-model="overlapM" :min="0" :max="5" :step="0.1" :precision="1" size="small" />
            <span class="nav-unit">m</span>
          </el-form-item>
          <el-form-item label="方向">
            <el-checkbox v-model="autoHeading" class="nav-auto">自动选</el-checkbox>
            <el-input-number v-model="headingDeg" :min="0" :max="179" :step="15" :disabled="autoHeading" size="small" />
            <span class="nav-unit">°</span>
          </el-form-item>
          <el-form-item label="作业/转移速度">
            <el-input-number v-model="workSpeedKmh" :min="1" :max="20" :step="0.5" :precision="1" size="small" />
            <el-input-number v-model="turnSpeedKmh" :min="2" :max="30" :step="1" size="small" />
            <span class="nav-unit">km/h</span>
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="withStart">从起点计入场里程</el-checkbox>
          </el-form-item>
        </template>

        <el-form-item>
          <el-button size="small" :type="picking ? 'warning' : 'default'" @click="picking = !picking">
            {{ picking ? '在地图上点选起点…' : '地图拾取起点' }}
          </el-button>
          <el-button size="small" type="primary" :loading="planning" :disabled="!canPlan" @click="plan">
            {{ mode === 'transfer' ? '规划路线' : '规划作业带' }}
          </el-button>
          <el-button size="small" :disabled="!planResult && !coverageResult" @click="clearPlan">清除方案</el-button>
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
          <span>{{ mode === 'transfer' ? '作业地块' : '目标地块' }}</span>
          <span class="nav-panel__meta">
            {{ mode === 'transfer' ? `已选 ${selected.length} / ${candidates.length}` : targetPlot ? targetPlot.name : `共 ${candidates.length} 块，点行选中` }}
          </span>
        </div>
        <el-table
          ref="tableRef"
          :data="candidates"
          height="268"
          size="small"
          border
          empty-text="暂无带边界的地块档案"
          :highlight-current-row="mode === 'coverage'"
          @selection-change="onSelection"
          @current-change="onTargetChange"
        >
          <el-table-column v-if="mode === 'transfer'" type="selection" width="44" />
          <el-table-column prop="name" label="地块" min-width="130" />
          <el-table-column prop="parcelCode" label="编码" width="220" />
          <el-table-column label="面积(亩)" width="90" align="right">
            <template #default="{ row }">{{ Number(row.areaMu ?? 0).toFixed(1) }}</template>
          </el-table-column>
        </el-table>
      </div>

      <div class="card-container nav-panel">
        <div class="nav-panel__head">
          <span>{{ mode === 'transfer' ? '导航方案' : '覆盖方案' }}</span>
          <span v-if="summary" class="nav-panel__meta">{{ summary }}</span>
        </div>
        <el-empty v-if="!planResult && !coverageResult" :description="mode === 'transfer' ? '勾选地块后点「规划路线」' : '点选一块地后点「规划作业带」'" :image-size="60" />
        <template v-else>
          <el-alert
            v-for="(warning, index) in warnings"
            :key="index"
            :title="warning"
            type="warning"
            :closable="false"
            show-icon
            class="nav-warning"
          />
          <el-table v-if="planResult" :data="planResult.legs" size="small" border max-height="236">
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
          <template v-else-if="coverageResult">
            <el-descriptions :column="4" size="small" border class="nav-desc">
              <el-descriptions-item label="作业方向">{{ coverageResult.headingDeg }}°{{ coverageResult.headingAuto ? '（自动）' : '' }}</el-descriptions-item>
              <el-descriptions-item label="带间距">{{ coverageResult.laneSpacingM }} 米</el-descriptions-item>
              <el-descriptions-item label="作业带">{{ coverageResult.laneCount }} 条</el-descriptions-item>
              <el-descriptions-item label="掉头">{{ coverageResult.turnCount }} 次</el-descriptions-item>
              <el-descriptions-item label="作业里程">{{ coverageResult.workDistanceM.toFixed(0) }} 米</el-descriptions-item>
              <el-descriptions-item label="转移里程">{{ coverageResult.transferDistanceM.toFixed(0) }} 米</el-descriptions-item>
              <el-descriptions-item label="预计耗时">{{ coverageResult.durationMin.toFixed(0) }} 分钟</el-descriptions-item>
              <el-descriptions-item label="覆盖倍数">{{ coverageResult.coverageRatio }}</el-descriptions-item>
            </el-descriptions>
            <el-table :data="coverageResult.lanes" size="small" border max-height="196">
              <el-table-column prop="index" label="顺序" width="60" align="center" />
              <el-table-column label="线段" width="80" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.pass > 1" size="small" type="warning">第 {{ row.pass }} 段</el-tag>
                  <span v-else>—</span>
                </template>
              </el-table-column>
              <el-table-column label="长度(米)" width="100" align="right">
                <template #default="{ row }">{{ row.lengthM.toFixed(0) }}</template>
              </el-table-column>
              <el-table-column label="端点">
                <template #default="{ row }">{{ pointText(row.coordinates[0]) }} → {{ pointText(row.coordinates[1]) }}</template>
              </el-table-column>
            </el-table>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { operationApi, plotApi } from '@/api'
import type { CoveragePlan, GeoLineString, GeoPolygon, NavPlan } from '@/api'
import type { Plot } from '@/types'
import { parsePlotBoundary } from '@/utils/geo'

/**
 * 田间作业规划，两种模式共用一张底图：
 * - 转场：勾选多块地当站点，规划「地块之间怎么走」，有机耕道时按沿路里程；
 * - 覆盖：点选一块地，按农具幅宽铺牛耕式作业带，规划「这块地内部怎么耕完」。
 */
const CENTER: [number, number] = [30.982425, 107.421325]

const mode = ref<'transfer' | 'coverage'>('transfer')
const start = reactive({ lng: 107.421325, lat: 30.982425 })
const picking = ref(false)
const planning = ref(false)
const mapTip = ref('加载地图数据中')

const speedKmh = ref(8)
const returnToStart = ref(false)
const implementWidthM = ref(6)
const overlapM = ref(0.5)
const autoHeading = ref(true)
const headingDeg = ref(0)
const workSpeedKmh = ref(6)
const turnSpeedKmh = ref(8)
const withStart = ref(false)

const allPlots = ref<Plot[]>([])
const candidates = ref<Plot[]>([])
const selected = ref<Plot[]>([])
const targetPlot = ref<Plot | null>(null)
const roadNetwork = ref<GeoLineString[]>([])
const planResult = ref<NavPlan | null>(null)
const coverageResult = ref<CoveragePlan | null>(null)
/** 站点坐标，绘制顺序号时复用 */
const stopPoints = ref<Array<{ code: string; name: string; lat: number; lng: number }>>([])

const mapEl = ref<HTMLElement | null>(null)
const tableRef = ref<any>(null)
let map: any = null
let tiles: any[] = []
let plotLayer: any = null
let roadLayer: any = null
let routeLayer: any = null

const canPlan = computed(() => (mode.value === 'transfer' ? selected.value.length > 0 : !!targetPlot.value))
const warnings = computed(() => coverageResult.value?.warnings ?? planResult.value?.warnings ?? [])
const summary = computed(() => {
  if (planResult.value) return `总里程 ${planResult.value.distanceM.toFixed(0)} 米 · 约 ${planResult.value.durationMin.toFixed(0)} 分钟`
  const plan = coverageResult.value
  if (plan) return `${plan.laneCount} 条作业带 · 总里程 ${plan.totalDistanceM.toFixed(0)} 米 · 约 ${plan.durationMin.toFixed(0)} 分钟`
  return ''
})

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

/** [经度, 纬度] → 可读文本，作业带表格展示端点用 */
function pointText(point?: number[]): string {
  if (!point || point.length < 2) return ''
  return `${Number(point[0]).toFixed(5)}, ${Number(point[1]).toFixed(5)}`
}

/** 地块几何 → GeoJSON Polygon：parsePlotBoundary 给的是 [纬度, 经度]，入库口径是 [经度, 纬度] */
function boundaryOf(plot: Plot): GeoPolygon | null {
  const boundary = parsePlotBoundary(plot as any)
  if (!boundary) return null
  return {
    type: 'Polygon',
    coordinates: boundary.rings.map((ring) => ring.map(([lat, lng]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))])),
    srid: 4490,
  }
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

/** 转场模式：画起点、站点顺序号与规划路线。 */
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

/** 覆盖模式：目标地块描边 + 作业带实线 + 掉头/入场虚线。 */
function renderCoverage() {
  if (!map) return
  if (routeLayer) map.removeLayer(routeLayer)
  routeLayer = L.layerGroup()
  const plot = targetPlot.value
  const plan = coverageResult.value
  if (plot) {
    const bounds = L.latLngBounds([])
    const boundary = parsePlotBoundary(plot as any)
    for (const ring of boundary?.rings ?? []) {
      L.polygon(ring, { color: '#f3c969', weight: 2, fillColor: '#f3c969', fillOpacity: 0.08 })
        .bindTooltip(`<strong>${boundary?.name ?? ''}</strong><br>${Number(plot.areaMu ?? 0).toFixed(2)} 亩`)
        .addTo(routeLayer)
      for (const point of ring) bounds.extend(point)
    }
    if (plan) {
      const toLatLng = (point: number[]) => [Number(point[1]), Number(point[0])] as [number, number]
      const lanes = plan.lanes
      for (let index = 0; index + 1 < lanes.length; index += 1) {
        const from = lanes[index]?.coordinates[1]
        const to = lanes[index + 1]?.coordinates[0]
        if (!from || !to) continue
        L.polyline([toLatLng(from), toLatLng(to)], { color: '#ff7043', weight: 2, dashArray: '4 6', opacity: 0.9 })
          .bindTooltip('地头掉头转移')
          .addTo(routeLayer)
      }
      for (const lane of lanes) {
        const points = lane.coordinates.map(toLatLng)
        if (points.length < 2) continue
        L.polyline(points, { color: '#00e676', weight: 3, opacity: 0.95 })
          .bindTooltip(`作业带 ${lane.index} · ${lane.lengthM.toFixed(0)} 米${lane.pass > 1 ? ` · 第 ${lane.pass} 段` : ''}`)
          .addTo(routeLayer)
        // 条数一多标号就糊成一片，只在可读范围内标注
        if (lanes.length <= 24) L.marker(points[0]!, { icon: label(String(lane.index), '#00e676') }).addTo(routeLayer)
      }
      const first = lanes[0]?.coordinates[0]
      if (withStart.value && first) {
        L.marker([start.lat, start.lng], { icon: label('起', '#f3c969') }).bindTooltip('入场起点').addTo(routeLayer)
        L.polyline([[start.lat, start.lng], toLatLng(first)], { color: '#ffca28', weight: 2, dashArray: '2 6' })
          .bindTooltip('入场')
          .addTo(routeLayer)
      }
    }
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] })
  }
  routeLayer.addTo(map)
}

function renderPlan() {
  if (mode.value === 'transfer') renderRoute()
  else renderCoverage()
}

async function loadData() {
  try {
    const [plots, lines] = await Promise.all([plotApi.getList({ page: 1, pageSize: 200 }), plotApi.getInfraLines({ lineType: 'ROAD' })])
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
  if (mode.value === 'transfer') selected.value = rows
}

function onTargetChange(row: Plot | null) {
  if (mode.value === 'coverage') targetPlot.value = row
}

function onModeChange() {
  planResult.value = null
  coverageResult.value = null
  selected.value = []
  targetPlot.value = null
  tableRef.value?.clearSelection?.()
  renderPlan()
}

async function planTransfer() {
  if (!Number.isFinite(Number(start.lng)) || !Number.isFinite(Number(start.lat))) {
    ElMessage.warning('请填写有效的起点经纬度，或在地图上拾取起点')
    return
  }
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
}

async function planCoverageNow() {
  const plot = targetPlot.value
  if (!plot) return
  const boundary = boundaryOf(plot)
  if (!boundary) {
    ElMessage.warning('目标地块缺少可用的边界几何，无法铺作业带')
    return
  }
  if (overlapM.value >= implementWidthM.value) {
    ElMessage.warning('重叠必须小于幅宽，否则作业带没有间距')
    return
  }
  coverageResult.value = await operationApi.planCoverage({
    plotCode: plot.parcelCode,
    boundary,
    implementWidthM: implementWidthM.value,
    overlapM: overlapM.value,
    speedKmh: workSpeedKmh.value,
    turnSpeedKmh: turnSpeedKmh.value,
    // 台账亩数交给服务端算覆盖倍数，与一张图上看到的亩数同一口径；没有亩数时由服务端按几何现算
    ...(Number(plot.areaMu) > 0 ? { areaMu: Number(plot.areaMu) } : {}),
    ...(autoHeading.value ? {} : { headingDeg: headingDeg.value }),
    ...(withStart.value ? { start: { lng: Number(start.lng), lat: Number(start.lat) } } : {}),
  })
}

async function plan() {
  planning.value = true
  try {
    if (mode.value === 'transfer') await planTransfer()
    else await planCoverageNow()
    renderPlan()
  } catch (error) {
    console.error('规划失败', error)
  } finally {
    planning.value = false
  }
}

function clearPlan() {
  planResult.value = null
  coverageResult.value = null
  stopPoints.value = []
  renderPlan()
}

onMounted(async () => {
  if (!mapEl.value) return
  map = L.map(mapEl.value, { center: CENTER, zoom: 15, attributionControl: false })
  tiles = [tianditu('img'), tianditu('cia')]
  tiles.forEach((tile) => tile.addTo(map))
  routeLayer = L.layerGroup().addTo(map)
  renderPlan()
  map.on('click', (event: any) => {
    if (!picking.value) return
    start.lat = Number(event.latlng.lat.toFixed(6))
    start.lng = Number(event.latlng.lng.toFixed(6))
    picking.value = false
    renderPlan()
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
.nav-toolbar { margin-bottom: 12px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.nav-mode { margin-left: 4px; }
.nav-toolbar :deep(.el-form-item) { margin-bottom: 0; }
.nav-toolbar :deep(.el-form-item__content) { gap: 6px; }
.coord-input { width: 190px; margin-right: 8px; }
.nav-auto { margin-right: 2px; }
.nav-unit { margin-left: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.nav-map-wrap { position: relative; margin-bottom: 12px; padding: 0; overflow: hidden; }
.nav-map { height: 420px; width: 100%; }
.nav-map__tip { position: absolute; z-index: 400; left: 12px; bottom: 12px; padding: 6px 10px; font-size: 12px; color: #fff; background: rgba(9, 30, 66, .78); border-radius: 4px; }
.nav-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.nav-panel { display: flex; flex-direction: column; }
.nav-panel__head { display: flex; align-items: center; gap: 6px; padding-bottom: 10px; font-size: 13px; font-weight: 600; }
.nav-panel__meta { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--el-text-color-secondary); }
.nav-warning { margin-bottom: 8px; }
.nav-desc { margin-bottom: 8px; }
.nav-desc :deep(.el-descriptions__label), .nav-desc :deep(.el-descriptions__content) { font-size: 12px; }
:deep(.nav-label) { background: none; border: 0; }
:deep(.nav-label span) { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 4px; font-size: 12px; font-weight: 600; color: #04202c; border-radius: 10px; box-shadow: 0 0 8px rgba(0, 212, 255, .6); }
@media (max-width: 1100px) { .nav-columns { grid-template-columns: 1fr; } }
</style>
