<template>
  <div class="cockpit">
    <!-- 全屏卫星底图 -->
    <div id="tianditu-map"></div>

    <!-- 左侧功能菜单树：可跳转项走路由，图层项就地切换 -->
    <aside class="func-menu" :class="{ collapsed: menuCollapsed }">
      <div class="func-menu__head">
        <span class="brand-dot"></span>
        <span v-if="!menuCollapsed" class="brand-title">智耘蜀芯 · 一张图</span>
        <button class="collapse-btn" type="button" :title="menuCollapsed ? '展开' : '收起'" @click="menuCollapsed = !menuCollapsed">
          {{ menuCollapsed ? '›' : '‹' }}
        </button>
      </div>

      <div v-show="!menuCollapsed" class="func-menu__body">
        <section v-for="group in menuGroups" :key="group.title" class="menu-group">
          <button class="group-head" type="button" @click="toggleGroup(group.title)">
            <span class="group-icon" v-html="group.icon"></span>
            <span class="group-title">{{ group.title }}</span>
            <span class="group-caret" :class="{ open: openGroups[group.title] }">⌄</span>
          </button>
          <div v-show="openGroups[group.title]" class="group-items">
            <button
              v-for="item in group.items.filter((i) => allowed(i.perm))"
              :key="item.label"
              class="menu-item"
              :class="{ 'menu-item--layer': item.layer, active: (item.layer && lineState[item.layer]) || (item.panel && activePanel === item.panel) }"
              type="button"
              @click="handleMenu(item)"
            >
              <span v-if="item.layer" class="swatch" :style="{ background: lineColor(item.layer) }"></span>
              <span v-else class="item-dot"></span>
              <span class="item-label">{{ item.label }}</span>
            </button>
          </div>
        </section>
      </div>
    </aside>

    <!-- 右上：控制簇（消息 / 用户） -->
    <div class="ctl-cluster">
      <button v-if="allowed('message:read')" class="ctl-btn" type="button" title="消息中心" @click="handleCommand('message')">
        <span class="ctl-ico">✉</span>
        <span v-if="unread > 0" class="ctl-badge">{{ unread > 99 ? '99+' : unread }}</span>
      </button>
      <div class="ctl-user" @click="userMenu = !userMenu">
        <span class="ctl-avatar">{{ userName.slice(0, 1) }}</span>
        <span class="ctl-name">{{ userName }}</span>
        <span class="ctl-caret">▾</span>
        <div v-if="userMenu" class="ctl-menu">
          <button type="button" @click.stop="handleCommand('message')">消息中心</button>
          <button type="button" class="danger" @click.stop="handleCommand('logout')">退出登录</button>
        </div>
      </div>
    </div>

    <!-- 右上：图层可视 + 管线图例（面板打开时隐藏） -->
    <div v-if="!panelOpen" class="layer-panel">
      <button class="layer-toggle" type="button" @click="layerOpen = !layerOpen">
        <span v-html="layersIcon"></span><span>图层可视</span><span class="group-caret" :class="{ open: layerOpen }">⌄</span>
      </button>
      <div v-show="layerOpen" class="layer-pop">
        <label v-for="opt in baseLayerOptions" :key="opt.key" class="layer-opt">
          <input type="checkbox" :checked="visibleLayers[opt.key]" @change="toggleLayer(opt.key)" />
          <span>{{ opt.label }}</span>
        </label>
      </div>
      <div class="legend">
        <button
          v-for="cat in lineCategories"
          :key="cat.key"
          class="legend-chip"
          :class="{ off: !lineState[cat.key] }"
          type="button"
          @click="toggleLine(cat.key)"
        >
          <i :style="{ background: lineColor(cat.key) }"></i>{{ cat.label }}
        </button>
      </div>
    </div>

    <!-- 右下：天气卡片（面板打开时隐藏） -->
    <div v-if="!panelOpen" class="weather-card">
      <div v-if="weather.alertTotal > 0" class="wx-alert" :title="`活跃预警 ${weather.alertTotal} 条`">
        <span class="wx-alert-dot"></span>预警 {{ weather.alertTotal }}
      </div>
      <div v-if="weather.today" class="wx-main">
        <div class="wx-date">{{ weather.today.date }}<span class="wx-week">{{ weather.today.week }}</span></div>
        <div class="wx-temp">{{ weather.today.tempMax }}<small>°C</small></div>
        <div class="wx-cond">
          <span class="wx-icon" v-html="weatherIcon(weather.today.weather)"></span>
          <span>{{ weather.today.weather }}</span>
        </div>
        <div class="wx-wind">{{ weather.today.windDirection }}风 {{ weather.today.windLevel }}级</div>
        <div v-if="weather.realtime" class="wx-realtime">实时 {{ weather.realtime }}</div>
      </div>
      <div v-else class="wx-empty">{{ weather.message }}</div>
      <div v-if="weather.days.length > 1" class="wx-strip">
        <div v-for="d in weather.days.slice(1, 5)" :key="d.date" class="wx-day">
          <span class="wx-day-label">{{ d.week }}</span>
          <span class="wx-icon sm" v-html="weatherIcon(d.weather)"></span>
          <span class="wx-day-temp">{{ d.tempMax }}°</span>
        </div>
      </div>
    </div>

    <!-- 地图内浮层面板：多标签，内嵌目标页组件 -->
    <div v-if="panelOpen" class="map-panel" :class="{ max: panelMax }">
      <div class="panel-tabs">
        <button
          v-for="p in openPanels"
          :key="p.key"
          class="panel-tab"
          :class="{ active: p.key === activePanel }"
          type="button"
          @click="activePanel = p.key"
        >
          <span class="tab-label">{{ p.title }}</span>
          <span class="tab-x" title="关闭" @click.stop="closePanel(p.key)">×</span>
        </button>
        <div class="panel-actions">
          <button class="panel-act" type="button" title="在新页展开" @click="router.push(activePanel)">↗ 展开</button>
          <button class="panel-act" type="button" @click="panelMax = !panelMax">{{ panelMax ? '还原' : '最大化' }}</button>
          <button class="panel-act close" type="button" title="关闭当前" @click="closePanel(activePanel)">✕</button>
        </div>
      </div>
      <div class="panel-body">
        <KeepAlive>
          <component :is="panelComps[activePanel]" :key="activePanel" />
        </KeepAlive>
      </div>
    </div>

    <!-- 左下状态条 -->
    <div class="map-status"><span class="status-dot"></span><span>天地图影像</span><i></i><span>{{ mapMessage }}</span></div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { iotApi, messageApi, plotApi, weatherApi, zoneApi } from '@/api'
