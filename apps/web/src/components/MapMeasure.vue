<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import L from 'leaflet'
import { polygonAreaMu, polylineLengthM } from '@/utils/geo'
import type { MeasureMode } from '@/utils/measure'

/** 地图测距/测面：临时图层 + 实时 tooltip，不入库不改业务数据。
 *  面积/长度直接复用 utils/geo 的 polygonAreaMu / polylineLengthM——与地块落库面积同一套公式，
 *  测面结果与台账口径天然一致（验收要求误差 <1%）。
 *  交互：单击逐点加点，鼠标移动实时预览末段与累计值，双击结束（结果保留在图上），Esc 取消草稿。
 *  一次性工具：结束/取消即恢复双击缩放与光标；结果用「清除」按钮或下次测量开始时移除。 */

const props = defineProps<{ map?: any }>()
const emit = defineEmits<{ (e: 'active-change', mode: MeasureMode | null): void }>()

let mode: MeasureMode | null = null
let points: any[] = []
let draft: any = null
let result: any = null
let preview: any = null
let tip: any = null
let cleanup: (() => void) | null = null

const LINE_STYLE = { color: '#ffd54f', weight: 2, opacity: 0.95, dashArray: '6 4' }
const FILL_STYLE = { color: '#ffd54f', weight: 2, fillColor: '#ffd54f', fillOpacity: 0.15 }

function fmtDistance(m: number): string {
  return m < 1000 ? `${m.toFixed(1)} 米` : `${(m / 1000).toFixed(2)} 公里`
}
function fmtArea(mu: number): string {
  return `${mu.toFixed(2)} 亩（${Math.round(mu * 666.6667)} ㎡）`
}
/** 累计值含光标悬停点，移动时即见「再点一下会是多少」 */
function measureText(extra?: any): string {
  const pts = extra ? [...points, extra] : points
  if (mode === 'area') return pts.length >= 3 ? `面积 ${fmtArea(polygonAreaMu(pts.map((p) => [p.lng, p.lat])))}` : '单击加点，至少 3 点成面'
  return pts.length >= 2 ? `距离 ${fmtDistance(polylineLengthM(pts.map((p) => [p.lng, p.lat])))}` : '单击加点测距'
}

function redraw() {
  if (!draft) return
  draft.clearLayers()
  for (const p of points) draft.addLayer(L.circleMarker(p, { radius: 4, color: '#ffd54f', weight: 1.5, fillColor: '#fff', fillOpacity: 1 }))
  if (points.length >= 2) draft.addLayer(L.polyline(points, LINE_STYLE))
  if (mode === 'area' && points.length >= 3) draft.addLayer(L.polygon(points, FILL_STYLE))
}

function stop() {
  cleanup?.()
  cleanup = null
  mode = null
  points = []
  preview = null
  emit('active-change', null)
}

/** 取消草稿（结果层保留，供对照后再清） */
function cancel() {
  draft?.remove()
  draft = null
  tip?.remove()
  tip = null
  stop()
}

/** 清除已完成的测量结果 */
function clear() {
  result?.remove()
  result = null
}

function start(next: MeasureMode) {
  const m = props.map
  if (!m) return
  cancel()
  clear()
  mode = next
  points = []
  draft = L.layerGroup().addTo(m)
  tip = L.tooltip({ direction: 'top', offset: [0, -10], className: 'measure-tip', opacity: 1 }).setLatLng(m.getCenter()).setContent(measureText()).addTo(m)
  m.doubleClickZoom.disable()
  const container = m.getContainer() as HTMLElement
  const prevCursor = container.style.cursor
  container.style.cursor = 'crosshair'
  const onClick = (e: any) => {
    const last = points[points.length - 1]
    if (last && last.equals(e.latlng)) return
    points.push(e.latlng)
    redraw()
    tip?.setContent(measureText())
  }
  const onMove = (e: any) => {
    if (!mode) return
    const last = points[points.length - 1]
    if (preview) { preview.remove(); preview = null }
    if (last) preview = L.polyline([last, e.latlng], { ...LINE_STYLE, opacity: 0.5 }).addTo(m)
    tip?.setLatLng(e.latlng).setContent(`${measureText(e.latlng)}<br/><span class="measure-tip-hint">单击加点 · 双击结束 · Esc 取消</span>`)
  }
  const onDbl = () => finish()
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
  const onBlur = () => cancel()
  m.on('click', onClick)
  m.on('mousemove', onMove)
  m.on('dblclick', onDbl)
  window.addEventListener('keydown', onKey)
  window.addEventListener('blur', onBlur)
  cleanup = () => {
    m.off('click', onClick)
    m.off('mousemove', onMove)
    m.off('dblclick', onDbl)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('blur', onBlur)
    preview?.remove()
    container.style.cursor = prevCursor
    m.doubleClickZoom.enable()
  }
  emit('active-change', next)
}

/** 双击收尾：dblclick 前的两次 click 落在同一点，去重后保留用户意图的末点 */
function finish() {
  const m = props.map
  if (!m || !mode) return
  const pts: any[] = []
  for (const p of points) {
    const last = pts[pts.length - 1]
    if (!last || !last.equals(p)) pts.push(p)
  }
  const enough = mode === 'area' ? pts.length >= 3 : pts.length >= 2
  if (!enough) { cancel(); return }
  const text = mode === 'area' ? `面积 ${fmtArea(polygonAreaMu(pts.map((p) => [p.lng, p.lat])))}` : `距离 ${fmtDistance(polylineLengthM(pts.map((p) => [p.lng, p.lat])))}`
  draft?.remove()
  draft = null
  tip?.remove()
  tip = null
  result?.remove()
  const group = L.layerGroup()
  if (mode === 'area') group.addLayer(L.polygon(pts, FILL_STYLE))
  else group.addLayer(L.polyline(pts, LINE_STYLE))
  for (const p of pts) group.addLayer(L.circleMarker(p, { radius: 4, color: '#ffd54f', weight: 1.5, fillColor: '#fff', fillOpacity: 1 }))
  const anchor = mode === 'area' ? L.latLngBounds(pts).getCenter() : pts[pts.length - 1]
  group.addLayer(L.marker(anchor, { icon: L.divIcon({ className: '', html: '', iconSize: [0, 0] }), interactive: false }).bindTooltip(text, { permanent: true, direction: 'top', className: 'measure-tip', offset: [0, -6] }).openTooltip())
  result = group.addTo(m)
  stop()
}

function toggle(next: MeasureMode) {
  if (mode === next) cancel()
  else start(next)
}

// 底图跨坐标系重建时旧图上的临时层随之失效：整体复位，避免监听器挂在已销毁的地图上
watch(() => props.map, (m) => {
  if (!m) { cancel(); clear() }
})
onBeforeUnmount(() => { cancel(); clear() })

defineExpose({ toggle, cancel, clear })
</script>

<style lang="scss">
/* tooltip 渲染在 Leaflet 自己的 pane 里，不在本组件 scoped 树内，须用全局样式 */
.measure-tip {
  padding: 5px 9px;
  border: 1px solid rgba(255, 213, 79, .55);
  border-radius: 4px;
  background: rgba(7, 25, 48, .92);
  color: #ffe082;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .4);
}
.measure-tip::before { display: none; }
.measure-tip-hint { color: #9fc3d3; font-size: 11px; font-weight: 400; }
</style>