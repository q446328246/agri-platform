<template>
  <div class="m-page">
    <div class="m-stats">
      <div class="m-stat">
        <div class="m-stat__value">{{ stats ? stats.totalPlots : '—' }}<small>块</small></div>
        <div class="m-stat__label">地块总数</div>
      </div>
      <div class="m-stat">
        <div class="m-stat__value">{{ stats ? stats.totalAreaMu.toLocaleString() : '—' }}<small>亩</small></div>
        <div class="m-stat__label">种植总面积</div>
      </div>
      <div class="m-stat">
        <div class="m-stat__value">{{ deviceText }}</div>
        <div class="m-stat__label">在线设备 / 总数</div>
      </div>
      <div class="m-stat">
        <div class="m-stat__value">{{ runningTasks ?? '—' }}<small>项</small></div>
        <div class="m-stat__label">进行中任务</div>
      </div>
    </div>

    <div class="m-card">
      <div class="m-card__title">
        待处置告警
        <button class="m-link" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
      <div v-if="loading && !alerts.length" class="m-loading">加载中…</div>
      <div v-else-if="!alerts.length" class="m-empty">暂无待处置告警</div>
      <div v-for="alert in alerts" :key="alert.id" class="m-item">
        <div class="m-item__head">
          <span class="m-tag" :class="levelClass(alert.level)">{{ ALERT_LEVEL_LABELS[alert.level] ?? alert.level }}</span>
          <span class="m-item__title">{{ alert.message }}</span>
        </div>
        <div class="m-item__meta">{{ alert.plotCode || '—' }} · {{ shortTime(alert.createdAt) }}</div>
      </div>
      <p v-if="alertTotal > alerts.length" class="m-muted" style="margin-top: 8px">共 {{ alertTotal }} 条待处置，展示最近 {{ alerts.length }} 条，完整处置请到桌面端</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, shortTime } from '../api'
import { ALERT_LEVEL_LABELS } from '../labels'
import type { DeviceItem, PlotStats, TelemetryAlert } from '../types'

const stats = ref<PlotStats | null>(null)
const devices = ref<DeviceItem[]>([])
const alerts = ref<TelemetryAlert[]>([])
const alertTotal = ref(0)
const runningTasks = ref<number | null>(null)
const loading = ref(false)

const deviceText = computed(() => {
  if (!devices.value.length) return '—'
  const online = devices.value.filter((device) => device.status === 'ONLINE').length
  return `${online}/${devices.value.length}`
})

function levelClass(level: string): string {
  if (level === 'CRITICAL') return 'm-tag--red'
  if (level === 'WARNING') return 'm-tag--amber'
  return 'm-tag--blue'
}

/** 驾驶舱一屏聚合：单项失败不拖垮整页，失败项留空态 */
async function load(): Promise<void> {
  loading.value = true
  try {
    const [plotResult, overviewResult, taskResult, deviceResult] = await Promise.allSettled([
      api.plotStats(),
      api.overview(),
      api.tasks({ status: 'RUNNING', size: 1 }),
      api.devices()
    ])
    if (plotResult.status === 'fulfilled') stats.value = plotResult.value
    if (overviewResult.status === 'fulfilled') {
      const pending = overviewResult.value.alerts.filter((alert) => !alert.handled)
      alertTotal.value = pending.length
      alerts.value = pending.slice(0, 5)
    }
    if (taskResult.status === 'fulfilled') runningTasks.value = taskResult.value.total
    if (deviceResult.status === 'fulfilled') devices.value = deviceResult.value.items
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
</script>