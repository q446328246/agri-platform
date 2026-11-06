<template>
  <div class="page-container">
    <el-row :gutter="16" class="summary-row">
      <el-col :span="6">
        <div class="summary-card"><span>苗情覆盖度</span><strong>{{ seedlingCoverage }}</strong><small>{{ seedlingCaption }}</small></div>
      </el-col>
      <el-col :span="6">
        <div class="summary-card summary-card--pest"><span>虫情待处置</span><strong>{{ pendingPests.length }}</strong><small>条识别记录</small></div>
      </el-col>
      <el-col :span="6">
        <div class="summary-card summary-card--alert"><span>灾情告警</span><strong>{{ alerts.length }}</strong><small>条待处理越限</small></div>
      </el-col>
      <el-col :span="6">
        <div class="summary-card"><span>阈值规则</span><strong>{{ rules.length }}</strong><small>{{ enabledRuleCount }} 条启用</small></div>
      </el-col>
    </el-row>

    <div class="card-container mt-16">
      <div class="agro-filter">
        <el-form :inline="true" :model="query" @submit.prevent="applyFilter">
          <el-form-item label="地块编码"><el-input v-model="query.plotCode" placeholder="苗情/灾情按地块" clearable style="width: 180px" /></el-form-item>
          <el-form-item label="监测指标">
            <el-select v-model="query.metric" placeholder="全部" clearable style="width: 150px">
              <el-option v-for="item in metricOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="告警级别">
            <el-select v-model="query.level" placeholder="全部" clearable style="width: 120px">
              <el-option label="提示" value="INFO" />
              <el-option label="预警" value="WARNING" />
              <el-option label="严重" value="CRITICAL" />
            </el-select>
          </el-form-item>
          <el-form-item label="虫害类型"><el-input v-model="query.pestType" placeholder="如：稻飞虱" clearable style="width: 140px" /></el-form-item>
          <el-form-item>
            <el-button type="primary" @click="applyFilter">查询</el-button>
            <el-button @click="resetFilter">重置</el-button>
          </el-form-item>
        </el-form>
      </div>
      <el-tabs v-model="activeTab">
        <el-tab-pane label="苗情" name="seedling">
          <el-table v-loading="loading" :data="seedlingRows" border stripe>
            <el-table-column prop="label" label="监测指标" width="180" />
            <el-table-column prop="value" label="最新读数" width="150" />
            <el-table-column prop="unit" label="单位" width="90" />
            <el-table-column prop="plotCode" label="地块编码" min-width="200" />
            <el-table-column label="采集时间" width="180"><template #default="{ row }">{{ formatTime(row.recordedAt) }}</template></el-table-column>
          </el-table>
          <el-empty v-if="!loading && seedlingRows.length === 0" description="暂无苗情读数，等待遥感或田间设备上报" />
        </el-tab-pane>

        <el-tab-pane label="虫情" name="pest">
          <div class="toolbar">
            <el-checkbox v-model="pestPendingOnly" @change="loadPests">只看未处置</el-checkbox>
            <el-button type="primary" @click="pestDialogVisible = true">登记识别结果</el-button>
          </div>
          <el-table v-loading="loading" :data="pests" border stripe>
            <el-table-column prop="pestType" label="虫害类型" width="140" />
            <el-table-column label="发生等级" width="120">
              <template #default="{ row }">
                <el-tag :type="pestLevelTag(row.level)" size="small">{{ pestLevelText(row.level) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="置信度" width="110"><template #default="{ row }">{{ (row.confidence * 100).toFixed(1) }}%</template></el-table-column>
            <el-table-column prop="plotCode" label="地块编码" min-width="200" />
            <el-table-column prop="deviceId" label="识别来源" width="150" />
            <el-table-column label="识别时间" width="180"><template #default="{ row }">{{ formatTime(row.detectedAt) }}</template></el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.handled ? 'info' : 'warning'" size="small">{{ row.handled ? '已处置' : '待处置' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button v-if="!row.handled" link type="primary" @click="handlePest(row)">标记处置</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="灾情" name="disaster">
          <el-table v-loading="loading" :data="alerts" border stripe>
            <el-table-column label="级别" width="100">
              <template #default="{ row }"><el-tag :type="alertLevelTag(row.level)" size="small">{{ row.level }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="metric" label="指标" width="160" />
            <el-table-column prop="message" label="告警内容" min-width="240" />
            <el-table-column prop="plotCode" label="地块编码" min-width="200" />
            <el-table-column prop="deviceId" label="设备" width="150" />
            <el-table-column label="发生时间" width="180"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }"><el-button link type="primary" @click="handleAlert(row)">标记处理</el-button></template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!loading && alerts.length === 0" description="暂无待处理灾情告警" />
        </el-tab-pane>

        <el-tab-pane label="阈值规则" name="rules">
          <el-form :inline="true" :model="ruleForm" class="rule-form">
            <el-form-item label="指标">
              <el-select v-model="ruleForm.metric" style="width: 160px">
                <el-option v-for="item in metricOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="方向">
              <el-select v-model="ruleForm.direction" style="width: 110px">
                <el-option label="高于上限" value="above" /><el-option label="低于下限" value="below" />
              </el-select>
            </el-form-item>
            <el-form-item label="阈值"><el-input-number v-model="ruleForm.threshold" :min="0" :max="1000" :step="1" /></el-form-item>
            <el-form-item label="级别">
              <el-select v-model="ruleForm.level" style="width: 120px">
                <el-option label="提示" value="INFO" /><el-option label="预警" value="WARNING" /><el-option label="严重" value="CRITICAL" />
              </el-select>
            </el-form-item>
            <el-form-item label="告警文案"><el-input v-model="ruleForm.message" style="width: 240px" /></el-form-item>
            <el-form-item><el-button type="primary" @click="saveRule">保存规则</el-button></el-form-item>
          </el-form>
          <el-table v-loading="loading" :data="rules" border stripe>
            <el-table-column label="指标" width="160"><template #default="{ row }">{{ metricLabel(row.metric) }}</template></el-table-column>
            <el-table-column label="判定" width="180"><template #default="{ row }">{{ row.direction === 'above' ? '高于' : '低于' }} {{ row.threshold }}</template></el-table-column>
            <el-table-column prop="level" label="级别" width="110" />
            <el-table-column prop="message" label="告警文案" min-width="240" />
            <el-table-column label="启用" width="90">
              <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(value: boolean) => toggleRule(row, value)" /></template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }"><el-button link type="danger" @click="removeRule(row)">删除</el-button></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="pestDialogVisible" title="登记虫情识别结果" width="520px">
      <el-form :model="pestForm" label-width="96px">
        <el-form-item label="地块编码"><el-input v-model="pestForm.plotCode" placeholder="选填，留空表示未绑定地块" /></el-form-item>
        <el-form-item label="识别来源"><el-input v-model="pestForm.deviceId" placeholder="摄像头或算法节点标识" /></el-form-item>
        <el-form-item label="虫害类型"><el-input v-model="pestForm.pestType" placeholder="如：稻飞虱" /></el-form-item>
        <el-form-item label="发生等级">
          <el-select v-model="pestForm.level" style="width: 100%">
            <el-option label="轻微" :value="1" /><el-option label="中等" :value="2" /><el-option label="严重" :value="3" />
          </el-select>
        </el-form-item>
        <el-form-item label="置信度"><el-input-number v-model="pestForm.confidence" :min="0" :max="1" :step="0.01" /></el-form-item>
        <el-form-item label="影像编号"><el-input v-model="pestForm.imageFileId" placeholder="选填，文件服务返回的影像标识" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pestDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPest">提交并生成告警</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { plotApi, telemetryApi } from '@/api'
import type { PestEvent, TelemetryAlert, TelemetryRule, TelemetryRuleInput } from '@/api'

/**
 * 四情（苗情/虫情/灾情）监控页。
 *
 * 数据全部来自遥测服务：总览一次拉齐读数、待处置告警、虫情记录与阈值规则，
 * 阈值规则在这里维护，田间上报与视频 AI 识别共用同一套判定口径。
 */

const metricOptions = [
  { label: '土壤含水率', value: 'soilMoisture', unit: '%' },
  { label: '空气温度', value: 'airTemperature', unit: '°C' },
  { label: '空气湿度', value: 'airHumidity', unit: '%' },
  { label: '风速', value: 'windSpeed', unit: 'm/s' },
  { label: '降雨量', value: 'rainfall', unit: 'mm' },
  { label: '苗情覆盖度', value: 'canopyCoverage', unit: '%' },
  { label: '虫口密度', value: 'pestCount', unit: '头/百株' },
  { label: '病情指数', value: 'diseaseIndex', unit: '' },
]
const seedlingMetrics = ['canopyCoverage', 'soilMoisture', 'airTemperature', 'airHumidity']
const metricLabel = (metric: string): string => metricOptions.find((item) => item.value === metric)?.label ?? metric

const loading = ref(false)
const activeTab = ref('seedling')
const query = reactive<{ plotCode: string; metric: string; level: string; pestType: string }>({ plotCode: '', metric: '', level: '', pestType: '' })
const latest = ref<Array<{ deviceId: string; plotCode: string; metric: string; value: number; unit: string; recordedAt: string }>>([])
const alerts = ref<TelemetryAlert[]>([])
const pests = ref<PestEvent[]>([])
const rules = ref<TelemetryRule[]>([])
const pestPendingOnly = ref(true)
const pestDialogVisible = ref(false)

const seedlingRows = computed(() => latest.value
  .filter((reading) => seedlingMetrics.includes(reading.metric))
  .map((reading) => ({ ...reading, label: metricLabel(reading.metric) })))
const seedlingCoverage = computed(() => {
  const reading = latest.value.find((item) => item.metric === 'canopyCoverage')
  return reading ? `${reading.value}%` : '—'
})
const seedlingCaption = computed(() => (latest.value.some((item) => item.metric === 'canopyCoverage') ? '遥感反演覆盖度' : '暂无遥感读数'))
const pendingPests = computed(() => pests.value.filter((item) => !item.handled))
const enabledRuleCount = computed(() => rules.value.filter((item) => item.enabled).length)

const ruleForm = reactive<TelemetryRuleInput>({ metric: 'soilMoisture', direction: 'below', threshold: 30, level: 'WARNING', message: '' })
const pestForm = reactive({ plotCode: '', deviceId: 'camera-001', pestType: '', level: 2 as 1 | 2 | 3, confidence: 0.9, imageFileId: '' })

function formatTime(value?: string): string {
  return value ? value.replace('T', ' ').slice(0, 19) : '—'
}

function pestLevelText(level: 1 | 2 | 3): string {
  return level === 3 ? '严重' : level === 2 ? '中等' : '轻微'
}

function pestLevelTag(level: 1 | 2 | 3): 'danger' | 'warning' | 'info' {
  return level === 3 ? 'danger' : level === 2 ? 'warning' : 'info'
}

function alertLevelTag(level: string): 'danger' | 'warning' | 'info' {
  return level === 'CRITICAL' ? 'danger' : level === 'WARNING' ? 'warning' : 'info'
}

async function loadOverview() {
  loading.value = true
  try {
    const overview = await telemetryApi.getOverview({
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.metric ? { metric: query.metric } : {}),
      ...(query.level ? { level: query.level as any } : {}),
      ...(query.pestType ? { pestType: query.pestType } : {})
    })
    latest.value = overview.latest
    alerts.value = overview.alerts
    pests.value = overview.pests
    rules.value = overview.rules
  } catch {
    ElMessage.error('四情数据加载失败')
  } finally {
    loading.value = false
  }
}

