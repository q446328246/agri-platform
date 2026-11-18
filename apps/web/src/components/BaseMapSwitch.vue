<template>
  <div class="basemap-switch">
    <div class="basemap-switch__row">
      <button
        v-for="opt in options"
        :key="opt.key"
        type="button"
        class="basemap-switch__chip"
        :class="{ 'basemap-switch__chip--active': modelValue === opt.key }"
        :title="opt.hint"
        @click="emit('update:modelValue', opt.key)"
      >{{ opt.label }}</button>
      <button type="button" class="basemap-switch__gear" title="自定义影像源（XYZ 瓦片地址 / 无人机正射 / 本地瓦片服务）" @click="openDialog">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 5.2A2.8 2.8 0 1 0 8 10.8 2.8 2.8 0 0 0 8 5.2zm0 4.3A1.5 1.5 0 1 1 8 6.5a1.5 1.5 0 0 1 0 3zm6.1-1.5c0-.3 0-.6-.1-.9l1.2-1-.9-2.2-1.5.4c-.4-.4-.9-.7-1.4-.9L11 1.9H8.9l-.4 1.5c-.5.2-1 .5-1.4.9l-1.5-.4-.9 2.2 1.2 1c0 .3-.1.6-.1.9s0 .6.1.9l-1.2 1 .9 2.2 1.5-.4c.4.4.9.7 1.4.9l.4 1.5H11l.4-1.5c.5-.2 1-.5 1.4-.9l1.5.4.9-2.2-1.2-1c.1-.3.1-.6.1-.9z"/></svg>
      </button>
    </div>
    <div v-if="map" class="basemap-switch__row basemap-switch__zoom">
      <button type="button" class="basemap-switch__step" title="缩小一级" @click="step(-1)">−</button>
      <input
        type="range"
        class="basemap-switch__slider"
        :min="minZoom"
        :max="maxZoom"
        step="1"
        :value="zoomLevel"
        title="拖动精确设定缩放级别"
        @input="onSlider"
      />
      <button type="button" class="basemap-switch__step" title="放大一级" @click="step(1)">＋</button>
      <span
        class="basemap-switch__level"
        :class="{ 'basemap-switch__level--over': overZoom }"
        :title="overZoom ? '已超过当前影像原生 ' + nativeZoom + ' 级，为插值放大；换谷歌影像或自定义高清源可更清晰' : '当前缩放级别（原生 ' + nativeZoom + ' 级内为真实影像细节）'"
      >{{ zoomLevel }} 级</span>
      <button
        type="button"
        class="basemap-switch__box"
        :class="{ 'basemap-switch__box--on': boxMode }"
        :title="boxMode ? '退出框选放大（Esc）' : '框选放大：拖出矩形松开即放大到该区域；一次性工具，Esc 取消'"
        @click="toggleBox"
      >框选</button>
    </div>
    <div v-if="map && tools" class="basemap-switch__row basemap-switch__tools">
      <button
        type="button"
        class="basemap-switch__tool"
        :class="{ 'basemap-switch__tool--on': measuring === 'distance' }"
        :title="measuring === 'distance' ? '退出测距（Esc）' : '测距：单击加点，双击结束，Esc 取消；临时测量不入库'"
        @click="emit('measure', 'distance')"
      >测距</button>
      <button
        type="button"
        class="basemap-switch__tool"
        :class="{ 'basemap-switch__tool--on': measuring === 'area' }"
        :title="measuring === 'area' ? '退出测面（Esc）' : '测面：单击加点，双击结束；面积与地块台账同一套公式（亩）'"
        @click="emit('measure', 'area')"
      >测面</button>
      <button type="button" class="basemap-switch__tool" title="导出当前视野 PNG（含底图与地块边界；底图源不允许跨域读取时导出矢量图幅）" @click="emit('export-png')">导出</button>
      <button type="button" class="basemap-switch__tool" title="清除图上已完成的测量结果" @click="emit('clear-measure')">清除</button>
    </div>

    <el-dialog v-model="dialogVisible" title="自定义影像源" width="480px" append-to-body :close-on-click-modal="false">
      <el-form label-width="92px" label-position="left" class="basemap-custom-form">
        <el-form-item label="名称">
          <el-input v-model="form.name" maxlength="12" placeholder="如：无人机正射影像" />
        </el-form-item>
        <el-form-item label="瓦片 URL">
          <el-input v-model="form.url" type="textarea" :rows="2" placeholder="https://host/tiles/{z}/{x}/{y}.png，含 {s} 时配合子域使用" />
        </el-form-item>
        <el-form-item label="子域">
          <el-input v-model="form.subdomains" placeholder="可选，如 0,1,2,3（对应 URL 中的 {s}）" />
        </el-form-item>
        <el-form-item label="原生最高级">
          <el-input-number v-model="form.maxNativeZoom" :min="1" :max="24" />
          <span class="basemap-custom-form__hint">瓦片真实细节的最高级别</span>
        </el-form-item>
        <el-form-item label="显示最高级">
          <el-input-number v-model="form.maxZoom" :min="form.maxNativeZoom" :max="24" />
          <span class="basemap-custom-form__hint">超过原生级为插值放大</span>
        </el-form-item>
        <el-form-item label="测试加载">
          <div class="basemap-custom-preview">
            <el-button size="small" :disabled="!map || !urlValid" @click="preview">加载当前视野瓦片</el-button>
            <img v-if="previewUrl" :key="previewSeq" :src="previewUrl" alt="瓦片预览" @load="previewState = 'ok'" @error="previewState = 'fail'" />
            <span v-if="previewState === 'ok'" class="basemap-custom-preview__ok">瓦片加载成功</span>
            <span v-else-if="previewState === 'fail'" class="basemap-custom-preview__fail">加载失败，检查 URL / 子域 / 跨域</span>
            <span v-else-if="!map" class="basemap-custom-preview__muted">打开地图后可预览</span>
          </div>
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon title="自定义源按 WGS84（无偏移）约定接入；高德等 GCJ-02 源请勿在此接入，否则边界会偏移。" />
      </el-form>
      <template #footer>
        <el-button v-if="customCfg" type="danger" plain @click="removeCustom">移除自定义源</el-button>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!urlValid" @click="saveCustom">保存并切换</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import L from 'leaflet'
