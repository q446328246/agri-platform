<template>
  <div class="page-container">
    <div class="video-toolbar">
      <span class="video-title">视频监控</span>
      <el-tag v-if="total" type="info" size="small">{{ cameras.length }} / {{ total }} 台</el-tag>
      <span v-if="playableCount === 0 && cameras.length && activeTab === 'live'" class="video-hint">当前无在线摄像机</span>
      <div class="flex-spacer" />
      <el-tooltip content="刷新"><el-button circle size="small" @click="refreshActive"><el-icon><Refresh /></el-icon></el-button></el-tooltip>
    </div>

    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <el-tab-pane label="实时监看" name="live">
        <div class="search-bar">
          <el-form :inline="true" :model="query" @submit.prevent="search">
            <el-form-item label="关键词"><el-input v-model="query.keyword" placeholder="摄像机名称/编号" clearable style="width: 180px" /></el-form-item>
            <el-form-item label="地块编码"><el-input v-model="query.plotCode" placeholder="可选" clearable style="width: 170px" /></el-form-item>
            <el-form-item label="状态">
              <el-select v-model="query.status" placeholder="全部" clearable style="width: 110px">
                <el-option label="在线" value="ONLINE" />
                <el-option label="离线" value="OFFLINE" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" @click="search">查询</el-button><el-button @click="resetQuery">重置</el-button></el-form-item>
          </el-form>
        </div>

        <el-skeleton v-if="loading && !cameras.length" :rows="4" animated />
        <el-empty v-else-if="!cameras.length" description="暂无摄像机" />
        <el-row v-else :gutter="20">
          <el-col v-for="camera in cameras" :key="camera.id" :span="8" class="mb-20">
            <div class="camera-card">
              <div class="camera-screen" :ref="(el) => setScreenRef(camera.id, el)">
                <video
                  v-if="playable(camera)"
                  :ref="(el) => setVideoRef(camera.id, el)"
                  class="camera-video"
                  :class="{ visible: playState[camera.id] === 'playing' }"
                  controls
                  muted
                  playsinline
                  preload="auto"
                  @playing="playState[camera.id] = 'playing'"
                  @error="onVideoError(camera.id, $event)"
                />
                <div v-if="!playable(camera)" class="camera-placeholder">
                  <el-icon :size="40"><VideoCameraFilled /></el-icon>
                  <span>{{ camera.streamUrl ? '设备离线' : '无流地址' }}</span>
                </div>
                <div v-else-if="playState[camera.id] === 'loading'" class="camera-placeholder">
                  <el-icon :size="32" class="is-loading"><Loading /></el-icon>
                  <span>视频加载中…</span>
                </div>
                <div v-else-if="playState[camera.id] === 'error'" class="camera-placeholder">
                  <el-icon :size="40"><CircleCloseFilled /></el-icon>
                  <span>视频加载失败，流不可用</span>
                  <el-button size="small" @click="retry(camera)"><el-icon><RefreshRight /></el-icon>重试</el-button>
                </div>
              </div>

              <div class="camera-title">
                <strong>{{ camera.name }}</strong>
                <el-tag :type="camera.status === 'ONLINE' ? 'success' : 'info'" size="small">
                  {{ camera.status === 'ONLINE' ? '在线' : '离线' }}
                </el-tag>
              </div>

              <div v-if="camera.streamUrl" class="camera-url"><span :title="camera.streamUrl">{{ camera.streamUrl }}</span></div>

              <div class="camera-actions">
                <el-button size="small" @click="openPtz(camera)">云台控制</el-button>
                <el-button size="small" :disabled="!playable(camera)" @click="fullscreen(camera)">全屏</el-button>
                <el-button size="small" :disabled="playState[camera.id] !== 'playing'" @click="screenshot(camera)">截图</el-button>
                <el-button size="small" :disabled="!playable(camera)" @click="retry(camera)">
                  <el-icon><RefreshRight /></el-icon>刷新播放
                </el-button>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <el-tab-pane label="录像回放" name="recordings">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="loadRecordings">
            <el-form-item label="摄像机">
              <el-select v-model="recQuery.cameraId" placeholder="全部" clearable style="width: 200px">
                <el-option v-for="camera in cameras" :key="camera.id" :label="camera.name" :value="camera.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="开始日期">
              <el-date-picker v-model="recQuery.range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="起" end-placeholder="止" style="width: 260px" />
            </el-form-item>
            <el-form-item><el-button type="primary" @click="recPage = 1; loadRecordings()">查询</el-button><el-button @click="resetRecQuery">重置</el-button></el-form-item>
          </el-form>
        </div>
        <el-table v-loading="recLoading" :data="recordings" stripe>
          <el-table-column label="摄像机" min-width="160"><template #default="{ row }">{{ cameraName(row.cameraId) }}</template></el-table-column>
          <el-table-column label="开始时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.startedAt) }}</template></el-table-column>
          <el-table-column label="结束时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.endedAt) }}</template></el-table-column>
          <el-table-column label="时长" width="90"><template #default="{ row }">{{ durationText(row) }}</template></el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }"><el-button size="small" type="primary" link @click="playRecording(row)">回放</el-button></template>
          </el-table-column>
          <template #empty><el-empty description="暂无录像" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="recTotal" :page-size="recSize" v-model:current-page="recPage" @current-change="loadRecordings" />
      </el-tab-pane>

      <el-tab-pane label="AI 识别事件" name="ai">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="loadAiEvents">
            <el-form-item label="地块编码"><el-input v-model="aiQuery.plotCode" placeholder="可选" clearable style="width: 180px" /></el-form-item>
            <el-form-item label="转发状态">
              <el-select v-model="aiQuery.forwarded" placeholder="全部" clearable style="width: 130px">
                <el-option label="已转发" value="true" />
                <el-option label="待补投" value="false" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" @click="aiPage = 1; loadAiEvents()">查询</el-button><el-button @click="resetAiQuery">重置</el-button></el-form-item>
          </el-form>
        </div>
        <el-table v-loading="aiLoading" :data="aiEvents" stripe>
          <el-table-column label="摄像机" min-width="150"><template #default="{ row }">{{ cameraName(row.cameraId) }}</template></el-table-column>
          <el-table-column prop="plotCode" label="地块" min-width="180" show-overflow-tooltip />
          <el-table-column prop="pestType" label="虫害类型" width="110" />
          <el-table-column label="等级" width="80">
            <template #default="{ row }">
              <el-tag :type="row.level === 3 ? 'danger' : row.level === 2 ? 'warning' : 'info'" size="small">{{ ['', '轻微', '中等', '严重'][row.level] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="置信度" width="80"><template #default="{ row }">{{ Math.round(row.confidence * 100) }}%</template></el-table-column>
          <el-table-column label="识别时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.detectedAt) }}</template></el-table-column>
          <el-table-column label="转发状态" min-width="150">
            <template #default="{ row }">
              <el-tag v-if="row.forwarded" type="success" size="small">已转发</el-tag>
              <el-tooltip v-else :content="row.lastError || row.forwardMessage || '等待自动补投'" placement="top">
                <el-tag type="warning" size="small">待补投（已试 {{ row.retryCount }} 次）</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button v-if="!row.forwarded" size="small" type="primary" link :loading="retryingId === row.id" @click="retryAiEvent(row)">重试</el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无识别事件" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="aiTotal" :page-size="aiSize" v-model:current-page="aiPage" @current-change="loadAiEvents" />
      </el-tab-pane>

      <el-tab-pane label="云台指令历史" name="ptz">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="loadPtzCommands">
            <el-form-item label="摄像机">
              <el-select v-model="ptzFilterCameraId" placeholder="全部" clearable style="width: 200px">
                <el-option v-for="camera in cameras" :key="camera.id" :label="camera.name" :value="camera.id" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" @click="ptzPage = 1; loadPtzCommands()">查询</el-button><el-button @click="ptzFilterCameraId = ''; ptzPage = 1; loadPtzCommands()">重置</el-button></el-form-item>
          </el-form>
        </div>
        <el-table v-loading="ptzLoading" :data="ptzCommands" stripe>
          <el-table-column label="摄像机" min-width="150"><template #default="{ row }">{{ cameraName(row.cameraId) }}</template></el-table-column>
          <el-table-column label="动作" width="90"><template #default="{ row }">{{ PTZ_LABELS[row.action] ?? row.action }}</template></el-table-column>
          <el-table-column label="速度" width="70"><template #default="{ row }">{{ row.speed ?? '—' }}</template></el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'SENT' ? 'success' : row.status === 'FAILED' ? 'danger' : 'warning'" size="small">{{ PTZ_STATUS_LABELS[row.status] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="message" label="回执说明" min-width="220" show-overflow-tooltip />
          <el-table-column label="下发时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status !== 'SENT'" size="small" type="primary" link :loading="retryingId === row.id" @click="retryPtzCommand(row)">重试</el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无云台指令" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="ptzTotal" :page-size="ptzSize" v-model:current-page="ptzPage" @current-change="loadPtzCommands" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="ptzDialogVisible" :title="`云台控制 · ${ptzCamera?.name ?? ''}`" width="600px">
      <div class="ptz-panel">
        <div class="ptz-pad">
          <span /><el-button :disabled="!ptzCameraOnline" @click="ptzAction('UP')"><el-icon><Top /></el-icon>上仰</el-button><span />
          <el-button :disabled="!ptzCameraOnline" @click="ptzAction('LEFT')"><el-icon><Back /></el-icon>左转</el-button>
          <el-button :disabled="!ptzCameraOnline" type="danger" plain @click="ptzAction('STOP')"><el-icon><VideoPause /></el-icon>停止</el-button>
          <el-button :disabled="!ptzCameraOnline" @click="ptzAction('RIGHT')">右转<el-icon><Right /></el-icon></el-button>
          <span /><el-button :disabled="!ptzCameraOnline" @click="ptzAction('DOWN')"><el-icon><Bottom /></el-icon>下俯</el-button><span />
        </div>
        <div class="ptz-side">
          <div class="ptz-zoom">
            <el-button :disabled="!ptzCameraOnline" @click="ptzAction('ZOOM_IN')"><el-icon><ZoomIn /></el-icon>放大</el-button>
            <el-button :disabled="!ptzCameraOnline" @click="ptzAction('ZOOM_OUT')"><el-icon><ZoomOut /></el-icon>缩小</el-button>
          </div>
          <div class="ptz-speed">
            <span>速度</span>
            <el-input-number v-model="ptzSpeed" :min="1" :max="10" size="small" />
          </div>
          <p class="ptz-note">指令先留存台账，再经摄像机网关下发；未接入网关时保持「已排队」，接入后可重试。</p>
        </div>
      </div>
      <el-divider content-position="left">最近指令</el-divider>
      <el-table v-loading="ptzDialogLoading" :data="ptzDialogCommands" size="small" max-height="220">
        <el-table-column label="动作" width="80"><template #default="{ row }">{{ PTZ_LABELS[row.action] ?? row.action }}</template></el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 'SENT' ? 'success' : row.status === 'FAILED' ? 'danger' : 'warning'" size="small">{{ PTZ_STATUS_LABELS[row.status] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="回执" min-width="180" show-overflow-tooltip />
        <el-table-column label="时间" width="150"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" width="70">
          <template #default="{ row }">
            <el-button v-if="row.status !== 'SENT'" size="small" type="primary" link :loading="retryingId === row.id" @click="retryPtzCommand(row, true)">重试</el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无指令" :image-size="60" /></template>
      </el-table>
    </el-dialog>

    <el-dialog v-model="recordingDialogVisible" :title="`录像回放 · ${recordingPlaying ? cameraName(recordingPlaying.cameraId) : ''}`" width="820px" destroy-on-close @closed="stopRecordingPlayback">
      <div v-if="recordingPlaying" class="recording-meta">
        {{ formatDateTime(recordingPlaying.startedAt) }} 至 {{ formatDateTime(recordingPlaying.endedAt) }}（{{ durationText(recordingPlaying) }}）
      </div>
      <div class="camera-screen recording-screen">
        <video
          :ref="(el) => setVideoRef('recording', el)"
          class="camera-video"
          :class="{ visible: playState['recording'] === 'playing' }"
          controls
          muted
          playsinline
          preload="auto"
          @playing="playState['recording'] = 'playing'"
          @error="onVideoError('recording', $event)"
        />
        <div v-if="playState['recording'] === 'loading'" class="camera-placeholder">
          <el-icon :size="32" class="is-loading"><Loading /></el-icon>
          <span>录像加载中…</span>
        </div>
        <div v-else-if="playState['recording'] === 'error'" class="camera-placeholder">
          <el-icon :size="40"><CircleCloseFilled /></el-icon>
          <span>录像加载失败，回放地址不可用</span>
          <el-button size="small" @click="retryRecording"><el-icon><RefreshRight /></el-icon>重试</el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { videoApi } from '@/api'
import { formatDateTime } from '@/utils'
import type { Camera, PtzAction, PtzCommand, Recording, VideoAiEvent } from '@/types'

/** 播放状态：加载中、播放中、加载失败、未开始 */
type PlayState = 'loading' | 'playing' | 'error' | 'idle'
type TabName = 'live' | 'recordings' | 'ai' | 'ptz'

const PTZ_LABELS: Record<string, string> = { LEFT: '左转', RIGHT: '右转', UP: '上仰', DOWN: '下俯', ZOOM_IN: '放大', ZOOM_OUT: '缩小', STOP: '停止' }
const PTZ_STATUS_LABELS: Record<string, string> = { QUEUED: '已排队', SENT: '已下发', FAILED: '失败' }

const activeTab = ref<TabName>('live')
const loading = ref(false)
const cameras = ref<Camera[]>([])
const total = ref(0)
const query = reactive<{ keyword: string; plotCode: string; status: string }>({ keyword: '', plotCode: '', status: '' })
const playableCount = computed(() => cameras.value.filter((camera) => playable(camera)).length)
const playState = reactive<Record<string, PlayState>>({})
const videoEls = new Map<string, HTMLVideoElement>()
const screenEls = new Map<string, HTMLElement>()
const engines = new Map<string, () => void>()
const retryingId = ref('')

function setVideoRef(key: string, el: unknown) {
  if (el instanceof HTMLVideoElement) videoEls.set(key, el)
  else videoEls.delete(key)
}

function setScreenRef(cameraId: string, el: unknown) {
  if (el instanceof HTMLElement) screenEls.set(cameraId, el)
  else screenEls.delete(cameraId)
}

/** 摄像机是否应展示播放器：必须有流地址且在线 */
const playable = (camera: Camera) => Boolean(camera.streamUrl) && camera.status === 'ONLINE'
const cameraName = (cameraId: string) => cameras.value.find((camera) => camera.id === cameraId)?.name ?? cameraId

/** 原生视频源兜底：HLS 用 canPlayType 探测，FLV/未知协议直接判为不支持。 */
function useNativeSource(video: HTMLVideoElement, url: string): boolean {
  const protocol = url.split('?')[0]?.split('.').pop()?.toLowerCase()
  const canPlay = (type: string) => video.canPlayType(type) !== ''
  if (protocol === 'mp4' && canPlay('video/mp4')) video.src = url
  else if (protocol === 'webm' && canPlay('video/webm')) video.src = url
  else if (protocol === 'm3u8' && canPlay('application/vnd.apple.mpegurl')) video.src = url
  else return false
  return true
}

/** 按需加载 hls.js（可选依赖），失败时返回 null，由原生播放或错误占位兜底。 */
async function loadHls(): Promise<any | null> {
  try {
    const module = await import('hls.js')
    return module.default
  } catch {
    return null
  }
}

/** 挂载播放：优先 HLS.js 拉流，不支持时回退到原生 video，都不可用则提示失败。 */
async function playStream(key: string, url: string) {
  const video = videoEls.get(key)
  if (!video || !url) return
  destroyEngine(key)
  playState[key] = 'loading'
  if (useNativeSource(video, url)) {
    void video.play().catch(() => undefined)
    return
  }
  const Hls = await loadHls()
  if (!Hls || !Hls.isSupported?.()) {
    playState[key] = 'error'
    return
  }
  const hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 })
  const release = () => {
    hls.destroy()
    engines.delete(key)
  }
  engines.set(key, release)
  hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined))
  hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
    if (!data?.fatal) return
    release()
    playState[key] = 'error'
  })
  hls.loadSource(url)
  hls.attachMedia(video)
}

