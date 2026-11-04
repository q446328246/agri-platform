<template>
  <div class="page-container">
    <div class="video-toolbar">
      <span class="video-title">视频监控</span>
      <el-tag v-if="total" type="info" size="small">{{ cameras.length }} / {{ total }} 台</el-tag>
      <span v-if="playableCount === 0 && cameras.length" class="video-hint">当前无在线摄像机</span>
      <div class="flex-spacer" />
      <el-tooltip content="刷新"><el-button circle size="small" @click="load"><el-icon><Refresh /></el-icon></el-button></el-tooltip>
    </div>

    <el-skeleton v-if="loading && !cameras.length" :rows="4" animated />

    <el-empty v-else-if="!cameras.length" description="暂无摄像机" />

    <el-row v-else :gutter="20">
      <el-col v-for="camera in cameras" :key="camera.id" :span="8" class="mb-20">
        <div class="camera-card">
          <div class="camera-screen">
            <video
              v-if="playable(camera)"
              :ref="(el) => setVideoRef(camera.id, el)"
              class="camera-video"
              :class="{ visible: playState[camera.id] === 'playing' }"
              controls
              muted
              playsinline
              preload="auto"
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
            <el-button size="small" :disabled="!playable(camera)" @click="sendPtz(camera.id, 'LEFT')">左转</el-button>
            <el-button size="small" :disabled="!playable(camera)" @click="sendPtz(camera.id, 'RIGHT')">右转</el-button>
            <el-button size="small" :disabled="!playable(camera)" @click="sendPtz(camera.id, 'ZOOM_IN')">放大</el-button>
            <el-button size="small" :disabled="!playable(camera)" @click="sendPtz(camera.id, 'ZOOM_OUT')">缩小</el-button>
            <el-button size="small" :disabled="!playable(camera)" @click="retry(camera)">
              <el-icon><RefreshRight /></el-icon>刷新播放
            </el-button>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { videoApi } from '@/api'
import type { Camera } from '@/types'

/** 播放状态：加载中、播放中、加载失败、未开始 */
type PlayState = 'loading' | 'playing' | 'error' | 'idle'

const loading = ref(false)
const cameras = ref<Camera[]>([])
const total = ref(0)
const playableCount = computed(() => cameras.value.filter((camera) => playable(camera)).length)
const playState = reactive<Record<string, PlayState>>({})
const videoEls = new Map<string, HTMLVideoElement>()
const engines = new Map<string, () => void>()

function setVideoRef(cameraId: string, el: unknown) {
  if (el instanceof HTMLVideoElement) videoEls.set(cameraId, el)
  else videoEls.delete(cameraId)
}


/** 摄像机是否应展示播放器：必须有流地址且在线 */
const playable = (camera: Camera) => Boolean(camera.streamUrl) && camera.status === 'ONLINE'

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
async function startPlayback(camera: Camera) {
  const video = videoEls.get(camera.id)
  if (!video || !camera.streamUrl) return
  destroyEngine(camera.id)
  playState[camera.id] = 'loading'
  if (useNativeSource(video, camera.streamUrl)) {
    void video.play().catch(() => undefined)
    return
  }
  const Hls = await loadHls()
  if (!Hls || !Hls.isSupported?.()) {
    playState[camera.id] = 'error'
    return
  }
  const hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 })
  const release = () => {
    hls.destroy()
    engines.delete(camera.id)
  }
  engines.set(camera.id, release)
  hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined))
  hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
    if (!data?.fatal) return
    release()
    playState[camera.id] = 'error'
  })
  hls.loadSource(camera.streamUrl)
  hls.attachMedia(video)
}

function destroyEngine(cameraId: string) {
  engines.get(cameraId)?.()
  engines.delete(cameraId)
}

function retry(camera: Camera) {
  void startPlayback(camera)
}

async function load() {
  loading.value = true
  try {
    const res = await videoApi.getCameras({ page: 1, size: 100 })
    cameras.value = res.items ?? []
    total.value = res.total
    for (const camera of cameras.value) playState[camera.id] = playable(camera) ? 'loading' : 'idle'
    await nextTick()
    for (const camera of cameras.value) if (playable(camera)) void startPlayback(camera)
  } catch {
    cameras.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function sendPtz(cameraId: string, action: string) {
  try {
    const result = await videoApi.sendPtz(cameraId, { action })
    ElMessage.success(result.status === 'QUEUED' ? '云台指令已排队' : `云台指令状态：${result.status}`)
  } catch {
    ElMessage.error('云台指令下发失败')
  }
}

onMounted(() => void load())
onUnmounted(() => {
  for (const camera of cameras.value) destroyEngine(camera.id)
  videoEls.clear()
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
.camera-video { opacity: 0; }.camera-video.visible { opacity: 1; }.video-hint { color: #94a3b8; font-size: 12px; }.flex-spacer { flex: 1; }
</style>