function applyFilter() { void loadOverview() }
function resetFilter() { query.plotCode = ''; query.metric = ''; query.level = ''; query.pestType = ''; loadOverview() }

async function loadPests() {
  try {
    pests.value = await telemetryApi.getPests({
      ...(pestPendingOnly.value ? { pendingOnly: true } : {}),
      ...(query.pestType ? { pestType: query.pestType } : {}),
      ...(query.plotCode ? { plotCode: query.plotCode } : {})
    })
  } catch {
    ElMessage.error('虫情记录加载失败')
  }
}

async function handlePest(row: PestEvent) {
  await telemetryApi.handlePest(row.id)
  ElMessage.success('已标记处置')
  await loadPests()
}

async function handleAlert(row: TelemetryAlert) {
  await telemetryApi.handleAlert(row.id)
  ElMessage.success('告警已处理')
  await loadOverview()
}

async function submitPest() {
  if (!pestForm.pestType) {
    ElMessage.warning('请填写虫害类型')
    return
  }
  try {
    await telemetryApi.reportPest({
      plotCode: pestForm.plotCode,
      deviceId: pestForm.deviceId,
      pestType: pestForm.pestType,
      level: pestForm.level,
      confidence: pestForm.confidence,
      ...(pestForm.imageFileId ? { imageFileId: pestForm.imageFileId } : {}),
    })
    ElMessage.success('识别结果已登记并生成告警')
    pestDialogVisible.value = false
    pestForm.pestType = ''
    pestForm.imageFileId = ''
    await loadOverview()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '识别结果登记失败')
  }
}