function destroyEngine(key: string) {
  engines.get(key)?.()
  engines.delete(key)
}

/** 切换/销毁播放器会清空 src 并触发一次空错误，只有真的带错误码的媒体故障才算拉流失败 */
function onVideoError(key: string, event: Event) {
  const video = event.target as HTMLVideoElement
  if (!video.error || !video.currentSrc) return
  playState[key] = 'error'
}

function retry(camera: Camera) {
  void playStream(camera.id, camera.streamUrl)
}

async function load() {
  loading.value = true
  try {
    const res = await videoApi.getCameras({
      page: 1,
      size: 100,
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.status ? { status: query.status } : {})
    })
    cameras.value = res.items ?? []
    total.value = res.total
    for (const camera of cameras.value) playState[camera.id] = playable(camera) ? 'loading' : 'idle'
    await nextTick()
    for (const camera of cameras.value) if (playable(camera)) void playStream(camera.id, camera.streamUrl)
  } catch {
    cameras.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function search() { void load() }
function resetQuery() { query.keyword = ''; query.plotCode = ''; query.status = ''; void load() }

/** 全屏：直接放大画面容器，退出由浏览器 Esc 处理 */
function fullscreen(camera: Camera) {
  const el = screenEls.get(camera.id)
  if (!el?.requestFullscreen) { ElMessage.warning('当前浏览器不支持全屏'); return }
  el.requestFullscreen().catch(() => ElMessage.warning('全屏被浏览器拒绝'))
}

/** 截图：抓取当前视频帧导出 PNG；跨域流未开 CORS 时画布被污染，如实报错而不是导出黑图 */
function screenshot(camera: Camera) {
  const video = videoEls.get(camera.id)
  if (!video || playState[camera.id] !== 'playing' || !video.videoWidth) { ElMessage.warning('请等待视频播放后再截图'); return }
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) { ElMessage.error('当前浏览器不支持截图'); return }
  ctx.drawImage(video, 0, 0)
  try {
    canvas.toBlob((blob) => {
      if (!blob) { ElMessage.error('截图失败'); return }
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${camera.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      link.click()
      URL.revokeObjectURL(link.href)
      ElMessage.success('截图已保存')
    }, 'image/png')
  } catch {
    ElMessage.error('视频流存在跨域限制，无法截图（需流媒体侧开启 CORS）')
  }
}

// —— 云台控制 ——
const ptzDialogVisible = ref(false)
const ptzCamera = ref<Camera | null>(null)
const ptzSpeed = ref(5)
const ptzDialogCommands = ref<PtzCommand[]>([])
const ptzDialogLoading = ref(false)
const ptzCameraOnline = computed(() => Boolean(ptzCamera.value && playable(ptzCamera.value)))

function openPtz(camera: Camera) {
  ptzCamera.value = camera
  ptzDialogVisible.value = true
  void loadPtzDialogCommands()
}

async function loadPtzDialogCommands() {
  if (!ptzCamera.value) return
  ptzDialogLoading.value = true
  try {
    const res = await videoApi.getPtzCommands({ page: 1, size: 5, cameraId: ptzCamera.value.id })
    ptzDialogCommands.value = res.items ?? []
  } catch {
    ptzDialogCommands.value = []
  } finally {
    ptzDialogLoading.value = false
  }
}

/** 按后端真实回执提示：已下发/失败/通道未接入排队，不假装成功 */
function reportPtzResult(command: PtzCommand) {
  const text = command.message || PTZ_STATUS_LABELS[command.status]
  if (command.status === 'SENT') ElMessage.success(text)
  else if (command.status === 'FAILED') ElMessage.error(text)
  else ElMessage.warning(text)
}

async function ptzAction(action: PtzAction) {
  if (!ptzCamera.value) return
  try {
    const command = await videoApi.sendPtz(ptzCamera.value.id, { action, speed: ptzSpeed.value })
    reportPtzResult(command)
    void loadPtzDialogCommands()
  } catch {
    ElMessage.error('云台指令下发失败')
  }
}

async function retryPtzCommand(command: PtzCommand, inDialog = false) {
  retryingId.value = command.id
  try {
    const updated = await videoApi.retryPtz(command.id)
    reportPtzResult(updated)
    if (inDialog) void loadPtzDialogCommands()
    else void loadPtzCommands()
  } catch {
    ElMessage.error('云台指令重试失败')
  } finally {
    retryingId.value = ''
  }
}

// —— 录像回放 ——
const recQuery = reactive<{ cameraId: string; range: string[] }>({ cameraId: '', range: [] })
const recordings = ref<Recording[]>([])
const recLoading = ref(false)
const recPage = ref(1)
const recSize = 10
const recTotal = ref(0)
const recordingDialogVisible = ref(false)
const recordingPlaying = ref<Recording | null>(null)

async function loadRecordings() {
  recLoading.value = true
  try {
    const res = await videoApi.getRecordings({
      page: recPage.value,
      size: recSize,
      ...(recQuery.cameraId ? { cameraId: recQuery.cameraId } : {}),
      ...(recQuery.range?.[0] ? { from: recQuery.range[0] } : {}),
      ...(recQuery.range?.[1] ? { to: recQuery.range[1] } : {})
    })
    recordings.value = res.items ?? []
    recTotal.value = res.total
  } catch {
    recordings.value = []
    recTotal.value = 0
  } finally {
    recLoading.value = false
  }
}

function resetRecQuery() { recQuery.cameraId = ''; recQuery.range = []; recPage.value = 1; void loadRecordings() }

function durationText(recording: Recording): string {
  const minutes = Math.max(0, Math.round((Date.parse(recording.endedAt) - Date.parse(recording.startedAt)) / 60000))
  return `${minutes} 分钟`
}

async function playRecording(recording: Recording) {
  recordingPlaying.value = recording
  recordingDialogVisible.value = true
  playState['recording'] = 'loading'
  await nextTick()
  void playStream('recording', recording.playbackUrl)
}

function retryRecording() {
  if (recordingPlaying.value) void playStream('recording', recordingPlaying.value.playbackUrl)
}

function stopRecordingPlayback() {
  destroyEngine('recording')
  videoEls.delete('recording')
  playState['recording'] = 'idle'
  recordingPlaying.value = null
}

// —— AI 识别事件 ——
const aiQuery = reactive<{ plotCode: string; forwarded: string }>({ plotCode: '', forwarded: '' })
const aiEvents = ref<VideoAiEvent[]>([])
const aiLoading = ref(false)
const aiPage = ref(1)
const aiSize = 10
const aiTotal = ref(0)

async function loadAiEvents() {
  aiLoading.value = true
  try {
    const res = await videoApi.getAiEvents({
      page: aiPage.value,
      size: aiSize,
      ...(aiQuery.plotCode ? { plotCode: aiQuery.plotCode } : {}),
      ...(aiQuery.forwarded ? { forwarded: aiQuery.forwarded === 'true' } : {})
    })
    aiEvents.value = res.items ?? []
    aiTotal.value = res.total
  } catch {
    aiEvents.value = []
    aiTotal.value = 0
  } finally {
    aiLoading.value = false
  }
}

function resetAiQuery() { aiQuery.plotCode = ''; aiQuery.forwarded = ''; aiPage.value = 1; void loadAiEvents() }

async function retryAiEvent(event: VideoAiEvent) {
  retryingId.value = event.id
  try {
    const updated = await videoApi.retryAiEvent(event.id)
    if (updated.forwarded) ElMessage.success('转发成功，已生成虫情告警')
    else ElMessage.warning(updated.forwardMessage || '遥测服务仍不可达，稍后再试')
    void loadAiEvents()
  } catch {
    ElMessage.error('识别事件重试失败')
  } finally {
    retryingId.value = ''
  }
}

// —— 云台指令历史 ——
const ptzFilterCameraId = ref('')
const ptzCommands = ref<PtzCommand[]>([])
const ptzLoading = ref(false)
const ptzPage = ref(1)
const ptzSize = 10
const ptzTotal = ref(0)

async function loadPtzCommands() {
  ptzLoading.value = true
  try {
    const res = await videoApi.getPtzCommands({
      page: ptzPage.value,
      size: ptzSize,
      ...(ptzFilterCameraId.value ? { cameraId: ptzFilterCameraId.value } : {})
    })
    ptzCommands.value = res.items ?? []
    ptzTotal.value = res.total
  } catch {
    ptzCommands.value = []
    ptzTotal.value = 0
  } finally {
    ptzLoading.value = false
  }
}

function onTabChange(name: string | number) {
  if (name === 'recordings') void loadRecordings()
  else if (name === 'ai') void loadAiEvents()
  else if (name === 'ptz') void loadPtzCommands()
}

function refreshActive() {
  if (activeTab.value === 'live') void load()
  else if (activeTab.value === 'recordings') void loadRecordings()
  else if (activeTab.value === 'ai') void loadAiEvents()
  else void loadPtzCommands()
}

onMounted(() => void load())
onUnmounted(() => {
  for (const camera of cameras.value) destroyEngine(camera.id)
  destroyEngine('recording')
  videoEls.clear()
  screenEls.clear()
  engines.clear()
})
</script>

<style scoped>
.video-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.video-title { font-size: 18px; font-weight: 600; }

.camera-card {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
}

.camera-screen {
  height: 200px;
  background: #0f172a;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
}

.camera-screen:fullscreen { height: 100%; border-radius: 0; }
.recording-screen { height: 420px; }

.camera-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: #64748b;
  font-size: 13px;
}

.camera-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.camera-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0 8px;
}

.camera-url {
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.camera-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.ptz-panel { display: flex; gap: 24px; align-items: flex-start; }
.ptz-pad { display: grid; grid-template-columns: repeat(3, 86px); gap: 8px; }
.ptz-pad .el-button { margin: 0; width: 86px; }
.ptz-side { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.ptz-zoom { display: flex; gap: 8px; }
.ptz-speed { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #475569; }
.ptz-note { font-size: 12px; color: #94a3b8; line-height: 1.6; margin: 0; }
.recording-meta { font-size: 13px; color: #475569; margin-bottom: 10px; }
.pager { margin-top: 16px; justify-content: flex-end; }
.muted { color: #94a3b8; }
.camera-video { opacity: 0; }.camera-video.visible { opacity: 1; }.video-hint { color: #94a3b8; font-size: 12px; }.flex-spacer { flex: 1; }
</style>