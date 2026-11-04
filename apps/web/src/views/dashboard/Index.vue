<template>
  <div class="dashboard">
    <div class="map-shell">
      <div id="tianditu-map"></div>
      <div class="map-toolbar" aria-label="地图图层控制">
        <button v-for="item in toolbarItems" :key="item.key" class="map-tool" :class="{ active: visibleLayers[item.key] }" type="button" :title="item.label" @click="toggleLayer(item.key)">
          <span class="map-tool__icon">{{ item.icon }}</span><span>{{ item.label }}</span>
        </button>
      </div>
      <div class="map-status"><span class="status-dot"></span><span>天地图 · 达州农情中心</span><i></i><span>{{ mapMessage }}</span><i></i><span>{{ weatherSummary }}</span></div>
    </div>

    <aside class="data-panel data-panel--left">
      <div class="panel-heading"><span class="heading-mark"></span><span>全域资源概览</span></div>
      <div class="metric-grid">
        <div class="metric-item"><span class="metric-label">地块数量</span><strong>{{ metrics.plotCount }}</strong><small>个</small></div><div class="metric-item"><span class="metric-label">总耕地面积</span><strong>{{ metrics.totalArea }}</strong><small>亩</small></div><div class="metric-item"><span class="metric-label">在线设备</span><strong>{{ metrics.onlineDevices }}</strong><small>台</small></div><div class="metric-item"><span class="metric-label">待处理预警</span><strong>{{ metrics.pendingAlerts }}</strong><small>条</small></div>
      </div>
      <div class="panel-heading panel-heading--sub"><span class="heading-mark"></span><span>运行状态</span></div>
      <div class="status-list">
        <div class="status-row"><span>在线设备</span><span :class="runtimeState.deviceOnline.className">{{ runtimeState.deviceOnline.value }}</span></div><div class="status-row"><span>离线设备</span><span :class="runtimeState.deviceOffline.className">{{ runtimeState.deviceOffline.value }}</span></div><div class="status-row"><span>地块数量</span><span :class="runtimeState.plotCount.className">{{ runtimeState.plotCount.value }}</span></div><div class="status-row"><span>土壤墒情</span><span :class="runtimeState.soilMoisture.className">{{ runtimeState.soilMoisture.value }}</span></div><div class="status-row"><span>气象站状态</span><span :class="runtimeState.weatherStation.className">{{ runtimeState.weatherStation.value }}</span></div>
      </div>
      <div class="panel-alert"><span class="alert-dot"></span><span>{{ alertCount }} 条农情预警待处理</span><b>›</b></div>
    </aside>

    <aside class="data-panel data-panel--right">
      <div class="panel-heading"><span class="heading-mark"></span><span>农情分析</span></div>
      <section class="analysis-section">
        <div class="section-title">地块结构 <span>面积占比</span></div>
        <div class="crop-bars"><div v-for="crop in crops" :key="crop.name" class="crop-row"><span>{{ crop.name }}</span><div class="crop-bar"><i :style="{ width: crop.percent + '%', background: crop.color }"></i></div><strong>{{ crop.percent }}%</strong></div></div>
      </section>
      <section class="analysis-section"><div class="section-title">产量预估 <span>年度统计</span></div><div class="yield-value">46,800 <small>吨</small></div><div class="yield-caption">平均亩产 <b>376.5 kg</b></div></section>
      <section class="analysis-section analysis-section--alert"><div class="section-title">当前倒伏面积 <span>需要关注</span></div><div class="warning-value">320 <small>亩</small></div><div class="warning-caption">占全域耕地面积 <b>0.26%</b></div></section>
    </aside>

    <div class="trend-panel">
      <div class="trend-header"><span class="panel-heading panel-heading--inline"><span class="heading-mark"></span>近 7 日农情趋势</span><div class="trend-legend"><span><i class="legend-line legend-line--cyan"></i>大豆出苗率</span><span><i class="legend-line legend-line--yellow"></i>玉米出苗率</span><span><i class="legend-line legend-line--green"></i>长势指数</span></div></div>
      <div class="trend-chart"><span v-for="line in chartLines" :key="line" class="chart-line" :class="line"></span><div class="chart-axis"><span v-for="day in days" :key="day">{{ day }}</span></div></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { iotApi, plotApi, telemetryApi, weatherApi } from '@/api'