async function saveRule() {
  if (!ruleForm.message.trim()) {
    ElMessage.warning('请填写告警文案')
    return
  }
  try {
    await telemetryApi.saveRule({ ...ruleForm })
    ElMessage.success('阈值规则已保存')
    await loadOverview()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '规则保存失败')
  }
}

async function toggleRule(row: TelemetryRule, enabled: boolean) {
  await telemetryApi.saveRule({ metric: row.metric, direction: row.direction, threshold: row.threshold, level: row.level, message: row.message, enabled })
  row.enabled = enabled
}

async function removeRule(row: TelemetryRule) {
  try {
    await ElMessageBox.confirm(`确认删除「${metricLabel(row.metric)}」的阈值规则？`, '删除规则', { type: 'warning' })
  } catch {
    return
  }
  await telemetryApi.deleteRule(row.metric)
  ElMessage.success('规则已删除')
  await loadOverview()
}

onMounted(async () => {
  await loadOverview()
  // 地块服务不可用时不影响四情展示，仅用于确认地块编码有效性
  try {
    const plots = await plotApi.getList({ page: 1, pageSize: 1 })
    if (plots.items[0]) pestForm.plotCode = plots.items[0].parcelCode
  } catch {
    // 忽略：地块编码为选填
  }
})
</script>

<style scoped lang="scss">
.summary-row { margin-bottom: 4px; }
.summary-card { display: flex; flex-direction: column; gap: 6px; padding: 16px 18px; background: #fff; border: 1px solid #e4e7ed; border-radius: 6px; }
.summary-card span { color: #606266; font-size: 13px; }
.summary-card strong { color: #303133; font-size: 26px; font-variant-numeric: tabular-nums; }
.summary-card small { color: #909399; font-size: 12px; }
.summary-card--pest strong { color: #e6a23c; }
.summary-card--alert strong { color: #f56c6c; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.agro-filter { margin-bottom: 4px; }
.rule-form { margin-bottom: 8px; }
:deep(.el-tabs__header) { margin-bottom: 16px; }
</style>