import type { InfraLine, InfraLineType, ZoneSummary } from '@/api'
import { parsePlotBoundaries, type PlotBoundary, type PlotBoundarySource } from '@/utils/geo'
import { useUserStore } from '@/stores'
import { checkPermission } from '@/utils/permission'

const router = useRouter()
const userStore = useUserStore()
const tiandituKey = import.meta.env.VITE_TIANDITU_KEY

// ---------- 图层与底图状态 ----------
type LayerKey = 'imagery' | 'devices' | 'fields' | 'zones'
type LineCat = 'WATER' | 'ELECTRIC' | 'NET'
const visibleLayers = reactive<Record<LayerKey, boolean>>({ imagery: true, devices: true, fields: true, zones: true })
const lineState = reactive<Record<LineCat, boolean>>({ WATER: true, ELECTRIC: true, NET: true })
const layerOpen = ref(false)
const menuCollapsed = ref(false)

const baseLayerOptions: Array<{ key: LayerKey; label: string }> = [
  { key: 'imagery', label: '影像 / 矢量底图' },
  { key: 'devices', label: '设备点位' },
  { key: 'fields', label: '地块边界' },
  { key: 'zones', label: '片区范围' },
]

// ---------- 左侧功能菜单（地图内浮层面板） ----------
interface MenuItem { label: string; panel?: string; layer?: LineCat; perm?: string }
interface MenuGroup { title: string; icon: string; items: MenuItem[] }
const icon = (path: string): string => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="${path}"/></svg>`

// 路由路径 → 页面组件：就地异步内嵌到地图浮层面板（全局一张图，不再整页跳转）
const panelComps: Record<string, Component> = {
  '/plot/list': markRaw(defineAsyncComponent(() => import('@/views/plot/List.vue'))),
  '/plot/zone': markRaw(defineAsyncComponent(() => import('@/views/zone/Index.vue'))),
  '/farm/task': markRaw(defineAsyncComponent(() => import('@/views/farm/Task.vue'))),
  '/farm/record': markRaw(defineAsyncComponent(() => import('@/views/farm/Record.vue'))),
  '/farm/navigation': markRaw(defineAsyncComponent(() => import('@/views/farm/Navigation.vue'))),
  '/device/list': markRaw(defineAsyncComponent(() => import('@/views/device/List.vue'))),
  '/device/monitor': markRaw(defineAsyncComponent(() => import('@/views/device/Monitor.vue'))),
  '/device/commands': markRaw(defineAsyncComponent(() => import('@/views/device/Commands.vue'))),
  '/device/irrigation': markRaw(defineAsyncComponent(() => import('@/views/irrigation/Index.vue'))),
  '/agro': markRaw(defineAsyncComponent(() => import('@/views/agro/Index.vue'))),
  '/weather': markRaw(defineAsyncComponent(() => import('@/views/weather/Index.vue'))),
  '/finance': markRaw(defineAsyncComponent(() => import('@/views/finance/Index.vue'))),
  '/trace': markRaw(defineAsyncComponent(() => import('@/views/trace/Index.vue'))),
  '/video': markRaw(defineAsyncComponent(() => import('@/views/video/Index.vue'))),
  '/message': markRaw(defineAsyncComponent(() => import('@/views/message/Index.vue'))),
  '/system/user': markRaw(defineAsyncComponent(() => import('@/views/system/User.vue'))),
  '/system/role': markRaw(defineAsyncComponent(() => import('@/views/system/Role.vue'))),
}

const menuGroups: MenuGroup[] = [
  {
    title: '基本信息',
    icon: icon('M12 2 3 6v6c0 5 4 8 9 10 5-2 9-5 9-10V6l-9-4Z'),
    items: [
      { label: '地块台账', panel: '/plot/list', perm: 'plot:read' },
      { label: '片区信息', panel: '/plot/zone', perm: 'plot:read' },
      { label: '导航路线', panel: '/farm/navigation', perm: 'operation:read' },
      { label: '水线', layer: 'WATER' },
      { label: '电线', layer: 'ELECTRIC' },
      { label: '网线', layer: 'NET' },
    ],
  },
  {
    title: '四情监控',
    icon: icon('M3 13h4v8H3v-8Zm7-9h4v17h-4V4Zm7 5h4v12h-4V9Z'),
    items: [
      { label: '墒情', panel: '/agro', perm: 'telemetry:read' },
      { label: '苗情', panel: '/agro', perm: 'telemetry:read' },
      { label: '虫情', panel: '/agro', perm: 'telemetry:read' },
      { label: '灾情', panel: '/agro', perm: 'telemetry:read' },
      { label: '气象服务', panel: '/weather', perm: 'weather:read' },
    ],
  },
  {
    title: '视频监控',
    icon: icon('M4 5h11a2 2 0 0 1 2 2v3l4-3v11l-4-3v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'),
    items: [
      { label: '地图查看', panel: '/video', perm: 'device:read' },
      { label: '九宫格查看', panel: '/video', perm: 'device:read' },
    ],
  },
  {
    title: '控制设备',
    icon: icon('M20 8h-3V6a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v9h20v-9a2 2 0 0 0-2-2ZM9 6h6v2H9V6Z'),
    items: [
      { label: '设备台账', panel: '/device/list', perm: 'device:read' },
      { label: '实时监控', panel: '/device/monitor', perm: 'device:read' },
      { label: '控制指令', panel: '/device/commands', perm: 'device:read' },
      { label: '智能灌溉', panel: '/device/irrigation', perm: 'device:control' },
      { label: '水肥一体化', panel: '/device/irrigation', perm: 'device:control' },
    ],
  },
  {
    title: '农事管理',
    icon: icon('M7 2v2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7Zm12 8H5V6h14v4Z'),
    items: [
      { label: '农事任务', panel: '/farm/task', perm: 'operation:read' },
      { label: '农事记录', panel: '/farm/record', perm: 'operation:read' },
      { label: '田间导航', panel: '/farm/navigation', perm: 'operation:read' },
    ],
  },
  {
    title: '生产经营',
    icon: icon('M4 4h16v4H4V4Zm0 6h6v10H4V10Zm8 0h8v4h-8v-4Zm0 6h8v4h-8v-4Z'),
    items: [
      { label: '投入产出', panel: '/finance', perm: 'finance:read' },
      { label: '生产溯源', panel: '/trace', perm: 'trace:read' },
      { label: '消息中心', panel: '/message', perm: 'message:read' },
    ],
  },
  {
    title: '系统管理',
    icon: icon('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 4-.01 1.5 1.4 1.06-1.4 2.42-1.66-.66L17 17.5V19h-2.8l-.67 1.66-2.42-1.4L9.83 19H8v-1.5L6.6 17.34l-2.42 1.4L2 16.01l1.4-1.66H1.5V11h1.9L4.6 9.34 2 7.99 3.59 5.5l1.66.66V4H8l1.17-1.66 2.42 1.4 1.24-1.4H15l.67 1.66H19v1.9l1.66.67L22 10l-1.4 1.66Z'),
    items: [
      { label: '用户管理', panel: '/system/user', perm: 'system:user' },
      { label: '角色管理', panel: '/system/role', perm: 'system:role' },
    ],
  },
]
const openGroups = reactive<Record<string, boolean>>(Object.fromEntries(menuGroups.map((g) => [g.title, g.title === '基本信息'])))
function toggleGroup(title: string) {
  openGroups[title] = !openGroups[title]
}
// 权限过滤：未授予的菜单项隐藏
function allowed(perm?: string): boolean {
  return !perm || checkPermission(userStore.permissions, perm)
}

// ---------- 地图内浮层面板 ----------
interface OpenPanel { key: string; title: string }
const openPanels = ref<OpenPanel[]>([])
const activePanel = ref('')
const panelMax = ref(false)
const panelOpen = computed(() => openPanels.value.length > 0)
function openPanel(key: string, title: string) {
  if (!panelComps[key]) return
  if (!openPanels.value.some((p) => p.key === key)) openPanels.value.push({ key, title })
  activePanel.value = key
  panelMax.value = false
}
function closePanel(key: string) {
  const i = openPanels.value.findIndex((p) => p.key === key)
  if (i < 0) return
  openPanels.value.splice(i, 1)
  if (activePanel.value === key) activePanel.value = openPanels.value[openPanels.value.length - 1]?.key ?? ''
}
function handleMenu(item: MenuItem) {
  if (item.layer) toggleLine(item.layer)
  else if (item.panel) openPanel(item.panel, item.label)
}

// ---------- 管线配色与分类 ----------
const lineCategories: Array<{ key: LineCat; label: string }> = [
  { key: 'WATER', label: '水线' },
  { key: 'ELECTRIC', label: '电线' },
  { key: 'NET', label: '网线' },
]
const lineCatColors: Record<LineCat, string> = { WATER: '#00d4ff', ELECTRIC: '#f3c969', NET: '#7fe7ff' }
const roadColor = '#b0bec5'
function lineColor(cat: LineCat): string {
  return lineCatColors[cat]
}
/** 后端 lineType 归入参考图三类：灌溉/施肥管→水线，电力线→电线，通信线→网线，机耕道单独常显 */
function categorize(type: InfraLineType): LineCat | 'ROAD' {
  if (type === 'IRRIGATION_PIPE' || type === 'FERTILIZATION_PIPE') return 'WATER'
  if (type === 'ELECTRIC_LINE') return 'ELECTRIC'
  if (type === 'ROAD') return 'ROAD'
  return 'NET'
}

// ---------- 天气卡片 ----------
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const weather = reactive<{ today: WxDay | null; days: WxDay[]; message: string; realtime: string; alertTotal: number }>({ today: null, days: [], message: '气象数据加载中', realtime: '', alertTotal: 0 })
interface WxDay { date: string; week: string; weather: string; tempMin: number; tempMax: number; windDirection: string; windLevel: number }
function weatherIcon(text: string): string {
  const t = text || ''
  if (t.includes('雷')) return icon('M13 2 4 14h6l-1 8 9-12h-6l1-8Z')
  if (t.includes('雪') || t.includes('冰')) return icon('M12 2v20M2 12h20M5 5l14 14M19 5 5 19')
  if (t.includes('雨')) return icon('M6 14a5 5 0 0 1 1-9 6 6 0 0 1 11 2 4 4 0 0 1-1 8M9 18l-1 3M13 18l-1 3M17 18l-1 3')
  if (t.includes('阴') || t.includes('云')) return icon('M6 18a4 4 0 0 1 1-8 6 6 0 0 1 11 2 3 3 0 0 1-1 6Z')
  return icon('M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6 4.5 4.5M19.5 19.5 18 18M6 18l-1.5 1.5M19.5 4.5 18 6M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z')
}
async function loadWeather() {
  try {
    const res = await weatherApi.getForecast({ days: 5 })
    const list: any[] = res?.forecast ?? []
    if (!list.length) {
      weather.message = '暂无气象预报数据'
      return
    }
    const map = (d: any, i: number): WxDay => {
      const date = String(d.date ?? '')
      const dt = new Date(date)
      return {
        date: date.slice(5),
        week: i === 0 ? '今天' : Number.isFinite(dt.getTime()) ? WEEK[dt.getDay()] as string : date.slice(5),
        weather: d.weather ?? '—',
        tempMin: Number(d.tempMin ?? 0),
        tempMax: Number(d.tempMax ?? 0),
        windDirection: d.windDirection ?? '',
        windLevel: Number(d.windLevel ?? 0),
      }
    }
    weather.days = list.map(map)
    weather.today = weather.days[0] ?? null
  } catch {
    weather.message = '气象数据暂不可用'
  }
  // 实时要素（温湿度/风）与活跃预警条数，失败静默不影响预报展示
  try {
    const rt = await weatherApi.getRealtime()
    const els: any[] = rt?.elements ?? []
    const pick = (re: RegExp) => els.find((e) => re.test(String(e.label ?? '')) || re.test(String(e.key ?? '')))
    const t = pick(/温度|temperature/i)
    const h = pick(/湿度|humid/i)
    const w = pick(/风速|wind/i)
    const parts: string[] = []
    if (t) parts.push(`${t.value}${t.unit ?? '°C'}`)
    if (h) parts.push(`湿度 ${h.value}${h.unit ?? '%'}`)
    if (w) parts.push(`风 ${w.value}${w.unit ?? ''}`)
    if (rt?.dataSource !== 'unavailable') weather.realtime = parts.join(' · ')
  } catch {
    // 实时不可达时留空
  }
  try {
    const alerts = await weatherApi.getAlerts({ page: 1, size: 1 })
    weather.alertTotal = Number(alerts?.total ?? 0)
  } catch {
    weather.alertTotal = 0
  }
}

// ---------- 地图 ----------
const mapMessage = ref('地块边界加载中')
let map: any = null
let baseLayers: { vector: any; imagery: any } | null = null
let deviceLayer: any = null
let fieldLayer: any = null
let zoneLayer: any = null
const lineLayers: Record<LineCat | 'ROAD', any> = { WATER: null, ELECTRIC: null, NET: null, ROAD: null }
let baseKey: 'imagery' | 'vector' = 'imagery'
const tileOptions = { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: 18 }
const parcelCenter = new Map<string, [number, number]>()

function createTiles(layer: string) {
  return L.tileLayer(`https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${tiandituKey}`, { ...tileOptions })
}

function initMap() {
  map = L.map('tianditu-map', { center: [30.982425, 107.421325], zoom: 15, zoomControl: true, attributionControl: false })
  const vector = L.layerGroup([createTiles('vec'), createTiles('cva')])
  const imagery = L.layerGroup([createTiles('img'), createTiles('cia')])
  baseKey = visibleLayers.imagery ? 'imagery' : 'vector'
  baseLayers = { vector, imagery }
  baseLayers[baseKey].addTo(map)
  deviceLayer = L.layerGroup().addTo(map)
  fieldLayer = L.layerGroup().addTo(map)
  zoneLayer = L.layerGroup().addTo(map)
  for (const key of ['WATER', 'ELECTRIC', 'NET', 'ROAD'] as const) lineLayers[key] = L.layerGroup().addTo(map)
}

function toggleLayer(key: LayerKey) {
  visibleLayers[key] = !visibleLayers[key]
  if (!map) return
  if (key === 'imagery' && baseLayers) {
    const next: 'imagery' | 'vector' = visibleLayers.imagery ? 'imagery' : 'vector'
    map.removeLayer(baseLayers[baseKey])
    baseKey = next
    baseLayers[baseKey].addTo(map)
  }
  if (key === 'devices' && deviceLayer) visibleLayers.devices ? deviceLayer.addTo(map) : map.removeLayer(deviceLayer)
  if (key === 'fields' && fieldLayer) visibleLayers.fields ? fieldLayer.addTo(map) : map.removeLayer(fieldLayer)
  if (key === 'zones' && zoneLayer) visibleLayers.zones ? zoneLayer.addTo(map) : map.removeLayer(zoneLayer)
}

function toggleLine(cat: LineCat) {
  lineState[cat] = !lineState[cat]
  if (!map || !lineLayers[cat]) return
  lineState[cat] ? lineLayers[cat].addTo(map) : map.removeLayer(lineLayers[cat])
}

function renderLines(list: InfraLine[]) {
  if (!map) return
  const buckets: Record<LineCat | 'ROAD', any[]> = { WATER: [], ELECTRIC: [], NET: [], ROAD: [] }
  for (const line of list) {
    if (!Array.isArray(line.geom?.coordinates) || line.geom.coordinates.length < 2) continue
    const points = line.geom.coordinates.map((p) => [Number(p[1]), Number(p[0])] as [number, number])
    const cat = categorize(line.lineType)
    const color = cat === 'ROAD' ? roadColor : lineCatColors[cat]
    buckets[cat].push(L.polyline(points, { color, weight: cat === 'ROAD' ? 2 : 3, opacity: 0.9, dashArray: cat === 'ROAD' ? '6 6' : undefined }).bindTooltip(`<strong>${line.lineName}</strong>`))
  }
  for (const key of ['WATER', 'ELECTRIC', 'NET', 'ROAD'] as const) {
    if (lineLayers[key]) map.removeLayer(lineLayers[key])
    lineLayers[key] = L.layerGroup(buckets[key])
    const on = key === 'ROAD' ? true : lineState[key as LineCat]
    if (on) lineLayers[key].addTo(map)
  }
}

async function loadLines() {
  try {
    renderLines(await plotApi.getInfraLines())
  } catch {
    renderLines([])
  }
}

function renderZones(list: ZoneSummary[]) {
  if (!map) return
  if (zoneLayer) map.removeLayer(zoneLayer)
  const shapes = list
    .map((zone) => {
      const ring = zone.hull?.coordinates?.[0] ?? zone.geom?.coordinates?.[0]
      if (!ring || ring.length < 4) return null
      const points = ring.map((p) => [Number(p[1]), Number(p[0])] as [number, number])
      return L.polygon(points, { color: zone.color || '#00d4ff', weight: 2, dashArray: '8 6', fill: false }).bindTooltip(
        `<strong>${zone.zoneName}</strong><br>${zone.zoneCode} · ${zone.plotCount} 块 · ${zone.areaMu.toFixed(2)} 亩`,
      )
    })
    .filter((s): s is any => !!s)
  zoneLayer = L.layerGroup(shapes)
  if (visibleLayers.zones) zoneLayer.addTo(map)
}

async function loadZones() {
  try {
    renderZones(await zoneApi.getMap())
  } catch {
    renderZones([])
  }
}

function centroidOf(ring: [number, number][] | undefined): [number, number] | null {
  if (!ring || ring.length === 0) return null
  let lat = 0
  let lng = 0
  for (const p of ring) {
    lat += p[0]
    lng += p[1]
  }
  return [lat / ring.length, lng / ring.length]
}

function renderFields(list: PlotBoundary[]) {
  if (!fieldLayer || !map) return
  map.removeLayer(fieldLayer)
  const shapes = list.map((b, index) => {
    const ring = b.rings[0]
    const c = centroidOf(ring)
    if (c && b.parcelCode) parcelCenter.set(b.parcelCode, c)
    const color = cropColor(b.crop ?? b.name, index)
    return ring ? L.polygon(ring, { color, weight: 1.5, fillColor: color, fillOpacity: 0.14 }).bindTooltip(`<strong>${b.name}</strong><br>${b.areaMu.toFixed(2)} 亩${b.crop ? ` · ${b.crop}` : ''}`) : null
  }).filter((s): s is any => !!s)
  fieldLayer = L.layerGroup(shapes)
  if (visibleLayers.fields) fieldLayer.addTo(map)
  if (list.length) {
    const bounds = L.latLngBounds(list.flatMap((b) => b.rings[0] ?? []))
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 60] })
  }
}

function demoBoundaries(): PlotBoundary[] {
  const rect = (name: string, parcelCode: string, areaMu: number, crop: string, coords: [number, number][]): PlotBoundary => ({
    name, parcelCode, rings: [coords], center: [0, 0], areaMu, crop,
  })
  return [
    rect('西北片区 · 大豆区', 'demo-soybean', 4860, '大豆', [[30.9780, 107.4140], [30.9825, 107.4128], [30.9862, 107.4185], [30.9840, 107.4255], [30.9790, 107.4240], [30.9780, 107.4140]]),
    rect('东南片区 · 玉米区', 'demo-corn', 2830, '玉米', [[30.9868, 107.4268], [30.9910, 107.4252], [30.9932, 107.4305], [30.9898, 107.4352], [30.9860, 107.4318], [30.9868, 107.4268]]),
  ]
}

async function loadPlots() {
  try {
    const list = await plotApi.getList({ page: 1, pageSize: 200 })
    const parsed = parsePlotBoundaries(list.items as PlotBoundarySource[])
    if (parsed.length) {
      renderFields(parsed)
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

/** 设备无经纬度，按其所属地块中心聚合打点；缺地块位置的设备归入“未定位”不参与绘制。 */
async function loadDevices() {
  if (!map || !deviceLayer) return
  try {
    const res = await iotApi.getDevices({ page: 1, size: 500 })
    const items: any[] = res?.items ?? []
    const byParcel = new Map<string, { total: number; online: number; name: string; devices: { name: string; status: string }[] }>()
    for (const d of items) {
      const code = d.parcelCode ?? d.plotCode
      if (!code || !parcelCenter.has(code)) continue
      const g = byParcel.get(code) ?? { total: 0, online: 0, name: d.parcelName ?? code, devices: [] as { name: string; status: string }[] }
      g.total += 1
      if (d.status === 'ONLINE') g.online += 1
      g.devices.push({ name: String(d.name ?? d.deviceCode ?? '设备'), status: String(d.status ?? '') })
      byParcel.set(code, g)
    }
    const markers = [...byParcel.entries()].map(([code, g]) => {
      const latlng = parcelCenter.get(code)!
      const color = g.online === g.total ? '#00e676' : g.online > 0 ? '#f3c969' : '#ff8a65'
      const html = `<span class="dev-pin" style="background:${color}">${g.total}</span>`
      const rows = g.devices.slice(0, 10).map((x) => `<div class="dev-row"><span class="dev-st ${x.status === 'ONLINE' ? 'on' : 'off'}"></span>${x.name}</div>`).join('')
      const more = g.devices.length > 10 ? `<div class="dev-more">…共 ${g.devices.length} 台</div>` : ''
      return L.marker(latlng, { icon: L.divIcon({ className: 'dev-ico', html, iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .bindTooltip(`<strong>${g.name}</strong><br>设备 ${g.total} 台 · 在线 ${g.online}`)
        .bindPopup(`<div class="dev-pop"><div class="dev-pop-h">${g.name} · 在线 ${g.online}/${g.total}</div>${rows}${more}</div>`)
    })
    if (deviceLayer) map.removeLayer(deviceLayer)
    deviceLayer = L.layerGroup(markers)
    if (visibleLayers.devices) deviceLayer.addTo(map)
  } catch {
    // 设备拉取失败不影响一张图主体
  }
}

const cropPalette = ['#00d4ff', '#f3c969', '#00e676', '#ff8a65', '#b388ff', '#69f0ae']
function cropColor(name: string | undefined, index: number): string {
  const table: Record<string, string> = { 大豆: '#00d4ff', 玉米: '#f3c969', 水稻: '#00e676', 小麦: '#ffd54f', 油菜: '#ff8a65', 蔬菜: '#69f0ae', 果树: '#b388ff', other: '#b388ff' }
  return table[name ?? 'other'] ?? (cropPalette[index % cropPalette.length] as string)
}

const layersIcon = icon('M12 2 2 8l10 6 10-6-10-6ZM2 14l10 6 10-6')

// ---------- 右上控制簇（消息 / 用户）——取代原外围顶栏 ----------
const unread = ref(0)
const userMenu = ref(false)
const userName = computed(() => userStore.userInfo?.name || userStore.userInfo?.username || '管理员')
let unreadTimer: ReturnType<typeof setInterval> | undefined
function refreshUnread() {
  if (!allowed('message:read')) return
  messageApi.getUnreadCount().then((r) => { unread.value = r.unread }).catch(() => { /* 服务不可用时保持上次计数 */ })
}
function handleCommand(cmd: string) {
  userMenu.value = false
  if (cmd === 'logout') { userStore.logout(); void router.push('/login') }
  else if (cmd === 'message') openPanel('/message', '消息中心')
}

onMounted(initMap)
onMounted(() => void loadPlots().then(() => loadDevices()))
onMounted(() => void loadZones())
onMounted(() => void loadLines())
onMounted(() => void loadWeather())
onMounted(() => { refreshUnread(); unreadTimer = setInterval(refreshUnread, 30000) })
onUnmounted(() => { map?.remove(); map = null; if (unreadTimer) clearInterval(unreadTimer) })
</script>

<style scoped lang="scss">
.cockpit { position: relative; width: 100%; height: 100%; overflow: hidden; background: #061026; color: #e8f5ff; font-family: "Microsoft YaHei", sans-serif; }
#tianditu-map { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; }

/* 左侧功能菜单 */
.func-menu { position: absolute; top: 16px; left: 16px; bottom: 16px; z-index: 500; width: 216px; display: flex; flex-direction: column; background: rgba(6, 22, 42, .82); border: 1px solid rgba(0, 212, 255, .28); border-radius: 4px; backdrop-filter: blur(10px); transition: width .2s; }
.func-menu.collapsed { width: 46px; }
.func-menu__head { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid rgba(0, 212, 255, .2); }
.brand-dot { width: 12px; height: 12px; border-radius: 50%; background: #00d4ff; box-shadow: 0 0 10px #00d4ff; flex: none; }
.brand-title { font-size: 14px; font-weight: 600; color: #d6f4ff; white-space: nowrap; }
.collapse-btn { margin-left: auto; width: 20px; height: 20px; border: 1px solid rgba(0,212,255,.3); border-radius: 3px; background: rgba(0,98,133,.4); color: #bfe9ff; cursor: pointer; line-height: 1; }
.func-menu__body { flex: 1; overflow-y: auto; padding: 6px 0; }
.menu-group { padding: 4px 8px; }
.group-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 6px; border: 0; background: none; color: #00d4ff; cursor: pointer; font-size: 13px; font-weight: 600; }
.group-icon { display: inline-flex; }
.group-title { flex: 1; text-align: left; }
.group-caret { transition: transform .2s; font-size: 12px; color: #6ea7bd; }
.group-caret.open { transform: rotate(180deg); }
.group-items { padding: 2px 0 6px 10px; }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: 3px; background: none; color: #b6d2de; cursor: pointer; font-size: 12px; text-align: left; }
.menu-item:hover { background: rgba(0, 98, 133, .4); color: #fff; }
.menu-item.active { background: rgba(0, 98, 133, .55); color: #fff; }
.item-dot { width: 6px; height: 6px; border-radius: 50%; background: #4d7f92; flex: none; }
.swatch { width: 14px; height: 3px; border-radius: 2px; flex: none; }
.item-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 右上图层与图例 */
.layer-panel { position: absolute; top: 16px; right: 16px; z-index: 500; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.layer-toggle { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border: 1px solid rgba(0,212,255,.34); border-radius: 3px; background: rgba(7,25,48,.86); color: #cdeeff; cursor: pointer; font-size: 12px; backdrop-filter: blur(8px); }
.layer-pop { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; background: rgba(6,22,42,.92); border: 1px solid rgba(0,212,255,.28); border-radius: 4px; }
.layer-opt { display: flex; align-items: center; gap: 8px; color: #b6d2de; font-size: 12px; cursor: pointer; }
.layer-opt input { accent-color: #00d4ff; }
.legend { display: flex; gap: 8px; }
.legend-chip { display: flex; align-items: center; gap: 5px; padding: 5px 9px; border: 1px solid rgba(0,212,255,.24); border-radius: 3px; background: rgba(7,25,48,.82); color: #cdeeff; cursor: pointer; font-size: 11px; }
.legend-chip i { width: 14px; height: 3px; border-radius: 2px; }
.legend-chip.off { opacity: .4; }

/* 右下天气卡片 */
.weather-card { position: absolute; right: 16px; bottom: 16px; z-index: 500; display: flex; align-items: center; gap: 16px; padding: 14px 18px; background: rgba(6,22,42,.86); border: 1px solid rgba(0,212,255,.28); border-radius: 4px; backdrop-filter: blur(10px); }
.wx-main { text-align: center; min-width: 96px; }
.wx-date { color: #9fc3d3; font-size: 13px; }
.wx-week { margin-left: 6px; color: #00d4ff; }
.wx-temp { color: #fff; font-size: 30px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.wx-temp small { font-size: 14px; color: #9fc3d3; }
.wx-cond { display: flex; align-items: center; justify-content: center; gap: 6px; color: #cdeeff; font-size: 13px; }
.wx-wind { color: #7c98a9; font-size: 11px; margin-top: 2px; }
.wx-empty { color: #9fc3d3; font-size: 13px; padding: 8px 4px; }
.wx-icon { display: inline-flex; color: #ffd54f; }
.wx-icon.sm { color: #ffd54f; }
.wx-strip { display: flex; gap: 14px; padding-left: 16px; border-left: 1px solid rgba(0,212,255,.2); }
.wx-day { display: flex; flex-direction: column; align-items: center; gap: 4px; color: #b6d2de; font-size: 12px; }
.wx-day-temp { color: #e9f4f6; }
.wx-realtime { color: #7fe7ff; font-size: 11px; margin-top: 4px; }
.wx-alert { position: absolute; top: -1px; right: -1px; display: flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 0 4px 0 6px; background: rgba(255, 71, 87, .92); color: #fff; font-size: 11px; font-weight: 600; }
.wx-alert-dot { width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: wx-blink 1.1s infinite; }
@keyframes wx-blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

/* 左下状态条 */
.map-status { position: absolute; left: 248px; bottom: 16px; z-index: 500; display: flex; align-items: center; gap: 8px; padding: 6px 10px; color: #b6d2de; background: rgba(7,25,48,.8); border: 1px solid rgba(0,212,255,.24); font-size: 11px; }
.map-status i { width: 1px; height: 12px; background: rgba(255,255,255,.22); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #00e676; box-shadow: 0 0 8px #00e676; }

/* 右上控制簇（消息 / 用户） */
.ctl-cluster { position: absolute; top: 14px; right: 16px; z-index: 1000; display: flex; align-items: center; gap: 10px; }
.ctl-btn { position: relative; width: 34px; height: 34px; border: 1px solid rgba(0,212,255,.34); border-radius: 4px; background: rgba(7,25,48,.86); color: #cdeeff; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
.ctl-badge { position: absolute; top: -7px; right: -7px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #ff4757; color: #fff; font-size: 10px; line-height: 16px; }
.ctl-user { position: relative; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 1px solid rgba(0,212,255,.34); border-radius: 4px; background: rgba(7,25,48,.86); color: #cdeeff; cursor: pointer; font-size: 12px; }
.ctl-avatar { width: 22px; height: 22px; border-radius: 50%; background: #00d4ff; color: #04121f; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ctl-caret { color: #6ea7bd; }
.ctl-menu { position: absolute; top: 38px; right: 0; display: flex; flex-direction: column; min-width: 110px; padding: 4px; background: rgba(6,22,42,.96); border: 1px solid rgba(0,212,255,.28); border-radius: 4px; }
.ctl-menu button { text-align: left; padding: 7px 10px; border: 0; background: none; color: #cdeeff; cursor: pointer; font-size: 12px; border-radius: 3px; }
.ctl-menu button:hover { background: rgba(0,98,133,.5); }
.ctl-menu button.danger { color: #ff8a65; }

/* 地图内浮层面板 */
.map-panel { position: absolute; top: 56px; right: 16px; bottom: 16px; z-index: 900; width: min(920px, 62vw); display: flex; flex-direction: column; background: rgba(6,22,42,.96); border: 1px solid rgba(0,212,255,.3); border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }
.map-panel.max { left: 248px; width: auto; }
.panel-tabs { display: flex; align-items: stretch; gap: 2px; padding: 6px 6px 0; background: rgba(4,16,31,.9); border-bottom: 1px solid rgba(0,212,255,.24); overflow-x: auto; }
.panel-tab { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border: 0; border-radius: 4px 4px 0 0; background: rgba(255,255,255,.05); color: #9fc3d3; cursor: pointer; font-size: 12px; white-space: nowrap; }
.panel-tab.active { background: #f0f2f5; color: #1f2d3d; }
.tab-x { color: inherit; opacity: .6; font-size: 14px; }
.tab-x:hover { opacity: 1; }
.panel-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; padding: 0 4px; }
.panel-act { padding: 5px 8px; border: 1px solid rgba(0,212,255,.28); border-radius: 3px; background: rgba(0,98,133,.35); color: #cdeeff; cursor: pointer; font-size: 11px; white-space: nowrap; }
.panel-act.close { color: #ff8a65; }
.panel-body { flex: 1; overflow: auto; background: #f0f2f5; color: #1f2d3d; }
.panel-body > * { min-height: 100%; }

:deep(.dev-ico) { background: none; border: 0; }
:deep(.dev-pin) { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; color: #04121f; font-size: 12px; font-weight: 700; box-shadow: 0 0 8px rgba(0,0,0,.5); border: 2px solid rgba(255,255,255,.7); }
:deep(.leaflet-control-zoom) { margin: 16px 16px 0 0; border: 0; }
:deep(.leaflet-control-zoom a) { color: #b9e6ef; background: rgba(7,25,48,.85); border-color: rgba(0,212,255,.25); }
:deep(.leaflet-popup-content-wrapper), :deep(.leaflet-popup-tip) { color: #dff4f8; background: #0b2943; }
:deep(.leaflet-popup-content) { margin: 10px 13px; font-size: 12px; line-height: 1.7; }
:deep(.leaflet-popup-content strong) { color: #00d4ff; }
:deep(.dev-pop) { min-width: 150px; max-height: 220px; overflow: auto; }
:deep(.dev-pop-h) { color: #00d4ff; font-weight: 600; font-size: 13px; margin-bottom: 8px; }
:deep(.dev-row) { display: flex; align-items: center; gap: 7px; padding: 3px 0; font-size: 12px; color: #cfe6f0; }
:deep(.dev-st) { width: 7px; height: 7px; border-radius: 50%; flex: none; }
:deep(.dev-st.on) { background: #00e676; box-shadow: 0 0 6px #00e676; }
:deep(.dev-st.off) { background: #ff8a65; }
:deep(.dev-more) { padding-top: 5px; color: #7c98a9; font-size: 11px; }

@media (min-width: 1600px) {
  .func-menu { width: 244px; }
  .group-head { font-size: 14px; }
  .menu-item { font-size: 13px; padding: 9px 8px; }
  .wx-temp { font-size: 34px; }
  .map-status { left: 276px; }
  .map-panel { width: min(1100px, 66vw); }
  .map-panel.max { left: 276px; }
}
@media (max-width: 900px) {
  .func-menu { width: 180px; }
  .map-status { left: 200px; }
  .wx-strip { display: none; }
  .map-panel { width: auto; left: 210px; }
  .map-panel.max { left: 200px; }
  .ctl-name { display: none; }
}
@media (max-width: 640px) {
  .func-menu { top: 10px; left: 10px; bottom: auto; max-height: 46%; width: 158px; }
  .func-menu.collapsed { width: 42px; }
  .layer-panel { top: 10px; right: 10px; }
  .weather-card { right: 10px; bottom: 10px; left: 10px; justify-content: space-between; }
  .map-status { display: none; }
  .map-panel { top: 48px; left: 172px; right: 8px; bottom: 8px; width: auto; }
  .map-panel.max { left: 12px; }
  .ctl-name { display: none; }
}
</style>