import { parsePlotBoundaries, type PlotBoundary, type PlotBoundarySource } from '@/utils/geo'

type LayerKey = 'base' | 'devices' | 'fields'
const tiandituKey = import.meta.env.VITE_TIANDITU_KEY
const visibleLayers = reactive<Record<LayerKey, boolean>>({ base: true, devices: true, fields: true })
const toolbarItems: Array<{ key: LayerKey; label: string; icon: string }> = [
  { key: 'base', label: '影像底图', icon: '▧' }, { key: 'devices', label: '设备点位', icon: '◎' }, { key: 'fields', label: '地块边界', icon: '▦' },
]
const metrics = reactive({
  plotCount: '—',
  totalArea: '—',
  onlineDevices: '—',
  pendingAlerts: '—',
})
const runtimeState = reactive({
  deviceOnline: { value: '加载中', className: '' },
  deviceOffline: { value: '—', className: 'good' },
  plotCount: { value: '—', className: '' },
  soilMoisture: { value: '—', className: '' },
  weatherStation: { value: '加载中', className: '' },
})
const crops = ref<Array<{ name: string; percent: number; color: string }>>([])
const mapMessage = ref('地块边界加载中')
const weatherSummary = ref('实时数据加载中')
const alertCount = ref(0)
const days = ['10/28', '10/29', '10/30', '10/31', '11/01', '11/02', '11/03']
const chartLines = ['chart-line--cyan', 'chart-line--yellow', 'chart-line--green']

let map: any = null
let baseLayers: { vector: any; imagery: any } | null = null
let deviceLayer: any = null
let fieldLayer: any = null
let baseKey: 'imagery' | 'vector' = 'imagery'
const tileOptions = { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: 18 }

const cropPalette = ['#00d4ff', '#f3c969', '#00e676', '#ff8a65', '#b388ff', '#69f0ae']
function cropColor(name: string, index: number): string {
  const table: Record<string, string> = { 大豆: '#00d4ff', 玉米: '#f3c969', 水稻: '#00e676', 小麦: '#ffd54f', 油菜: '#ff8a65', 蔬菜: '#69f0ae', 果树: '#b388ff', other: '#b388ff' }
  return table[name] ?? (cropPalette[index % cropPalette.length] as string)
}

function createTiles(layer: string) {
  return L.tileLayer(`https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${tiandituKey}`, { ...tileOptions })
}

function toggleLayer(key: LayerKey) {
  visibleLayers[key] = !visibleLayers[key]
  if (!map) return
  if (key === 'base' && baseLayers) {
    const next: 'imagery' | 'vector' = visibleLayers.base ? 'imagery' : 'vector'
    map.removeLayer(baseLayers[baseKey])
    baseKey = next
    baseLayers[baseKey].addTo(map)
  }
  if (key === 'devices' && deviceLayer) visibleLayers.devices ? deviceLayer.addTo(map) : map.removeLayer(deviceLayer)
  if (key === 'fields' && fieldLayer) visibleLayers.fields ? fieldLayer.addTo(map) : map.removeLayer(fieldLayer)
}

/** 把服务端地块边界画到地图上；没有边界时保留可切换的空图层与提示。 */
function renderFields(list: PlotBoundary[]) {
  if (!fieldLayer || !map) return
  map.removeLayer(fieldLayer)
  if (!list.length) {
    fieldLayer = L.layerGroup()
  } else {
    const shapes = list.map((boundary, index) => {
      const ring = boundary.rings[0]
      const color = cropColor(boundary.crop ?? boundary.name, index)
      const shape = ring
        ? L.polygon(ring, { color, weight: 1.5, fillColor: color, fillOpacity: 0.14 }).bindTooltip(
          `<strong>${boundary.name}</strong><br>${boundary.areaMu.toFixed(2)} 亩${boundary.crop ? ` · ${boundary.crop}` : ''}`,
        )
        : null
      return shape
    }).filter((shape): shape is any => !!shape)
    fieldLayer = L.layerGroup(shapes)
  }
  if (visibleLayers.fields) fieldLayer.addTo(map)
  if (list.length) {
    const fitBounds = L.latLngBounds(list.flatMap((item) => item.rings[0] ?? []))
    if (fitBounds.isValid()) map.fitBounds(fitBounds, { padding: [60, 60] })
  }
}

