<template>
  <div class="page-container">
    <el-row :gutter="20">
      <el-col :span="6" v-for="item in monitorData" :key="item.name">
        <div class="monitor-card">
          <div class="monitor-label">{{ item.name }}</div>
          <div class="monitor-value">{{ item.value }} <span class="unit">{{ item.unit }}</span></div>
          <div class="monitor-status" :class="item.status">
            {{ item.status === 'normal' ? '正常' : item.status === 'warning' ? '预警' : '异常' }}
          </div>
        </div>
      </el-col>
    </el-row>

    <div class="card-container mt-20">
      <div class="flex-between mb-16">
        <h4>历史趋势</h4>
        <div class="history-controls">
          <el-select v-model="selectedMetric" style="width: 150px" @change="reloadHistory">
            <el-option v-for="metric in metricOptions" :key="metric.value" :label="metric.label" :value="metric.value" />
          </el-select>
          <el-select v-model="selectedDeviceId" placeholder="选择设备" style="width: 240px" @change="reloadHistory">
            <el-option v-for="device in devices" :key="device.id" :label="device.name || device.id" :value="device.id" />
          </el-select>
        </div>
      </div>
      <el-empty v-if="!historyLoaded" description="暂无历史读数，等待设备上报" />
      <v-chart v-else class="chart" :option="chartOption" autoresize />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components'
import { iotApi, telemetryApi } from '@/api'
import { formatDateTime } from '@/utils'
import type { TelemetryHistoryPoint } from '@/api'

use([CanvasRenderer, LineChart, TooltipComponent, LegendComponent, GridComponent])

const metricOptions = [
  { label: '土壤湿度 (%)', value: 'soilMoisture' },
  { label: '空气温度 (°C)', value: 'airTemperature' },
  { label: '空气湿度 (%)', value: 'airHumidity' },
  { label: '风速 (m/s)', value: 'windSpeed' },
]
const metricLabels = new Map(metricOptions.map((item) => [item.value, item.label]))

const monitorData = ref<Array<{ name: string; value: string | number; unit: string; status: string }>>([
  { name: '空气温度', value: '-', unit: '°C', status: 'normal' },
  { name: '空气湿度', value: '-', unit: '%', status: 'normal' },
  { name: '土壤湿度', value: '-', unit: '%', status: 'normal' },
  { name: '土壤pH值', value: '-', unit: '', status: 'normal' },
  { name: '光照强度', value: '-', unit: 'lux', status: 'normal' },
  { name: 'CO₂浓度', value: '-', unit: 'ppm', status: 'normal' },
  { name: '风速', value: '-', unit: 'm/s', status: 'normal' },
  { name: '降雨量', value: '-', unit: 'mm', status: 'normal' }
])

const devices = ref<Array<{ id: string; name?: string }>>([])
const selectedDeviceId = ref('')
const selectedMetric = ref('soilMoisture')
const historyLoaded = ref(false)
const historyTimes = ref<string[]>([])
const historyValues = ref<number[]>([])
let timer: number | null = null

const chartOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: [metricLabels.get(selectedMetric.value) ?? selectedMetric.value], bottom: 0 },
  grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
  xAxis: { type: 'category', boundaryGap: false, data: historyTimes.value },
  yAxis: { type: 'value' },
  series: [{ name: metricLabels.get(selectedMetric.value) ?? selectedMetric.value, type: 'line', smooth: true, data: historyValues.value }]
}))

async function updateLatest() {
  try {
    const readings = await telemetryApi.getLatest(selectedDeviceId.value || undefined)
    const values = new Map(readings.map((reading: { metric: string; value: number }) => [reading.metric, reading.value]))
    const metricMap = ['airTemperature', 'airHumidity', 'soilMoisture', 'soilPh', 'lightIntensity', 'co2Concentration', 'windSpeed', 'rainfall']
    metricMap.forEach((metric, index) => {
      const value = values.get(metric)
      if (value !== undefined) monitorData.value[index]!.value = value
    })
  } catch {
    // 最新读数失败不影响历史曲线
  }
}

/** 按设备与指标加载历史读数序列（时间升序），供趋势图直接绑定 */
async function loadHistory() {
  try {
    const points = await telemetryApi.getHistorySeries(selectedDeviceId.value, selectedMetric.value)
    // 直接切 ISO 字符串会拿到 UTC 时分秒，与页面其它时间差 8 小时；跨天序列还必须带日期，否则轴标签看着像乱序
    const first = points[0]
    const last = points[points.length - 1]
    const crossDay = !!first && !!last && formatDateTime(first.recordedAt, 'YYYY-MM-DD') !== formatDateTime(last.recordedAt, 'YYYY-MM-DD')
    historyTimes.value = points.map((point: TelemetryHistoryPoint) => formatDateTime(point.recordedAt, crossDay ? 'MM-DD HH:mm' : 'HH:mm:ss'))
    historyValues.value = points.map((point: TelemetryHistoryPoint) => point.value)
    historyLoaded.value = points.length > 0
  } catch {
    historyTimes.value = []
    historyValues.value = []
    historyLoaded.value = false
  }
}

async function reloadHistory() {
  await loadHistory()
  if (!historyLoaded.value) ElMessage.info('所选设备暂无该指标历史读数')
}

async function loadMonitor() {
  try {
    const list = await iotApi.getDevices()
    devices.value = list.items.map((device: { id: string; name?: string | undefined }) => ({ id: device.id, ...(device.name ? { name: device.name } : {}) }))
    if (!selectedDeviceId.value) {
      selectedDeviceId.value = devices.value.find((device) => device.id === 'device-soil-003')?.id ?? devices.value[0]?.id ?? ''
    }
    await loadHistory()
    await updateLatest()
    timer = window.setInterval(() => void updateLatest(), 3000)
  } catch {
    ElMessage.error('实时监控数据加载失败')
  }
}

onMounted(() => {
  void loadMonitor()
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.monitor-card {
  margin-bottom: 20px;
  padding: 16px 18px;
  background: #fff;
  border-left: 3px solid var(--el-color-primary);
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.06);
}
.monitor-label { font-size: 13px; color: var(--el-text-color-secondary); }
.monitor-value {
  margin: 6px 0 8px;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}
.monitor-value .unit { margin-left: 4px; font-size: 13px; font-weight: 400; color: var(--el-text-color-secondary); }
.monitor-status { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
.monitor-status.normal { color: var(--el-color-success); background: var(--el-color-success-light-9); }
.monitor-status.warning { color: var(--el-color-warning); background: var(--el-color-warning-light-9); }
.monitor-status.abnormal { color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.history-controls { display: flex; gap: 12px; }
/* vue-echarts 的根节点没有 intrinsic 高度，不给高度图表会塌成 0 像素 */
.chart { height: 320px; }
</style>