import {
  BASE_MAP_OPTIONS,
  baseMapNativeZoom,
  clearCustomBaseMap,
  readCustomBaseMap,
  storeCustomBaseMap,
  type BaseMapKey,
} from '@/utils/basemap'

/** 亮色主题底图切换条：绝对定位浮于地图容器右上，父容器须 position: relative。
 *  与地图容器互为兄弟节点，点击不会落到 Leaflet 画布上（绘制态不会误加顶点）。
 *  第二行精确缩放条（滑杆/步进/级别徽标/框选放大）需父组件传入 map 实例才显示。 */
const props = defineProps<{ modelValue: BaseMapKey; map?: any; measuring?: 'distance' | 'area' | null; tools?: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: BaseMapKey): void
  (e: 'custom-updated'): void
  (e: 'measure', mode: 'distance' | 'area'): void
  (e: 'export-png'): void
  (e: 'clear-measure'): void
}>()

const customCfg = ref(readCustomBaseMap())
const options = computed(() =>
  customCfg.value
    ? [...BASE_MAP_OPTIONS, { key: 'custom' as BaseMapKey, label: customCfg.value.name, hint: '自定义 XYZ 影像源：' + customCfg.value.url }]
    : BASE_MAP_OPTIONS,
)

// ---------- 精确缩放条：滑杆 / 步进 / 级别徽标，随地图 zoom 事件实时同步 ----------
const zoomLevel = ref(0)
const minZoom = ref(0)
const maxZoom = ref(22)
const nativeZoom = computed(() => baseMapNativeZoom(props.modelValue))
const overZoom = computed(() => zoomLevel.value > nativeZoom.value)

function syncZoom() {
  const m = props.map
  if (!m) return
  zoomLevel.value = Math.round(m.getZoom())
  minZoom.value = m.getMinZoom()
  maxZoom.value = m.getMaxZoom()
}

function step(delta: number) {
  props.map?.setZoom(zoomLevel.value + delta)
}

function onSlider(e: Event) {
  props.map?.setZoom(Number((e.target as HTMLInputElement).value))
}

// ---------- 框选放大：拖矩形自定义放大区域；期间捕获 click 抑制绘制态误加顶点 ----------
// 一次性工具：松开即退出并恢复拖移/双击缩放，避免停留框选态把地图拖移误当画矩形（"只能缩放不能移动"）
const boxMode = ref(false)
let boxCleanup: (() => void) | null = null

function stopBox() {
  boxCleanup?.()
  boxCleanup = null
  boxMode.value = false
}