/** 后端地块数据缺失时的演示边界，保证一张图仍可展示。 */
function demoBoundaries(): PlotBoundary[] {
  const rect = (name: string, parcelCode: string, areaMu: number, crop: string, coords: [number, number][]): PlotBoundary => ({
    name, parcelCode, rings: [coords], center: [0, 0], areaMu, crop,
  })
  return [
    rect('达州示范田 · 大豆区', 'demo-soybean', 4860, '大豆', [[31.235, 107.435], [31.247, 107.458], [31.229, 107.472], [31.217, 107.447], [31.235, 107.435]]),
    rect('达州示范田 · 玉米区', 'demo-corn', 2830, '玉米', [[31.188, 107.485], [31.202, 107.51], [31.181, 107.527], [31.168, 107.5], [31.188, 107.485]]),
  ]
}

function initMap() {
  map = L.map('tianditu-map', { center: [31.2096, 107.4679], zoom: 12, zoomControl: true, attributionControl: false })
  const vector = L.layerGroup([createTiles('vec'), createTiles('cva')])
  const imagery = L.layerGroup([createTiles('img'), createTiles('cia')])
  baseKey = visibleLayers.base ? 'imagery' : 'vector'
  baseLayers = { vector, imagery }
  baseLayers[baseKey].addTo(map)
  fieldLayer = L.layerGroup().addTo(map)
}

/** 用地块面积与作物汇总看板指标；作物缺失时按名称聚合为“未标注”。 */
function applyPlotStats(list: PlotBoundary[]) {
  const fields = list.filter((item) => item.areaMu > 0)
  if (!fields.length) return
  const totalArea = fields.reduce((sum, item) => sum + item.areaMu, 0)
  metrics.plotCount = String(fields.length)
  metrics.totalArea = totalArea.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  runtimeState.plotCount.value = `${fields.length} 个`
  const byCrop = new Map<string, number>()
  for (const item of fields) {
    const key = item.crop?.trim() || '未标注'
    byCrop.set(key, (byCrop.get(key) ?? 0) + item.areaMu)
  }
  const sorted = [...byCrop.entries()].sort((a, b) => b[1] - a[1])
  crops.value = sorted.map(([name, areaMu], index) => ({
    name,
    percent: totalArea > 0 ? Math.round((areaMu / totalArea) * 100) : 0,
    color: cropColor(name === '未标注' ? 'other' : name, index),
  }))
}

async function loadPlots() {
  try {
    const list = await plotApi.getList({ page: 1, pageSize: 200 })
    const parsed = parsePlotBoundaries(list.items as PlotBoundarySource[])
    if (parsed.length) {
      renderFields(parsed)
      applyPlotStats(parsed)
      mapMessage.value = `已加载 ${parsed.length} 个地块边界`
      return
    }
    mapMessage.value = '服务端暂无地块边界，展示示范边界'
    renderFields(demoBoundaries())
  } catch {
    mapMessage.value = '地块边界加载失败，展示示范边界'
    renderFields(demoBoundaries())
  }
}

async function loadPlotStats() {
  try {
    const stats = await plotApi.getStats()
    if (stats.totalPlots > 0) {
      metrics.plotCount = String(stats.totalPlots)
      metrics.totalArea = stats.totalAreaMu.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
      if (stats.soilTypes.length) {
        const total = stats.soilTypes.reduce((sum, item) => sum + item.areaMu, 0)
        crops.value = stats.soilTypes.map((item, index) => ({
          name: item.name,
          percent: total > 0 ? Math.round((item.areaMu / total) * 100) : 0,
          color: cropColor(item.name, index),
        }))
      }
    }
  } catch {
    // stats 拉取失败时沿用边界聚合结果，不影响地图
  }
}

function loadDevices(devices: Array<{ status?: string | undefined }>) {
  const online = devices.filter((device) => device.status === 'ONLINE').length
  const offline = devices.length - online
  metrics.onlineDevices = String(online)
  runtimeState.deviceOnline.value = `${online} / ${devices.length}`
  runtimeState.deviceOffline.value = `${offline}`
  runtimeState.deviceOffline.className = offline > online ? 'warning' : 'good'
}

