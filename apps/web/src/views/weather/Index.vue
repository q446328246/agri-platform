<template>
  <div class="page-container">
    <!-- 数据源与管理员强制同步入口 -->
    <div class="sync-bar">
      <el-space>
        <el-tag size="small" :type="dataSourceTag">数据源：{{ dataSource }}</el-tag>
        <el-text v-if="syncStatus.enabled" size="small" type="info">
          今日调用 {{ syncStatus.todayCalls ?? 0 }}/{{ syncStatus.dailyCallLimit ?? 20 }}
          · 手动强制 {{ syncStatus.forceSyncCount ?? 0 }} 次
          <template v-if="syncStatus.lastForecastSyncAt">· 上次同步 {{ fmt(syncStatus.lastForecastSyncAt) }}</template>
        </el-text>
      </el-space>
      <el-button
        v-if="canSync"
        type="primary"
        size="small"
        :loading="syncing"
        :icon="Refresh"
        @click="handleForceSync"
      >强制同步和风天气</el-button>
    </div>

    <!-- 作业提示 -->
    <el-alert v-if="headline" :title="headline" type="info" show-icon :closable="false" class="mb-16" />

    <!-- 五日预报卡片 -->
    <el-row :gutter="12" class="forecast-row">
      <el-col v-for="day in forecastDays" :key="day.date" :span="4" class="forecast-col">
        <div class="forecast-card">
          <div class="fc-date">{{ day.date.slice(5) }} {{ isToday(day.date) ? '今天' : '' }}</div>
          <div class="fc-weather">{{ day.weather }}</div>
          <div class="fc-temp">{{ day.tempMin }}~{{ day.tempMax }}°C</div>
          <div class="fc-wind">{{ day.windDirection }} {{ day.windLevel }}级</div>
          <div class="fc-rain">降水 {{ day.rainProbability }}%</div>
        </div>
      </el-col>
    </el-row>

    <!-- 逐要素适宜性 -->
    <el-card v-if="judges.length" shadow="never" class="mt-16">
      <template #header>农事作业适宜性</template>
      <el-row :gutter="16">
        <el-col v-for="j in judges" :key="j.operation" :span="4">
          <div :class="['judge-item', j.suitable ? 'judge-ok' : 'judge-bad']">
            <span>{{ j.label }}</span>
            <strong>{{ j.suitable ? '适宜' : '不宜' }}</strong>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <!-- 气象预警 -->
    <el-card shadow="never" class="mt-16">
      <template #header>气象灾害预警 <el-tag size="small" type="warning" style="margin-left:8px">{{ alertTotal }}</el-tag></template>
      <el-table :data="alertList" border stripe v-loading="loading" size="small">
        <el-table-column prop="title" label="预警名称" min-width="180" />
        <el-table-column prop="level" label="级别" width="100">
          <template #default="{ row }">
            <el-tag :type="row.level === 'CRITICAL' ? 'danger' : row.level === 'WARNING' ? 'warning' : 'info'" size="small">{{ row.color }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="详情" min-width="280" show-overflow-tooltip />
        <el-table-column label="发布时间" width="160"><template #default="{ row }">{{ fmt(row.issuedAt) }}</template></el-table-column>
        <el-table-column label="有效期" width="160"><template #default="{ row }">{{ row.expiresAt ? fmt(row.expiresAt) : '长期' }}</template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && alertList.length === 0" description="暂无活跃预警" />
    </el-card>

    <!-- 实时要素 + 逐小时预报 + 历史曲线 -->
    <el-tabs v-model="activeTab" class="mt-16">
      <el-tab-pane label="实时气象站" name="realtime">
        <el-descriptions :column="4" border>
          <el-descriptions-item v-for="el in realtimeElements" :key="el.key" :label="el.label">
            {{ el.value ?? '--' }} {{ el.unit }}
          </el-descriptions-item>
        </el-descriptions>
        <el-text v-if="realtimeSource === 'unavailable'" type="warning" class="mt-8">气象站数据暂不可用（遥测服务不可达）</el-text>
      </el-tab-pane>
      <el-tab-pane label="未来 24 小时" name="hourly">
        <el-table :data="hourlyList" border stripe size="small" max-height="320">
          <el-table-column label="时次" width="140"><template #default="{ row }">{{ fmt(row.hourAt) }}</template></el-table-column>
          <el-table-column prop="weather" label="天气" width="80" />
          <el-table-column prop="temperature" label="温度(°C)" width="90" />
          <el-table-column prop="humidity" label="湿度(%)" width="80" />
          <el-table-column prop="windSpeed" label="风速(m/s)" width="100" />
          <el-table-column prop="rainProbability" label="降水概率(%)" width="110" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="历史曲线" name="history">
        <div class="agro-filter">
          <el-form :inline="true" @submit.prevent="loadHistory">
            <el-form-item label="要素">
              <el-select v-model="historyQuery.metric" style="width: 150px">
                <el-option v-for="m in metricOptions" :key="m.key" :label="m.label" :value="m.key" />
              </el-select>
            </el-form-item>
            <el-form-item label="时间范围">
              <el-date-picker v-model="historyQuery.range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始" end-placeholder="结束" style="width: 240px" />
            </el-form-item>
            <el-form-item><el-button type="primary" @click="loadHistory">查询</el-button></el-form-item>
          </el-form>
        </div>
        <el-table :data="historyPoints" border stripe size="small" max-height="400">
          <el-table-column label="时间" width="180"><template #default="{ row }">{{ fmt(row.recordedAt) }}</template></el-table-column>
          <el-table-column prop="value" :label="`${historyLabel}(${historyUnit})`" />
        </el-table>
        <div v-if="historyStats.count" class="mt-8">
          <el-text>最小 {{ historyStats.min }} / 最大 {{ historyStats.max }} / 均值 {{ historyStats.avg }} / 共 {{ historyStats.count }} 点</el-text>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { weatherApi } from '@/api'
import { useUserStore } from '@/stores'

const userStore = useUserStore()
const canSync = computed(() => userStore.hasPermission('weather:sync'))
const syncing = ref(false)
const dataSource = ref('demo')
const syncStatus = reactive<{ enabled: boolean; todayCalls?: number; dailyCallLimit?: number; forceSyncCount?: number; lastForecastSyncAt?: string }>({ enabled: false })
const dataSourceTag = computed(() => dataSource.value === 'qweather' ? 'success' : dataSource.value === 'sql' ? 'info' : 'warning')

async function refreshSyncStatus() {
  try {
    const data = await weatherApi.getSyncStatus()
    syncStatus.enabled = !!data?.enabled
    syncStatus.todayCalls = data?.todayCalls
    syncStatus.dailyCallLimit = data?.dailyCallLimit
    syncStatus.forceSyncCount = data?.forceSyncCount
    syncStatus.lastForecastSyncAt = data?.lastForecastSyncAt
  } catch { syncStatus.enabled = false }
}

async function handleForceSync() {
  try {
    await ElMessageBox.confirm(
      '强制同步会立即向和风天气 API 发起预报与预警两个请求（不计入每日硬上限），确定继续吗？',
      '管理员强制同步',
      { type: 'warning', confirmButtonText: '立即同步', cancelButtonText: '取消' }
    )
  } catch { return }
  syncing.value = true
  try {
    const result = await weatherApi.syncNow()
    if (result?.forecast && result?.alerts) {
      ElMessage.success('和风天气同步完成，已写入本地数据库')
    } else if (result?.error) {
      ElMessage.warning(`同步部分失败：${result.error}，接口仍返回旧数据`)
    } else {
      ElMessage.info('同步任务已发起，具体结果请查看服务端日志')
    }
    await Promise.all([loadAll(), refreshSyncStatus()])
  } catch (e: any) {
    ElMessage.error(e?.message || '强制同步失败')
  } finally { syncing.value = false }
}

function fmt(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function isToday(date: string): boolean { return date === new Date().toISOString().slice(0, 10) }

const loading = ref(false)
const headline = ref('')
const forecastDays = ref<any[]>([])
const judges = ref<any[]>([])
const alertList = ref<any[]>([])
const alertTotal = ref(0)
const hourlyList = ref<any[]>([])
const realtimeElements = ref<any[]>([])
const realtimeSource = ref('')
const activeTab = ref('realtime')
const metricOptions = ref<any[]>([])

const historyQuery = reactive({ metric: 'airTemperature', range: null as [string, string] | null })
const historyPoints = ref<any[]>([])
const historyLabel = ref('空气温度')
const historyUnit = ref('°C')
const historyStats = reactive({ min: 0, max: 0, avg: 0, count: 0 })

async function loadAll() {
  loading.value = true
  try {
    const [forecast, alerts, metrics] = await Promise.all([
      weatherApi.getForecast({ days: 5, hours: 24 }),
      weatherApi.getAlerts({ page: 1, size: 10 }),
      weatherApi.getMetrics()
    ])
    forecastDays.value = forecast.forecast ?? []
    headline.value = forecast.headline ?? ''
    judges.value = forecast.judges ?? []
    hourlyList.value = forecast.hourly ?? []
    alertList.value = alerts.items ?? []
    alertTotal.value = alerts.total ?? 0
    metricOptions.value = metrics ?? []
    dataSource.value = forecast.dataSource ?? 'demo'

    // 实时要素
    try {
      const rt = await weatherApi.getRealtime()
      realtimeElements.value = rt.elements ?? []
      realtimeSource.value = rt.dataSource ?? 'unavailable'
    } catch { realtimeSource.value = 'unavailable' }
  } finally { loading.value = false }
}

async function loadHistory() {
  loading.value = true
  try {
    const params: any = { metric: historyQuery.metric, size: 200 }
    if (historyQuery.range?.[0]) params.from = historyQuery.range[0]
    if (historyQuery.range?.[1]) params.to = historyQuery.range[1]
    const data = await weatherApi.getHistory(params)
    historyPoints.value = data.points ?? []
    historyLabel.value = data.label ?? ''
    historyUnit.value = data.unit ?? ''
    Object.assign(historyStats, data.stats ?? { min: 0, max: 0, avg: 0, count: 0 })
  } finally { loading.value = false }
}

onMounted(() => { loadAll(); if (canSync.value) refreshSyncStatus() })
</script>

<style scoped>
.page-container { padding: 16px; }
.mb-16 { margin-bottom: 16px; }
.mt-16 { margin-top: 16px; }
.mt-8 { margin-top: 8px; }
.forecast-row { margin-top: 12px; }
.forecast-col { margin-bottom: 8px; }
.forecast-card { background: #f5f7fa; border-radius: 8px; padding: 14px 12px; text-align: center; }
.fc-date { font-size: 13px; color: #909399; }
.fc-weather { font-size: 18px; font-weight: 600; margin: 6px 0; }
.fc-temp { font-size: 14px; color: #303133; }
.fc-wind { font-size: 12px; color: #606266; margin-top: 4px; }
.fc-rain { font-size: 12px; color: #409eff; margin-top: 2px; }
.judge-item { padding: 10px; border-radius: 6px; text-align: center; font-size: 13px; }
.judge-ok { background: #f0f9eb; color: #67c23a; }
.judge-bad { background: #fef0f0; color: #f56c6c; }
.agro-filter { margin-bottom: 12px; }
.sync-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #fafcff; border: 1px solid #ebeef5; border-radius: 6px; margin-bottom: 12px; }
</style>