function startBox() {
  const m = props.map
  if (!m) return
  boxMode.value = true
  m.dragging.disable()
  m.doubleClickZoom.disable()
  const container = m.getContainer() as HTMLElement
  const prevCursor = container.style.cursor
  container.style.cursor = 'crosshair'
  // 地图内浮提示：明示一次性语义与退出键，避免拖移被禁用期间误以为地图卡死
  const hint = document.createElement('div')
  hint.style.cssText = 'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:650;pointer-events:none;padding:4px 10px;border-radius:4px;background:rgba(7,25,48,.85);color:#7fe7ff;font-size:12px;white-space:nowrap;'
  hint.textContent = '框选放大：拖出矩形松开即放大 · Esc 取消'
  container.appendChild(hint)
  let start: any = null
  let rect: HTMLDivElement | null = null
  const suppressClick = (e: Event) => e.stopPropagation()
  container.addEventListener('click', suppressClick, true)
  const draw = (a: any, b: any) => {
    if (!rect) return
    rect.style.left = Math.min(a.x, b.x) + 'px'
    rect.style.top = Math.min(a.y, b.y) + 'px'
    rect.style.width = Math.abs(a.x - b.x) + 'px'
    rect.style.height = Math.abs(a.y - b.y) + 'px'
  }
  const down = (e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    start = m.mouseEventToContainerPoint(e)
    rect = document.createElement('div')
    rect.style.cssText = 'position:absolute;z-index:650;border:1.5px dashed #409eff;background:rgba(64,158,255,.18);pointer-events:none;'
    container.appendChild(rect)
    draw(start, start)
  }
  const move = (e: MouseEvent) => {
    if (start) draw(start, m.mouseEventToContainerPoint(e))
  }
  const up = (e: MouseEvent) => {
    if (!start) return
    const end = m.mouseEventToContainerPoint(e)
    const wide = Math.abs(end.x - start.x) > 8 && Math.abs(end.y - start.y) > 8
    rect?.remove()
    rect = null
    const a = start
    start = null
    if (wide) m.fitBounds(L.latLngBounds(m.containerPointToLatLng(a), m.containerPointToLatLng(end)), { padding: [16, 16] })
    stopBox()
  }
  const cancel = () => {
    rect?.remove()
    rect = null
    start = null
    stopBox()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cancel()
  }
  container.addEventListener('mousedown', down)
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  window.addEventListener('keydown', onKey)
  // 拖拽中切走窗口（alt-tab 等）mouseup 不会落回本页：失焦即取消，防矩形与禁用态残留
  window.addEventListener('blur', cancel)
  boxCleanup = () => {
    container.removeEventListener('click', suppressClick, true)
    container.removeEventListener('mousedown', down)
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('blur', cancel)
    rect?.remove()
    hint.remove()
    container.style.cursor = prevCursor
    m.dragging.enable()
    m.doubleClickZoom.enable()
  }
}

function toggleBox() {
  if (boxMode.value) stopBox()
  else startBox()
}