async function loadSensing() {
  try {
    const [devices, readings, alerts, weather] = await Promise.all([
      iotApi.getDevices(),
      telemetryApi.getLatest('device-soil-003'),
      telemetryApi.getAlerts(),
      weatherApi.getForecast(),
    ])
    loadDevices(devices.items)
    const soilMoisture = readings.find((item) => item.metric === 'soilMoisture')
    if (soilMoisture) runtimeState.soilMoisture.value = `墒情 ${soilMoisture.value}%`
    alertCount.value = alerts.length
    metrics.pendingAlerts = String(alerts.length)
    const today = weather.forecast[0]
    if (today) weatherSummary.value = `${weather.location} ${today.weather} ${today.tempMin}-${today.tempMax}°C`
    runtimeState.weatherStation.value = '正常'
    runtimeState.weatherStation.className = 'good'
  } catch {
    mapMessage.value = mapMessage.value === '地块边界加载中' ? '感知数据加载失败' : mapMessage.value
    weatherSummary.value = '气象数据暂不可用'
    runtimeState.weatherStation.value = '数据异常'
    runtimeState.weatherStation.className = 'warning'
  }
}

onMounted(initMap)
onMounted(() => void loadPlots())
onMounted(() => void loadPlotStats())
onMounted(() => void loadSensing())
onUnmounted(() => { map?.remove(); map = null })
</script>

