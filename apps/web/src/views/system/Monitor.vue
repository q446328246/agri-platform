<template>
  <div class="page-container">
    <div class="card-container summary-strip">
      <div class="summary-item">
        <span class="summary-value">{{ statuses.length }}</span>
        <span class="summary-label">监控目标</span>
      </div>
      <div class="summary-item">
        <span class="summary-value up">{{ upCount }}</span>
        <span class="summary-label">正常</span>
      </div>
      <div class="summary-item">
        <span class="summary-value down">{{ downCount }}</span>
        <span class="summary-label">异常</span>
      </div>
      <div class="summary-item">
        <span class="summary-value down">{{ firingTotal }}</span>
        <span class="summary-label">在报告警</span>
      </div>
      <div class="summary-actions">
        <el-button type="primary" :loading="checking" @click="runCheck">立即巡检</el-button>
        <span class="refresh-hint">每 30 秒自动刷新</span>
      </div>
    </div>

    <div class="card-container">
      <el-tabs v-model="tab">
        <el-tab-pane label="巡检状态" name="status">
          <el-table v-loading="statusLoading" :data="statuses" border stripe row-key="target">
            <el-table-column prop="label" label="目标" width="160" show-overflow-tooltip />
            <el-table-column prop="target" label="标识" width="110" show-overflow-tooltip />
            <el-table-column label="类别" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.kind === 'INFRA' ? 'warning' : 'primary'" size="small" effect="plain">{{ row.kind === 'INFRA' ? '基础设施' : '服务' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="响应时长" width="100" align="right">
              <template #default="{ row }">{{ row.latencyMs === undefined ? '—' : `${row.latencyMs} ms` }}</template>
            </el-table-column>
            <el-table-column prop="consecutiveFailures" label="连续失败" width="90" align="center" />
            <el-table-column prop="lastError" label="最近错误" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.lastError || '—' }}</template>
            </el-table-column>
            <el-table-column label="最近巡检" width="170">
              <template #default="{ row }">{{ formatDateTime(row.lastCheckedAt) }}</template>
            </el-table-column>
            <el-table-column label="最近恢复" width="170">
              <template #default="{ row }">{{ formatDateTime(row.lastUpAt) }}</template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无巡检记录，点击右上角「立即巡检」发起一轮" />
            </template>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="告警台账" name="alerts">
          <el-form :inline="true" :model="alertQuery" @submit.prevent="reloadAlerts">
            <el-form-item label="状态">
              <el-select v-model="alertQuery.status" placeholder="全部状态" clearable style="width: 140px">
                <el-option label="在报" value="FIRING" />
                <el-option label="已撤销" value="RESOLVED" />
              </el-select>
            </el-form-item>
            <el-form-item label="目标">
              <el-select v-model="alertQuery.target" placeholder="全部目标" clearable filterable style="width: 200px">
                <el-option v-for="item in statuses" :key="item.target" :label="`${item.label}（${item.target}）`" :value="item.target" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="reloadAlerts">查询</el-button>
              <el-button @click="resetAlerts">重置</el-button>
            </el-form-item>
          </el-form>

          <el-table v-loading="alertLoading" :data="alerts" border stripe row-key="id">
            <el-table-column label="目标" width="160" show-overflow-tooltip>
              <template #default="{ row }">{{ targetLabel(row.target) }}</template>
            </el-table-column>
            <el-table-column label="类型" width="120" align="center">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ kindText(row.kind) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="级别" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.level === 'CRITICAL' ? 'danger' : 'warning'" size="small">{{ row.level === 'CRITICAL' ? '严重' : '警告' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.status === 'FIRING' ? 'danger' : 'success'" size="small">{{ row.status === 'FIRING' ? '在报' : '已撤销' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="message" label="告警内容" min-width="240" show-overflow-tooltip />
            <el-table-column label="触发时间" width="170">
              <template #default="{ row }">{{ formatDateTime(row.firedAt) }}</template>
            </el-table-column>
            <el-table-column label="撤销时间" width="170">
              <template #default="{ row }">{{ row.resolvedAt ? formatDateTime(row.resolvedAt) : '—' }}</template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无告警记录" />
            </template>
          </el-table>

          <div class="pagination-container">
            <el-pagination
              v-model:current-page="alertQuery.page"
              v-model:page-size="alertQuery.size"
              :total="alertTotal"
              :page-sizes="[10, 20, 50]"
              layout="total, sizes, prev, pager, next"
              @current-change="loadAlerts"
              @size-change="reloadAlerts"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="告警规则" name="rules">
          <el-table v-loading="ruleLoading" :data="rules" border stripe row-key="id">
            <el-table-column label="规则" width="160">
              <template #default="{ row }">{{ kindText(row.kind) }}</template>
            </el-table-column>
            <el-table-column label="响应阈值" width="130" align="right">
              <template #default="{ row }">{{ row.kind === 'SERVICE_SLOW' ? `${row.thresholdMs} ms` : '不适用' }}</template>
            </el-table-column>
            <el-table-column prop="consecutive" label="连续异常轮次" width="120" align="center" />
            <el-table-column label="启用" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="240">
              <template #default="{ row }">{{ ruleHint(row.kind) }}</template>
            </el-table-column>
            <el-table-column label="更新时间" width="170">
              <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openRuleDialog(row)">编辑</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无告警规则" />
            </template>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="ruleDialogVisible" title="编辑告警规则" width="520px">
      <el-form :model="ruleForm" label-width="110px">
        <el-form-item label="规则类型">
          <el-input :model-value="kindText(ruleForm.kind)" disabled />
        </el-form-item>
        <el-form-item v-if="ruleForm.kind === 'SERVICE_SLOW'" label="响应阈值">
          <el-input-number v-model="ruleForm.thresholdMs" :min="0" :step="100" />
          <span class="form-hint">毫秒，响应超过该值记一轮过慢</span>
        </el-form-item>
        <el-form-item label="连续异常轮次">
          <el-input-number v-model="ruleForm.consecutive" :min="1" :step="1" />
          <span class="form-hint">连续达到该轮次才触发告警</span>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="ruleForm.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { platformApi } from '@/api'
import { formatDateTime } from '@/utils'
import type { MonitorAlert, MonitorAlertKind, MonitorRule, MonitorServiceStatus } from '@/types'

const tab = ref<'status' | 'alerts' | 'rules'>('status')
const checking = ref(false)
const submitting = ref(false)

const statusLoading = ref(false)
const statuses = ref<MonitorServiceStatus[]>([])
const upCount = computed(() => statuses.value.filter((item) => item.status === 'UP').length)
const downCount = computed(() => statuses.value.filter((item) => item.status === 'DOWN').length)

const alertLoading = ref(false)
const alerts = ref<MonitorAlert[]>([])
const alertTotal = ref(0)
const firingTotal = ref(0)
const alertQuery = reactive({ page: 1, size: 20, status: '' as 'FIRING' | 'RESOLVED' | '', target: '' })

const ruleLoading = ref(false)
const rules = ref<MonitorRule[]>([])
const ruleDialogVisible = ref(false)
const ruleEditingId = ref('')
const ruleForm = reactive({ kind: 'SERVICE_DOWN' as MonitorAlertKind, thresholdMs: 0, consecutive: 1, enabled: true })

const KIND_LABELS: Record<MonitorAlertKind, string> = {
  SERVICE_DOWN: '服务不可用',
  SERVICE_SLOW: '服务响应过慢',
  INFRA_DOWN: '基础设施不可用',
}

function kindText(kind: MonitorAlertKind): string {
  return KIND_LABELS[kind] ?? kind
}

function ruleHint(kind: MonitorAlertKind): string {
  if (kind === 'SERVICE_SLOW') return '服务响应时长连续超过阈值时触发警告，回落后自动撤销'
  if (kind === 'INFRA_DOWN') return '数据库/对象存储连续探测失败时触发严重告警，恢复后自动撤销'
  return '微服务健康检查连续失败时触发严重告警，恢复后自动撤销'
}

function statusText(status: MonitorServiceStatus['status']): string {
  return status === 'UP' ? '正常' : status === 'DOWN' ? '异常' : '未知'
}

function statusTag(status: MonitorServiceStatus['status']): 'success' | 'danger' | 'info' {
  return status === 'UP' ? 'success' : status === 'DOWN' ? 'danger' : 'info'
}

function targetLabel(target: string): string {
  const item = statuses.value.find((row) => row.target === target)
  return item ? `${item.label}（${target}）` : target
}

async function loadStatus(): Promise<void> {
  statusLoading.value = true
  try {
    statuses.value = await platformApi.getMonitorStatus()
  } finally {
    statusLoading.value = false
  }
}

async function loadAlerts(): Promise<void> {
  alertLoading.value = true
  try {
    const result = await platformApi.getMonitorAlerts({
      page: alertQuery.page,
      size: alertQuery.size,
      ...(alertQuery.status ? { status: alertQuery.status } : {}),
      ...(alertQuery.target ? { target: alertQuery.target } : {}),
    })
    alerts.value = result.items ?? []
    alertTotal.value = result.total ?? 0
  } finally {
    alertLoading.value = false
  }
}

async function loadFiringTotal(): Promise<void> {
  const result = await platformApi.getMonitorAlerts({ page: 1, size: 1, status: 'FIRING' })
  firingTotal.value = result.total ?? 0
}

function reloadAlerts(): void {
  alertQuery.page = 1
  void loadAlerts()
}

function resetAlerts(): void {
  alertQuery.status = ''
  alertQuery.target = ''
  reloadAlerts()
}

async function loadRules(): Promise<void> {
  ruleLoading.value = true
  try {
    rules.value = await platformApi.getMonitorRules()
  } finally {
    ruleLoading.value = false
  }
}

async function runCheck(): Promise<void> {
  checking.value = true
  try {
    statuses.value = await platformApi.runMonitorCheck()
    await Promise.all([loadAlerts(), loadFiringTotal()])
    ElMessage.success('巡检完成')
  } finally {
    checking.value = false
  }
}

function openRuleDialog(row: MonitorRule): void {
  ruleEditingId.value = row.id
  ruleForm.kind = row.kind
  ruleForm.thresholdMs = row.thresholdMs
  ruleForm.consecutive = row.consecutive
  ruleForm.enabled = row.enabled
  ruleDialogVisible.value = true
}

async function submitRule(): Promise<void> {
  submitting.value = true
  try {
    await platformApi.updateMonitorRule(ruleEditingId.value, {
      thresholdMs: ruleForm.thresholdMs,
      consecutive: ruleForm.consecutive,
      enabled: ruleForm.enabled,
    })
    ElMessage.success('规则已更新')
    ruleDialogVisible.value = false
    await loadRules()
  } finally {
    submitting.value = false
  }
}

async function refresh(): Promise<void> {
  await Promise.all([loadStatus(), loadAlerts(), loadFiringTotal()])
}

let timer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await Promise.all([refresh(), loadRules()])
  timer = setInterval(() => void refresh(), 30_000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.summary-strip {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 16px 24px;
  margin-bottom: 16px;
}

.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.summary-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
}

.summary-value.up {
  color: var(--el-color-success);
}

.summary-value.down {
  color: var(--el-color-danger);
}

.summary-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.summary-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.refresh-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.form-hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>