watch(
  () => props.map,
  (m, old) => {
    stopBox()
    if (old) {
      old.off('zoomend', syncZoom)
      old.off('zoom', syncZoom)
    }
    if (m) {
      m.on('zoomend', syncZoom)
      m.on('zoom', syncZoom)
      syncZoom()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  stopBox()
  if (props.map) {
    props.map.off('zoomend', syncZoom)
    props.map.off('zoom', syncZoom)
  }
})

// ---------- 自定义影像源对话框：URL 校验 + 当前视野瓦片试加载预览 ----------
const dialogVisible = ref(false)
const previewUrl = ref('')
const previewSeq = ref(0)
const previewState = ref<'' | 'ok' | 'fail'>('')
const form = reactive({ name: '自定义影像', url: '', subdomains: '', maxNativeZoom: 20, maxZoom: 22 })
const urlValid = computed(() => /^https?:\/\//.test(form.url.trim()) && form.url.includes('{x}') && form.url.includes('{y}') && form.url.includes('{z}'))

function openDialog() {
  const cfg = readCustomBaseMap()
  form.name = cfg?.name ?? '自定义影像'
  form.url = cfg?.url ?? ''
  form.subdomains = cfg?.subdomains.join(',') ?? ''
  form.maxNativeZoom = cfg?.maxNativeZoom ?? 20
  form.maxZoom = cfg?.maxZoom ?? 22
  previewUrl.value = ''
  previewState.value = ''
  dialogVisible.value = true
}

/** 用当前地图中心与原生级别算瓦片号试加载，保存前即可确认源可用 */
function preview() {
  const m = props.map
  if (!m || !urlValid.value) return
  const center = m.getCenter()
  const z = Math.min(form.maxNativeZoom, Math.max(1, Math.round(m.getZoom())))
  const n = 2 ** z
  const x = Math.floor(((center.lng + 180) / 360) * n)
  const rad = (center.lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  const subs = form.subdomains.split(',').map((s) => s.trim()).filter(Boolean)
  previewState.value = ''
  previewSeq.value += 1
  previewUrl.value = form.url
    .trim()
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{s}', subs[0] ?? '0')
}

function saveCustom() {
  if (!urlValid.value) return
  const native = Math.min(24, Math.max(1, form.maxNativeZoom))
  const cfg = {
    name: form.name.trim() || '自定义影像',
    url: form.url.trim(),
    subdomains: form.subdomains.split(',').map((s) => s.trim()).filter(Boolean),
    maxNativeZoom: native,
    maxZoom: Math.min(24, Math.max(native, form.maxZoom)),
  }
  storeCustomBaseMap(cfg)
  customCfg.value = cfg
  dialogVisible.value = false
  const wasCustom = props.modelValue === 'custom'
  emit('update:modelValue', 'custom')
  // 已停在自定义源上改配置：v-model 同值不触发父级切换，须显式通知重建底图
  if (wasCustom) emit('custom-updated')
}

function removeCustom() {
  clearCustomBaseMap()
  customCfg.value = null
  dialogVisible.value = false
  if (props.modelValue === 'custom') emit('update:modelValue', 'tdt-img')
}
</script>

<style scoped lang="scss">
.basemap-switch {
  position: absolute;
  z-index: 500;
  top: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.basemap-switch__row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.basemap-switch__chip {
  padding: 4px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #606266;
  font-size: 12px;
  cursor: pointer;
}

.basemap-switch__chip--active {
  background: #409eff;
  color: #fff;
}

.basemap-switch__gear {
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #909399;
  cursor: pointer;
}

.basemap-switch__gear:hover {
  background: #ecf5ff;
  color: #409eff;
}

.basemap-switch__zoom {
  padding: 2px 4px 3px;
  border-top: 1px solid #ebeef5;
}

.basemap-switch__step {
  width: 20px;
  height: 20px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #606266;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.basemap-switch__step:hover {
  border-color: #409eff;
  color: #409eff;
}

.basemap-switch__slider {
  width: 96px;
  height: 4px;
  appearance: none;
  border-radius: 2px;
  background: linear-gradient(90deg, #409eff, #79bbff);
  outline: none;
  cursor: pointer;
}

.basemap-switch__slider::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #409eff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  cursor: grab;
}

.basemap-switch__slider::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #409eff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  cursor: grab;
}

.basemap-switch__level {
  min-width: 34px;
  padding: 2px 4px;
  border-radius: 4px;
  background: #ecf5ff;
  color: #409eff;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
}

.basemap-switch__level--over {
  background: #fdf6ec;
  color: #e6a23c;
}

.basemap-switch__box {
  padding: 3px 7px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #606266;
  font-size: 11px;
  cursor: pointer;
}

.basemap-switch__box--on {
  border-color: #409eff;
  background: #409eff;
  color: #fff;
}

.basemap-switch__tools {
  padding: 2px 4px 3px;
  border-top: 1px solid #ebeef5;
}

.basemap-switch__tool {
  padding: 3px 7px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #606266;
  font-size: 11px;
  cursor: pointer;
}

.basemap-switch__tool:hover {
  border-color: #409eff;
  color: #409eff;
}

.basemap-switch__tool--on {
  border-color: #e6a23c;
  background: #fdf6ec;
  color: #e6a23c;
  font-weight: 600;
}

.basemap-custom-form__hint {
  margin-left: 8px;
  color: #909399;
  font-size: 12px;
}

.basemap-custom-preview {
  display: flex;
  align-items: center;
  gap: 8px;

  img {
    width: 64px;
    height: 64px;
    border: 1px solid #dcdfe6;
    border-radius: 4px;
    object-fit: cover;
  }
}

.basemap-custom-preview__ok {
  color: #67c23a;
  font-size: 12px;
}

.basemap-custom-preview__fail {
  color: #f56c6c;
  font-size: 12px;
}

.basemap-custom-preview__muted {
  color: #909399;
  font-size: 12px;
}
</style>