<template>
  <div class="prediction-page">
    <div class="query-bar">
      <el-select v-model="queryForm.plotCode" placeholder="全部地块" clearable filterable style="width: 220px">
        <el-option v-for="item in plots" :key="item.parcelCode" :label="item.name" :value="item.parcelCode" />
      </el-select>
      <el-select v-model="queryForm.metric" placeholder="全部指标" clearable style="width: 150px">
        <el-option v-for="item in metricOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="queryForm.level" placeholder="全部级别" clearable style="width: 150px">
        <el-option v-for="item in levelOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button type="primary" @click="reload">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
      <el-button type="primary" plain :loading="running" :disabled="!canRun" @click="runNow">执行预测</el-button>
    </div>

    <el-row :gutter="12" class="latest-cards">
      <el-col v-for="card in latestCards" :key="card.metric" :xs="24" :sm="8">
        <el-card shadow="never" class="latest-card">
          <template #header>
            <span class="card-title">{{ card.label }}</span>
            <el-tag v-if="card.record" :type="levelTagType(card.record.level)" size="small">{{ levelLabel(card.record.level) }}</el-tag>
            <el-tag v-else type="info" size="small">暂无</el-tag>
          </template>
          <div v-if="card.record" class="card-value">{{ card.record.predictedValue }}<span class="card-unit">{{ card.record.unit }}</span></div>
          <div v-if="card.record" class="card-meta">预测时点 {{ formatDateTime(card.record.predictedAt) }}（{{ card.record.horizonHours }} 小时后）</div>
          <div v-if="card.record" class="card-basis" :title="card.record.basis">推算依据：{{ card.record.basis }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="plotCode" label="地块" min-width="170" show-overflow-tooltip />
      <el-table-column label="指标" width="110" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ metricLabel(row.metric) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="级别" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="levelTagType(row.level)" size="small">{{ levelLabel(row.level) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="预测值" width="110" align="center">
        <template #default="{ row }">{{ row.predictedValue }} {{ row.unit }}</template>
      </el-table-column>
      <el-table-column label="阈值" width="90" align="center">
        <template #default="{ row }">{{ row.threshold ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="predictedAt" label="预测时点" width="160">
        <template #default="{ row }">{{ formatDateTime(row.predictedAt) }}</template>
      </el-table-column>
      <el-table-column prop="basis" label="推算依据" min-width="240" show-overflow-tooltip />
      <el-table-column prop="createdAt" label="生成时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="queryForm.size"
      :current-page="queryForm.page"
      @current-change="(page: number) => { queryForm.page = page; reload() }"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { decisionApi, plotApi } from '@/api'
import type { PredictionRecord, PredictionLevel, PredictionMetric, Plot } from '@/types'
import { formatDateTime } from '@/utils'
import { useUserStore } from '@/stores'
import { checkPermission } from '@/utils/permission'

// 指标与级别选项与后端白名单同源（后端对非法枚举返回 400）
const metricOptions: Array<{ value: PredictionMetric; label: string }> = [
  { value: 'SOIL_MOISTURE', label: '土壤墒情' },
  { value: 'PEST_RISK', label: '虫害风险' },
  { value: 'YIELD', label: '产量' },
]
const levelOptions: Array<{ value: PredictionLevel; label: string }> = [
  { value: 'NORMAL', label: '正常' },
  { value: 'WARNING', label: '预警' },
  { value: 'CRITICAL', label: '严重' },
  { value: 'INSUFFICIENT_DATA', label: '数据不足' },
]

const metricLabel = (metric: PredictionMetric): string => metricOptions.find((item) => item.value === metric)?.label ?? metric
const levelLabel = (level: PredictionLevel): string => levelOptions.find((item) => item.value === level)?.label ?? level
const levelTagType = (level: PredictionLevel): 'success' | 'warning' | 'danger' | 'info' =>
  level === 'WARNING' ? 'warning' : level === 'CRITICAL' ? 'danger' : level === 'NORMAL' ? 'success' : 'info'

const userStore = useUserStore()
const canRun = computed(() => checkPermission(userStore.permissions, 'decision:write'))

const queryForm = reactive({ plotCode: '', metric: '' as PredictionMetric | '', level: '' as PredictionLevel | '', page: 1, size: 20 })
const plots = ref<Plot[]>([])
const rows = ref<PredictionRecord[]>([])
const total = ref(0)
const loading = ref(false)
const running = ref(false)

const latestCards = computed(() =>
  metricOptions.map((item) => ({
    metric: item.value,
    label: item.label,
    record: latestByMetric[item.value] ?? null,
  })),
)
const latestByMetric = reactive<Record<PredictionMetric, PredictionRecord | null>>({
  SOIL_MOISTURE: null,
  PEST_RISK: null,
  YIELD: null,
})

async function loadPlots(): Promise<void> {
  try {
    const result = await plotApi.getList({ page: 1, pageSize: 200 })
    plots.value = result.items
  } catch {
    plots.value = []
  }
}

async function reload(): Promise<void> {
  loading.value = true
  try {
    const result = await decisionApi.getPredictions({
      plotCode: queryForm.plotCode || undefined,
      metric: queryForm.metric || undefined,
      level: queryForm.level || undefined,
      page: queryForm.page,
      size: queryForm.size,
    })
    rows.value = result.items
    total.value = result.total
  } finally {
    loading.value = false
  }
}

/** 三张概览卡各取当前筛选下的最新一条预测，跟随查询与人工触发刷新 */
async function reloadLatest(): Promise<void> {
  await Promise.all(
    metricOptions.map(async (item) => {
      try {
        const result = await decisionApi.getPredictions({
          plotCode: queryForm.plotCode || undefined,
          metric: item.value,
          page: 1,
          size: 1,
        })
        latestByMetric[item.value] = result.items[0] ?? null
      } catch {
        latestByMetric[item.value] = null
      }
    }),
  )
}

function resetQuery(): void {
  queryForm.plotCode = ''
  queryForm.metric = ''
  queryForm.level = ''
  queryForm.page = 1
  void reload()
}

async function runNow(): Promise<void> {
  running.value = true
  try {
    await decisionApi.runPredictions()
    ElMessage.success('预测已执行，台账已刷新')
    queryForm.page = 1
    await Promise.all([reload(), reloadLatest()])
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '预测执行失败')
  } finally {
    running.value = false
  }
}

onMounted(() => {
  void loadPlots()
  void reload()
  void reloadLatest()
})
</script>

<style scoped>
.prediction-page {
  padding: 12px;
}

.latest-cards {
  margin-bottom: 12px;
}

.latest-card {
  border: 1px solid var(--el-border-color-lighter);
}

.card-title {
  margin-right: 8px;
  font-weight: 600;
}

.card-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.card-unit {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.card-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.card-basis {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
