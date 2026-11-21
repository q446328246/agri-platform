<template>
  <div class="tractor-page">
    <div class="query-bar">
      <el-select v-model="queryForm.plotCode" placeholder="全部地块" clearable filterable style="width: 220px">
        <el-option v-for="item in plots" :key="item.parcelCode" :label="item.name" :value="item.parcelCode" />
      </el-select>
      <el-select v-model="queryForm.deviceId" placeholder="全部拖拉机" clearable filterable style="width: 220px">
        <el-option v-for="item in tractors" :key="item.id" :label="`${item.name}（${item.deviceCode}）`" :value="item.id" />
      </el-select>
      <el-select v-model="queryForm.status" placeholder="全部状态" clearable style="width: 140px">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button type="primary" @click="reload">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
      <el-button type="primary" plain :icon="Promotion" :disabled="!canWrite" @click="openDispatch">下发作业</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="plotCode" label="地块" min-width="170" show-overflow-tooltip />
      <el-table-column prop="deviceId" label="拖拉机" width="150" show-overflow-tooltip />
      <el-table-column label="作业" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ operationLabel(row.operationType) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="进度" width="80" align="center">
        <template #default="{ row }">{{ row.currentStage }}/{{ stageCount(row.id) }}</template>
      </el-table-column>
      <el-table-column prop="reason" label="说明" min-width="140" show-overflow-tooltip />
      <el-table-column prop="createdAt" label="创建时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="230" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">分步</el-button>
          <el-button v-if="row.status === 'RUNNING'" link type="warning" size="small" :disabled="!canWrite" @click="stop(row, false)">暂停</el-button>
          <el-button v-if="row.status === 'RUNNING' || row.status === 'PAUSED'" link type="danger" size="small" :disabled="!canWrite" @click="stop(row, true)">急停</el-button>
          <el-button v-if="row.status === 'PAUSED'" link type="primary" size="small" :disabled="!canWrite" @click="resume(row)">恢复</el-button>
        </template>
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

    <h3 class="section-title">安全事件</h3>
    <el-table :data="events" v-loading="eventLoading" border size="small">
      <el-table-column label="类型" width="130" align="center">
        <template #default="{ row }">
          <el-tag :type="row.level === 'CRITICAL' ? 'danger' : 'warning'" size="small" effect="plain">{{ kindLabel(row.kind) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="plotCode" label="地块" min-width="150" show-overflow-tooltip />
      <el-table-column prop="deviceId" label="拖拉机" width="140" show-overflow-tooltip />
      <el-table-column prop="message" label="说明" min-width="240" show-overflow-tooltip />
      <el-table-column label="位置" width="140">
        <template #default="{ row }">{{ row.lng !== undefined && row.lat !== undefined ? `${row.lng}, ${row.lat}` : '—' }}</template>
      </el-table-column>
      <el-table-column prop="createdAt" label="时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dispatchVisible" title="下发拖拉机作业" width="480px">
      <el-form label-width="90px">
        <el-form-item label="地块" required>
          <el-select v-model="dispatchForm.plotCode" placeholder="选择作业地块" filterable style="width: 100%">
            <el-option v-for="item in plots" :key="item.parcelCode" :label="item.name" :value="item.parcelCode" />
          </el-select>
        </el-form-item>
        <el-form-item label="拖拉机" required>
          <el-select v-model="dispatchForm.deviceId" placeholder="选择拖拉机" filterable style="width: 100%">
            <el-option v-for="item in tractors" :key="item.id" :label="`${item.name}（${item.deviceCode}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="作业类型" required>
          <el-select v-model="dispatchForm.operationType" style="width: 100%">
            <el-option v-for="item in operationOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="作业面积" required>
          <el-input-number v-model="dispatchForm.areaMu" :min="0.1" :precision="2" :step="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="作业时长" required>
          <el-input-number v-model="dispatchForm.durationMin" :min="1" :precision="0" :step="1" style="width: 100%" />
          <span class="form-hint">分钟，控制侧按包络执行</span>
        </el-form-item>
        <el-form-item label="作业说明">
          <el-input v-model="dispatchForm.reason" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dispatchVisible = false">取消</el-button>
        <el-button type="primary" :loading="dispatching" @click="submitDispatch">下发</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="detailVisible" title="作业分步指令" width="560px">
      <el-table :data="detailStages" border size="small">
        <el-table-column label="分步" width="100" align="center">
          <template #default="{ row }">{{ stageLabel(row.stage) }}</template>
        </el-table-column>
        <el-table-column prop="commandType" label="指令类型" width="110" />
        <el-table-column prop="commandId" label="指令标识" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.commandId ?? '未下发' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="stageTagType(row.status)" size="small">{{ stageLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="备注" min-width="140" show-overflow-tooltip />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Promotion } from '@element-plus/icons-vue'
import { deviceApi, plotApi, tractorApi } from '@/api'
import type { Device, Plot, TractorJob, TractorJobStage, TractorOperationType, TractorSafetyEvent } from '@/types'
import { formatDateTime } from '@/utils'
import { useUserStore } from '@/stores'
import { checkPermission } from '@/utils/permission'

const operationOptions: Array<{ value: TractorOperationType; label: string }> = [
  { value: 'SEEDING', label: '播种' },
  { value: 'TILLAGE', label: '整地' },
  { value: 'WEEDING', label: '除草' },
]
const statusOptions: Array<{ value: string; label: string }> = [
  { value: 'PLANNED', label: '已排程' },
  { value: 'RUNNING', label: '作业中' },
  { value: 'PAUSED', label: '已暂停' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'FAILED', label: '失败' },
  { value: 'ESTOPPED', label: '已急停' },
]

const operationLabel = (type: TractorOperationType): string => operationOptions.find((item) => item.value === type)?.label ?? type
const statusLabel = (status: string): string => statusOptions.find((item) => item.value === status)?.label ?? status
const stageLabel = (value: string): string => ({ TOOL_SWITCH: '换具', OPERATION: '作业', RETURN_HOME: '返航', PENDING: '待下发', SENT: '已下发', DONE: '已完成', FAILED: '失败', SKIPPED: '跳过' }[value] ?? value)
const kindLabel = (kind: string): string => ({ PRECHECK_FAIL: '预检失败', GEOFENCE_BREACH: '围栏越界', RTK_QUALITY: 'RTK 质量', COMM_LOSS: '通信失联', ESTOP: '急停' }[kind] ?? kind)
const statusTagType = (status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' =>
  status === 'RUNNING' ? 'primary' : status === 'PAUSED' ? 'warning' : status === 'COMPLETED' ? 'success' : status === 'FAILED' || status === 'ESTOPPED' ? 'danger' : 'info'
const stageTagType = (status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' =>
  status === 'SENT' ? 'primary' : status === 'DONE' ? 'success' : status === 'FAILED' ? 'danger' : 'info'

const userStore = useUserStore()
const canWrite = computed(() => checkPermission(userStore.permissions, 'tractor:write'))

const queryForm = reactive({ plotCode: '', deviceId: '', status: '', page: 1, size: 20 })
const plots = ref<Plot[]>([])
const tractors = ref<Device[]>([])
const rows = ref<TractorJob[]>([])
const total = ref(0)
const loading = ref(false)
const events = ref<TractorSafetyEvent[]>([])
const eventLoading = ref(false)
const stageCounts = reactive<Record<string, number>>({})

const dispatchVisible = ref(false)
const dispatching = ref(false)
const dispatchForm = reactive({ plotCode: '', deviceId: '', operationType: 'SEEDING' as TractorOperationType, areaMu: 10, durationMin: 30, reason: '' })

const detailVisible = ref(false)
const detailStages = ref<TractorJobStage[]>([])

const stageCount = (jobId: string): number => stageCounts[jobId] ?? 3

async function loadPlots(): Promise<void> {
  try {
    const result = await plotApi.getList({ page: 1, pageSize: 200 })
    plots.value = result.items
  } catch {
    plots.value = []
  }
}

async function loadTractors(): Promise<void> {
  try {
    const result = await deviceApi.getList({ page: 1, pageSize: 200 })
    tractors.value = result.items.filter((item) => item.type === 'AUTO_TRACTOR')
  } catch {
    tractors.value = []
  }
}

async function reload(): Promise<void> {
  loading.value = true
  try {
    const result = await tractorApi.getJobs({
      ...(queryForm.plotCode ? { plotCode: queryForm.plotCode } : {}),
      ...(queryForm.deviceId ? { deviceId: queryForm.deviceId } : {}),
      ...(queryForm.status ? { status: queryForm.status as TractorJob['status'] } : {}),
      page: queryForm.page,
      size: queryForm.size,
    })
    rows.value = result.items
    total.value = result.total
  } finally {
    loading.value = false
  }
}

async function reloadEvents(): Promise<void> {
  eventLoading.value = true
  try {
    const result = await tractorApi.getSafetyEvents({ page: 1, size: 20 })
    events.value = result.items
  } finally {
    eventLoading.value = false
  }
}

async function refreshStageCounts(): Promise<void> {
  for (const job of rows.value) {
    if (stageCounts[job.id] !== undefined) continue
    try {
      const detail = await tractorApi.getJobDetail(job.id)
      stageCounts[job.id] = detail.stages.length
    } catch {
      stageCounts[job.id] = 3
    }
  }
}

function resetQuery(): void {
  queryForm.plotCode = ''
  queryForm.deviceId = ''
  queryForm.status = ''
  queryForm.page = 1
  void reload()
}

function openDispatch(): void {
  dispatchForm.plotCode = queryForm.plotCode
  dispatchForm.deviceId = queryForm.deviceId
  dispatchVisible.value = true
}

async function submitDispatch(): Promise<void> {
  if (!dispatchForm.plotCode || !dispatchForm.deviceId) {
    ElMessage.warning('请选择地块与拖拉机')
    return
  }
  dispatching.value = true
  try {
    const job = await tractorApi.createJob({
      plotCode: dispatchForm.plotCode,
      deviceId: dispatchForm.deviceId,
      operationType: dispatchForm.operationType,
      parameters: { areaMu: dispatchForm.areaMu, durationMin: dispatchForm.durationMin },
      ...(dispatchForm.reason ? { reason: dispatchForm.reason } : {}),
    })
    ElMessage.success(`作业已排程（${statusLabel(job.status)}），安全预检通过`)
    dispatchVisible.value = false
    queryForm.page = 1
    await Promise.all([reload(), reloadEvents()])
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '作业下发失败')
  } finally {
    dispatching.value = false
  }
}

async function stop(job: TractorJob, emergency: boolean): Promise<void> {
  const action = emergency ? '急停' : '暂停'
  try {
    await ElMessageBox.confirm(`确认对作业 ${job.id} 执行${action}？`, `${action}确认`, { type: emergency ? 'error' : 'warning' })
  } catch {
    return
  }
  try {
    await tractorApi.stopJob(job.id, emergency)
    ElMessage.success(`${action}已执行`)
    await Promise.all([reload(), reloadEvents()])
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : `${action}失败`)
  }
}

async function resume(job: TractorJob): Promise<void> {
  try {
    await tractorApi.resumeJob(job.id)
    ElMessage.success('恢复作业，安全预检已通过')
    await reload()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复失败')
  }
}

async function openDetail(job: TractorJob): Promise<void> {
  try {
    const detail = await tractorApi.getJobDetail(job.id)
    detailStages.value = detail.stages
    stageCounts[job.id] = detail.stages.length
    detailVisible.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '分步详情加载失败')
  }
}

let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void loadPlots()
  void loadTractors()
  void reload()
  void reloadEvents()
  // 在途作业状态会随指令收口推进，周期刷新保证进度可见
  timer = setInterval(() => {
    void refreshStageCounts()
    void reload()
    void reloadEvents()
  }, 5000)
})

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})
</script>

<style scoped>
.tractor-page {
  padding: 12px;
}

.section-title {
  margin: 16px 0 8px;
  font-size: 14px;
}

.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