<style scoped lang="scss">
.dashboard { position: relative; width: 100%; height: 100%; overflow: hidden; background: #061026; color: #e8f5ff; font-family: "Microsoft YaHei", sans-serif; }
.map-shell, #tianditu-map { position: absolute; inset: 0; width: 100%; height: 100%; }
.map-shell { z-index: 1; background: #091b2e; }.map-shell::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: rgba(4, 14, 31, .28); }
.map-toolbar { position: absolute; top: 22px; left: 24px; z-index: 500; display: flex; flex-direction: column; gap: 6px; }.map-tool { display: flex; align-items: center; gap: 8px; min-width: 94px; padding: 8px 10px; border: 1px solid rgba(0, 212, 255, .34); border-radius: 3px; background: rgba(7, 25, 48, .88); color: #a9c3d2; cursor: pointer; font-size: 12px; text-align: left; backdrop-filter: blur(8px); }.map-tool:hover, .map-tool.active { border-color: #00d4ff; color: #fff; background: rgba(0, 98, 133, .62); }.map-tool__icon { width: 16px; color: #00d4ff; font-size: 16px; text-align: center; }
.map-status { position: absolute; right: 24px; bottom: 178px; z-index: 500; display: flex; align-items: center; gap: 8px; padding: 7px 10px; color: #b6d2de; background: rgba(7, 25, 48, .82); border: 1px solid rgba(0, 212, 255, .24); font-size: 11px; }.map-status i { width: 1px; height: 12px; background: rgba(255,255,255,.22); }.status-dot, .alert-dot { width: 7px; height: 7px; border-radius: 50%; background: #00e676; box-shadow: 0 0 8px #00e676; }
.data-panel, .trend-panel { position: absolute; z-index: 400; background: rgba(5, 18, 40, .9); border-color: rgba(0, 212, 255, .25); backdrop-filter: blur(10px); }.data-panel--left { inset: 0 auto 128px 0; width: 248px; padding: 20px 18px; border-right: 1px solid; }.data-panel--right { inset: 0 0 128px auto; width: 294px; padding: 20px 18px; border-left: 1px solid; }
.panel-heading { display: flex; align-items: center; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid rgba(0, 212, 255, .2); color: #00d4ff; font-size: 14px; font-weight: 600; }.panel-heading--sub { margin-top: 26px; font-size: 13px; }.panel-heading--inline { padding: 0; border: 0; font-size: 13px; }.heading-mark { width: 3px; height: 15px; background: #00d4ff; box-shadow: 0 0 7px #00d4ff; }
.metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 17px 12px; padding: 20px 0 4px; }.metric-item { display: grid; grid-template-columns: 1fr auto; align-items: baseline; }.metric-label { grid-column: 1 / -1; color: #7794a5; font-size: 11px; margin-bottom: 5px; }.metric-item strong { color: #fff; font-size: 20px; font-variant-numeric: tabular-nums; }.metric-item small { color: #7c98a9; font-size: 10px; margin-left: 4px; }.status-list { padding: 12px 0; }.status-row { display: flex; justify-content: space-between; padding: 8px 0; color: #8ba7b5; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,.06); }.status-row .good { color: #00e676; }.status-row .warning { color: #ff8a65; }.status-row .warning { color: #ff8a65; }.panel-alert { display: flex; align-items: center; gap: 8px; padding: 11px 10px; color: #ffb46e; background: rgba(255, 138, 101, .1); border: 1px solid rgba(255, 138, 101, .25); font-size: 11px; }.panel-alert .alert-dot { background: #ff8a65; box-shadow: 0 0 8px #ff8a65; }.panel-alert b { margin-left: auto; font-size: 18px; }
.analysis-section { padding: 17px 0; border-bottom: 1px solid rgba(255,255,255,.08); }.section-title { display: flex; justify-content: space-between; color: #b8d0da; font-size: 12px; }.section-title span { color: #668493; font-size: 10px; }.crop-bars { padding-top: 14px; }.crop-row { display: grid; grid-template-columns: 35px 1fr 34px; align-items: center; gap: 8px; margin: 11px 0; color: #9cb6c1; font-size: 11px; }.crop-bar { height: 5px; background: rgba(255,255,255,.1); }.crop-bar i { display: block; height: 100%; }.crop-row strong { color: #e9f4f6; font-size: 11px; text-align: right; }.yield-value, .warning-value { padding-top: 11px; color: #00d4ff; font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }.yield-value small, .warning-value small { color: #8ca9b6; font-size: 12px; font-weight: 400; }.yield-caption, .warning-caption { padding-top: 5px; color: #718e9c; font-size: 11px; }.yield-caption b, .warning-caption b { color: #d8ecf1; font-weight: 400; }.analysis-section--alert .warning-value { color: #ff9c65; }
.trend-panel { right: 0; bottom: 0; left: 0; height: 128px; padding: 15px 28px; border-top: 1px solid; }.trend-header { display: flex; align-items: center; justify-content: space-between; }.trend-legend { display: flex; gap: 18px; color: #91aab6; font-size: 10px; }.trend-legend span { display: flex; align-items: center; gap: 5px; }.legend-line { width: 18px; height: 2px; display: inline-block; }.legend-line--cyan { background: #00d4ff; }.legend-line--yellow { background: #f3c969; }.legend-line--green { background: #00e676; }.trend-chart { position: relative; height: 76px; margin: 5px 0 0 42px; border-bottom: 1px solid rgba(160, 200, 220, .25); background: repeating-linear-gradient(to bottom, transparent 0, transparent 24px, rgba(160, 200, 220, .09) 25px); }.chart-line { position: absolute; left: 2%; width: 94%; height: 55px; opacity: .9; clip-path: polygon(0 70%, 8% 61%, 16% 66%, 25% 41%, 34% 48%, 43% 28%, 52% 38%, 61% 23%, 70% 29%, 79% 11%, 88% 17%, 100% 2%, 100% 5%, 88% 20%, 79% 14%, 70% 32%, 61% 26%, 52% 41%, 43% 31%, 34% 51%, 25% 44%, 16% 69%, 8% 64%, 0 73%); }.chart-line--cyan { top: 7px; background: #00d4ff; }.chart-line--yellow { top: 16px; background: #f3c969; transform: scaleY(.78); }.chart-line--green { top: 25px; background: #00e676; transform: scaleY(.62); }.chart-axis { position: absolute; right: 0; bottom: -18px; left: 0; display: flex; justify-content: space-between; color: #698592; font-size: 10px; }
:deep(.leaflet-control-zoom) { display: block; margin: 24px 24px 0 0; border: 0; }:deep(.leaflet-control-zoom a) { color: #b9e6ef; background: rgba(7, 25, 48, .85); border-color: rgba(0, 212, 255, .25); }:deep(.leaflet-popup-content-wrapper), :deep(.leaflet-popup-tip) { color: #dff4f8; background: #0b2943; }:deep(.leaflet-popup-content) { margin: 11px 14px; font-size: 12px; line-height: 1.8; }:deep(.leaflet-popup-content strong) { color: #00d4ff; }
@media (max-width: 900px) { .data-panel--left { width: 210px; }.data-panel--right { width: 240px; }.trend-legend { display: none; }.map-status { bottom: 145px; right: 12px; } }
</style>














