<template>
  <div v-if="active" class="shape-editor">
    <div class="shape-editor__head">
      <span class="se-dot" :style="{ background: color }"></span>
      <span class="se-title">{{ title }}</span>
      <button class="se-x" type="button" title="取消（Esc）" @click="cancel">×</button>
    </div>

    <label v-if="kind === 'line'" class="se-field">
      <span>类型</span>
      <select v-model="draftType" class="se-input" @change="handleTypeChange">
        <option v-for="opt in lineTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </label>

    <label class="se-field">
      <span>名称</span>
      <input v-model="draftName" class="se-input" type="text" maxlength="40" :placeholder="`请输入${kindLabel}名称`" />
    </label>

    <label v-if="kind === 'plot'" class="se-field">
      <span>类型</span>
      <select v-model="draftPlotType" class="se-input">
        <option v-for="opt in plotTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </label>

    <label v-if="kind === 'plot'" class="se-field">
      <span>片区</span>
      <select v-model="draftZoneCode" class="se-input">
        <option value="">未划入片区</option>
        <option v-for="zone in zones" :key="zone.zoneCode" :value="zone.zoneCode">{{ zone.zoneName }}</option>
      </select>
    </label>

    <label v-if="kind === 'zone'" class="se-field">
      <span>颜色</span>
      <input v-model="draftColor" class="se-color" type="color" />
    </label>

    <div class="se-stat">{{ stat }}</div>
    <div class="se-actions">
      <button type="button" :disabled="points.length === 0" @click="undo">撤销</button>
      <button type="button" :disabled="points.length === 0" @click="clearPoints">清空</button>
      <button type="button" class="primary" :disabled="points.length < minPoints || saving" @click="save">
        {{ saving ? '保存中…' : mode === 'edit' ? '保存修改' : '保存' }}
      </button>
    </div>
    <div class="se-hint">{{ hint }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import L from 'leaflet'
import { ElMessage } from 'element-plus'
import { plotApi, toPolygonGeom, zoneApi } from '@/api'
import type { InfraLineType } from '@/api'
import { PlotType } from '@/types'
import type { MapShapeActive, MapShapeKind, MapShapeSaved, MapShapeTarget } from '@/types'
import { getPlotTypeText } from '@/utils'
import { polygonAreaMu, polylineLengthM } from '@/utils/geo'
import { categorize, defaultTypeOfCat, lineColorOf, lineTypeOptions } from '@/utils/infraLine'
import type { LineCat } from '@/utils/infraLine'

const props = defineProps<{
  zones: Array<{ zoneCode: string; zoneName: string }>
  suggestName: (kind: MapShapeKind, lineType?: InfraLineType) => string
}>()
const emit = defineEmits<{
  (e: 'active-change', value: MapShapeActive | null): void
  (e: 'saved', value: MapShapeSaved): void
}>()
/** 编辑态由本组件持有：父级只读一份副本用于菜单高亮与点击穿透判断 */
const active = ref<MapShapeActive | null>(null)

function setActive(value: MapShapeActive | null) {
  active.value = value
  emit('active-change', value)
}

const plotTypeOptions = Object.values(PlotType).map((value) => ({ value, label: getPlotTypeText(value) }))
const kindLabels: Record<MapShapeKind, string> = { line: '管线', plot: '地块', zone: '片区' }
/** 地块草稿用绿色，与管线的蓝黄、片区自定义色区分开 */
const PLOT_COLOR = '#69f0ae'

const mode = ref<'create' | 'edit'>('create')
const target = ref<MapShapeTarget | null>(null)
/** 草稿顶点，[经度, 纬度]，与后端 GeoJSON 一致 */
const points = ref<[number, number][]>([])
const draftName = ref('')
const draftType = ref<InfraLineType>('IRRIGATION_PIPE')
const draftPlotType = ref<PlotType>(PlotType.FIELD)
const draftZoneCode = ref('')
const draftColor = ref('#00d4ff')
const saving = ref(false)

const kind = computed<MapShapeKind>(() => active.value?.kind ?? 'line')
const kindLabel = computed(() => kindLabels[kind.value])
const isPolygon = computed(() => kind.value !== 'line')
const minPoints = computed(() => (isPolygon.value ? 3 : 2))
const color = computed(() => {
  if (kind.value === 'line') return lineColorOf(draftType.value)
  return kind.value === 'zone' ? draftColor.value : PLOT_COLOR
})
const title = computed(() => `${mode.value === 'edit' ? '修改' : '绘制'}${kindLabel.value}`)
const stat = computed(() => (isPolygon.value
  ? `${points.value.length} 个顶点 · ${polygonAreaMu(points.value).toFixed(2)} 亩`
  : `${points.value.length} 个拐点 · ${polylineLengthM(points.value).toFixed(1)} 米`))
const hint = computed(() => (mode.value === 'edit'
  ? `拖动圆点调整${kindLabel.value}${isPolygon.value ? '边界' : '走向'}，右键圆点删除该点，单击地图追加顶点；Esc 放弃修改。`
  : `单击地图逐个添加${isPolygon.value ? '顶点' : '拐点'}，至少 ${minPoints.value} 个点成${isPolygon.value ? '面' : '线'}；拖动圆点微调，右键圆点删点，Esc 取消。`))

let map: any = null
let draftLayer: any = null
let draftShape: any = null
let rubberBand: any = null

function latlngs(): [number, number][] {
  return points.value.map(([lng, lat]) => [lat, lng] as [number, number])
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

/** 父级地图建好后挂载交互；卡片本身在地图容器外，不会误触发落点 */
function attach(instance: any) {
  map = instance
  map.on('click', handleMapClick)
  map.on('mousemove', handleMapMouseMove)
}

function openLayers() {
  if (!map) return
  closeLayers()
  draftLayer = L.layerGroup().addTo(map)
  rubberBand = L.polyline([], { color: color.value, weight: 2, opacity: 0.7, dashArray: '4 6', interactive: false }).addTo(map)
  map.getContainer().style.cursor = 'crosshair'
  render()
}

function closeLayers() {
  if (map) {
    if (draftLayer) map.removeLayer(draftLayer)
    if (rubberBand) map.removeLayer(rubberBand)
    map.getContainer().style.cursor = ''
  }
  draftLayer = null
  draftShape = null
  rubberBand = null
}

function render() {
  if (!draftLayer) return
  draftLayer.clearLayers()
  draftShape = null
  const ring = latlngs()
  const stroke = color.value
  // 草稿面不拦截鼠标，单击面内部继续追加顶点
  if (isPolygon.value && ring.length >= 3) {
    draftShape = L.polygon(ring, { color: stroke, weight: 2, fillColor: stroke, fillOpacity: 0.2, interactive: false }).addTo(draftLayer)
  } else if (ring.length >= 2) {
    draftShape = L.polyline(ring, { color: stroke, weight: isPolygon.value ? 2 : 4, opacity: 0.95, dashArray: isPolygon.value ? '6 4' : undefined, interactive: false }).addTo(draftLayer)
  }
  ring.forEach((latlng, index) => {
    // 颜色可能来自片区台账（用户可改），用 DOM 节点而不是 HTML 字符串，避免注入
    const dot = document.createElement('i')
    dot.style.background = stroke
    const html = document.createElement('div')
    html.appendChild(dot)
    const marker = L.marker(latlng, {
      draggable: true,
      keyboard: false,
      bubblingMouseEvents: false,
      zIndexOffset: 1200,
      icon: L.divIcon({ className: 'se-vertex', html, iconSize: [14, 14], iconAnchor: [7, 7] }),
    })
    marker.bindTooltip(String(index + 1), { permanent: true, direction: 'top', offset: [0, -8], className: 'se-vertex-label' })
    marker.on('drag', (event: any) => movePoint(index, event.target.getLatLng()))
    marker.on('dragend', (event: any) => { movePoint(index, event.target.getLatLng()); render() })
    marker.on('contextmenu', () => removePoint(index))
    marker.addTo(draftLayer)
  })
  if (rubberBand) {
    rubberBand.setStyle({ color: stroke })
    rubberBand.setLatLngs([])
  }
}

function movePoint(index: number, latlng: any) {
  points.value.splice(index, 1, [round(latlng.lng), round(latlng.lat)])
  // 拖动过程中只改几何，重建标记会打断拖拽
  if (draftShape) draftShape.setLatLngs(latlngs())
  if (rubberBand) rubberBand.setLatLngs([])
}

function removePoint(index: number) {
  points.value.splice(index, 1)
  render()
}

function handleMapClick(event: any) {
  if (!active.value || saving.value) return
  const lng = round(event.latlng.lng)
  const lat = round(event.latlng.lat)
  const last = points.value[points.value.length - 1]
  // 双击缩放会连发两次 click，重复点不入草稿
  if (last && last[0] === lng && last[1] === lat) return
  points.value = [...points.value, [lng, lat]]
  render()
}

function handleMapMouseMove(event: any) {
  if (!active.value || !rubberBand) return
  const last = points.value[points.value.length - 1]
  if (!last) { rubberBand.setLatLngs([]); return }
  const segments: [number, number][] = [[last[1], last[0]], [event.latlng.lat, event.latlng.lng]]
  const first = points.value[0]!
  // 面草稿额外预览回到首点的闭合边
  if (isPolygon.value && points.value.length >= 2) segments.push([first[1], first[0]])
  rubberBand.setLatLngs(segments)
}

function undo() {
  points.value = points.value.slice(0, -1)
  render()
}

function clearPoints() {
  points.value = []
  render()
}

function handleTypeChange() {
  if (mode.value === 'create') draftName.value = props.suggestName('line', draftType.value)
  render()
}

function begin(next: MapShapeActive) {
  if (saving.value) return
  closeLayers()
  points.value = []
  target.value = null
  mode.value = next.mode
  setActive(next)
}

function fitToPoints() {
  if (!map || points.value.length === 0) return
  map.fitBounds(L.latLngBounds(latlngs()), { paddingTopLeft: [250, 60], paddingBottomRight: [60, 60], maxZoom: 17 })
}

function startLine(cat: LineCat) {
  begin({ kind: 'line', mode: 'create', cat })
  draftType.value = defaultTypeOfCat[cat]
  draftName.value = props.suggestName('line', draftType.value)
  openLayers()
}

function startPlot() {
  begin({ kind: 'plot', mode: 'create' })
  draftName.value = props.suggestName('plot')
  draftPlotType.value = PlotType.FIELD
  draftZoneCode.value = ''
  openLayers()
}

function startZone() {
  begin({ kind: 'zone', mode: 'create' })
  draftName.value = props.suggestName('zone')
  draftColor.value = '#00d4ff'
  openLayers()
}

/** 载入既有边界进入修改态；points 为开环，保存时再闭合 */
function edit(shape: 'plot' | 'zone', source: MapShapeTarget) {
  begin({ kind: shape, mode: 'edit' })
  target.value = source
  points.value = source.points.map(([lng, lat]) => [lng, lat])
  draftName.value = source.name
  if (shape === 'plot') {
    draftPlotType.value = source.plotType ?? PlotType.FIELD
    draftZoneCode.value = source.zoneCode ?? ''
  } else {
    draftColor.value = source.color || '#00d4ff'
  }
  openLayers()
  fitToPoints()
}

function editPlot(source: MapShapeTarget) {
  edit('plot', source)
}

function editZone(source: MapShapeTarget) {
  edit('zone', source)
}

/** 管线改走向：机耕道没有对应的图层分类，菜单高亮留空即可 */
function editLine(source: MapShapeTarget) {
  const lineType = source.lineType ?? 'IRRIGATION_PIPE'
  const cat = categorize(lineType)
  begin({ kind: 'line', mode: 'edit', ...(cat === 'ROAD' ? {} : { cat }) })
  target.value = source
  points.value = source.points.map(([lng, lat]) => [lng, lat])
  draftName.value = source.name
  draftType.value = lineType
  openLayers()
  fitToPoints()
}

function cancel() {
  if (saving.value) return
  closeLayers()
  points.value = []
  target.value = null
  setActive(null)
}

async function save() {
  const shape = active.value
  if (!shape || saving.value || points.value.length < minPoints.value) return
  const name = draftName.value.trim()
  if (name === '') {
    ElMessage.warning(`请填写${kindLabel.value}名称`)
    return
  }
  saving.value = true
  let saved: MapShapeSaved | null = null
  try {
    if (shape.kind === 'line') {
      const geom = { type: 'LineString' as const, coordinates: points.value.map(([lng, lat]) => [lng, lat]), srid: 4490 }
      if (shape.mode === 'edit' && target.value) {
        const updated = await plotApi.updateInfraLine(target.value.code, { lineName: name, lineType: draftType.value, geom })
        ElMessage.success(`管线「${updated.lineName}」已更新 · ${updated.lengthM.toFixed(0)} 米`)
        saved = { kind: 'line', mode: 'edit', code: updated.lineCode }
      } else {
        const created = await plotApi.createInfraLine({ lineName: name, lineType: draftType.value, geom })
        ElMessage.success(`已保存「${created.lineName}」· ${created.lengthM.toFixed(0)} 米`)
        saved = { kind: 'line', mode: 'create', code: created.lineCode }
      }
    } else if (shape.kind === 'plot') {
      const areaMu = Number(polygonAreaMu(points.value).toFixed(2))
      const geom = toPolygonGeom(points.value)
      if (shape.mode === 'edit' && target.value) {
        const updated = await plotApi.patch(target.value.code, {
          parcelName: name, areaMu, geom, plotType: draftPlotType.value, zoneCode: draftZoneCode.value || null,
        })
        ElMessage.success(`地块「${updated.name}」已更新 · ${areaMu.toFixed(2)} 亩`)
        saved = { kind: 'plot', mode: 'edit', code: updated.parcelCode }
      } else {
        const created = await plotApi.createFromMap({
          name, type: draftPlotType.value, areaMu, coordinates: points.value.map((p) => [p[0], p[1]] as [number, number]),
          ...(draftZoneCode.value ? { zoneCode: draftZoneCode.value } : {}),
        })
        ElMessage.success(`已新增地块「${created.name}」· ${areaMu.toFixed(2)} 亩`)
        saved = { kind: 'plot', mode: 'create', code: created.parcelCode }
      }
    } else {
      const geom = toPolygonGeom(points.value)
      if (shape.mode === 'edit' && target.value) {
        const updated = await zoneApi.update(target.value.code, { zoneName: name, color: draftColor.value, geom })
        ElMessage.success(`片区「${updated.zoneName}」已更新`)
        saved = { kind: 'zone', mode: 'edit', code: updated.zoneCode }
      } else {
        const created = await zoneApi.create({ zoneName: name, color: draftColor.value, geom })
        ElMessage.success(`已新增片区「${created.zoneName}」`)
        saved = { kind: 'zone', mode: 'create', code: created.zoneCode }
      }
    }
  } catch {
    // 失败原因由请求拦截器提示，保留草稿便于直接重试
  } finally {
    saving.value = false
  }
  if (saved) {
    cancel()
    emit('saved', saved)
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && active.value && !saving.value) cancel()
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (map) {
    map.off('click', handleMapClick)
    map.off('mousemove', handleMapMouseMove)
  }
  closeLayers()
  map = null
})

defineExpose({ attach, startLine, startPlot, startZone, editPlot, editZone, editLine, cancel })
</script>

<style scoped lang="scss">
.shape-editor { position: absolute; top: 16px; left: 248px; z-index: 950; width: 288px; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: rgba(6,22,42,.92); border: 1px solid rgba(0,212,255,.34); border-radius: 4px; backdrop-filter: blur(10px); box-shadow: 0 10px 30px rgba(0,0,0,.4); color: #e8f5ff; font-family: "Microsoft YaHei", sans-serif; }
.shape-editor__head { display: flex; align-items: center; gap: 8px; }
.se-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.se-title { flex: 1; color: #d6f4ff; font-size: 13px; font-weight: 600; }
.se-x { width: 20px; height: 20px; padding: 0; border: 0; background: none; color: #7c98a9; cursor: pointer; font-size: 15px; line-height: 1; }
.se-x:hover { color: #ff8a65; }
.se-field { display: flex; align-items: center; gap: 8px; color: #9fc3d3; font-size: 12px; }
.se-field > span { flex: none; width: 30px; }
.se-input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid rgba(0,212,255,.28); border-radius: 3px; background: rgba(4,16,31,.9); color: #e8f5ff; font-size: 12px; }
.se-input option { background: #0b2943; color: #e8f5ff; }
.se-input:focus { outline: none; border-color: #00d4ff; }
.se-color { flex: none; width: 46px; height: 26px; padding: 1px 2px; border: 1px solid rgba(0,212,255,.28); border-radius: 3px; background: rgba(4,16,31,.9); cursor: pointer; }
.se-stat { color: #7fe7ff; font-size: 12px; font-variant-numeric: tabular-nums; }
.se-actions { display: flex; gap: 6px; }
.se-actions button { flex: 1; padding: 6px 0; border: 1px solid rgba(0,212,255,.28); border-radius: 3px; background: rgba(0,98,133,.35); color: #cdeeff; cursor: pointer; font-size: 12px; }
.se-actions button:hover:not(:disabled) { background: rgba(0,150,199,.55); color: #fff; }
.se-actions button:disabled { opacity: .4; cursor: not-allowed; }
.se-actions button.primary { background: #00d4ff; border-color: #00d4ff; color: #04121f; font-weight: 600; }
.se-actions button.primary:hover:not(:disabled) { background: #57e2ff; color: #04121f; }
.se-hint { color: #7c98a9; font-size: 11px; line-height: 1.6; }

@media (min-width: 1600px) { .shape-editor { left: 276px; } }
@media (max-width: 900px) { .shape-editor { left: 200px; width: 256px; } }
@media (max-width: 640px) { .shape-editor { top: auto; bottom: 10px; left: 10px; right: 10px; width: auto; } }
</style>

<!-- 顶点标记与序号气泡挂在地图容器下，不在本组件子树内，只能用全局样式 -->
<style lang="scss">
.se-vertex { background: none; border: 0; }
.se-vertex i { display: block; box-sizing: border-box; width: 14px; height: 14px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 6px rgba(0,0,0,.55); cursor: move; }
.se-vertex-label { padding: 0 4px; border: 0; background: rgba(6,22,42,.85); color: #d6f4ff; font-size: 10px; box-shadow: none; }
.se-vertex-label::before { display: none; }
</style>