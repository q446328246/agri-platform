<template>
  <div class="page-container">
    <div class="card-container">
      <div class="search-bar">
        <el-form :inline="true" :model="queryForm">
          <el-form-item label="任务名称">
            <el-input v-model="queryForm.keyword" placeholder="请输入任务名称" clearable style="width: 200px" />
          </el-form-item>
          <el-form-item label="任务状态">
            <el-select v-model="queryForm.status" placeholder="请选择" clearable style="width: 150px">
              <el-option label="待执行" value="PENDING" />
              <el-option label="进行中" value="IN_PROGRESS" />
              <el-option label="已完成" value="COMPLETED" />
              <el-option label="已取消" value="CANCELLED" />
            </el-select>
          </el-form-item>
          <el-form-item label="任务类型">
            <el-select v-model="queryForm.taskType" placeholder="请选择" clearable style="width: 130px">
              <el-option
                v-for="item in taskTypeOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="地块编码">
            <el-input v-model="queryForm.parcelCode" placeholder="地块编码" clearable style="width: 160px" />
          </el-form-item>
          <el-form-item label="计划时间">
            <el-date-picker
              v-model="planRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              clearable
              style="width: 240px"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSearch">查询</el-button>
            <el-button @click="handleReset">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="table-toolbar">
        <el-button type="primary" @click="handleCreate">
          <el-icon><Plus /></el-icon>新建任务
        </el-button>
      </div>

      <el-table v-loading="loading" :data="tableData" border stripe>
        <el-table-column prop="taskName" label="任务名称" min-width="180" />
        <el-table-column prop="parcelName" label="所属地块" width="150" />
        <el-table-column prop="taskType" label="任务类型" width="120" align="center">
          <template #default="{ row }">
            <el-tag size="small">{{ getTaskTypeText(row.taskType) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getTaskStatusType(row.status)" size="small">
              {{ getTaskStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="assigneeName" label="负责人" width="120" />
        <el-table-column prop="planStartDate" label="计划开始时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.planStartDate) }}</template>
        </el-table-column>
        <el-table-column prop="planEndDate" label="计划结束时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.planEndDate) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="240" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="showDetail(row)">详情</el-button>
            <el-button v-if="row.status === 'PENDING'" link type="success" size="small" @click="handleStatus(row, 'RUNNING')">开始</el-button>
            <el-button v-if="row.status === 'IN_PROGRESS'" link type="success" size="small" @click="openComplete(row)">完成</el-button>
            <el-button v-if="row.status === 'PENDING' || row.status === 'IN_PROGRESS'" link type="danger" size="small" @click="handleCancel(row)">取消</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="queryForm.page"
          v-model:page-size="queryForm.pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          @current-change="fetchList"
          @size-change="fetchList"
        />
      </div>
    </div>

    <el-dialog v-model="createVisible" title="新建农事任务" width="520px">
      <el-form :model="createForm" label-width="90px">
        <el-form-item label="任务名称" required><el-input v-model="createForm.name" /></el-form-item>
        <el-form-item label="地块编码" required><el-input v-model="createForm.plotCode" /></el-form-item>
        <el-form-item label="任务类型"><el-select v-model="createForm.type" style="width: 100%"><el-option label="翻耕" value="TILLAGE" /><el-option label="播种" value="SEEDING" /><el-option label="灌溉" value="IRRIGATION" /><el-option label="除草" value="WEEDING" /><el-option label="植保" value="SPRAYING" /><el-option label="施肥" value="FERTILIZATION" /></el-select></el-form-item>
        <el-form-item label="计划开始"><el-date-picker v-model="createForm.scheduledAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" style="width: 100%" /></el-form-item>
        <el-form-item label="计划结束"><el-date-picker v-model="createForm.scheduledEndAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" style="width: 100%" /></el-form-item>
        <el-form-item label="负责人"><el-input v-model="createForm.assigneeName" maxlength="100" placeholder="选填" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="createVisible = false">取消</el-button><el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button></template>
    </el-dialog>
    <el-dialog v-model="completeVisible" title="完成农事任务" width="480px">
      <el-form :model="completeForm" label-width="110px">
        <el-form-item label="任务名称"><span>{{ completeTask?.name }}</span></el-form-item>
        <el-form-item label="作业结果" required>
          <el-select v-model="completeForm.outcome" style="width: 100%">
            <el-option label="成功" value="success" />
            <el-option label="部分完成" value="partial" />
            <el-option label="失败" value="failed" />
          </el-select>
        </el-form-item>
        <el-form-item label="实际作业面积" required>
          <el-input-number v-model="completeForm.finishedAreaMu" :min="0" :precision="2" :step="1" style="width: 200px" /><span style="margin-left: 8px">亩</span>
        </el-form-item>
        <el-form-item label="作业说明">
          <el-input v-model="completeForm.notes" type="textarea" :rows="3" maxlength="2000" show-word-limit placeholder="选填，记录作业情况与异常" />
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="completeVisible = false">取消</el-button><el-button type="primary" :loading="completing" @click="submitComplete">确认完成</el-button></template>
    </el-dialog>
    <el-dialog v-model="detailVisible" title="农事任务详情" width="760px">
      <div v-loading="detailLoading">
        <el-descriptions v-if="taskDetail" :column="2" border>
          <el-descriptions-item label="任务名称">{{ taskDetail.name }}</el-descriptions-item>
          <el-descriptions-item label="任务类型">{{ getTaskTypeText(taskDetail.type) }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getTaskStatusType(displayStatus(taskDetail.status))" size="small">
              {{ getTaskStatusText(displayStatus(taskDetail.status)) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="所属地块">{{ taskPlot ? `${taskPlot.parcelName}（${taskDetail.plotCode}）` : taskDetail.plotCode || '-' }}</el-descriptions-item>
          <el-descriptions-item label="地块面积">{{ taskPlot ? `${taskPlot.areaMu.toFixed(2)} 亩` : '-' }}</el-descriptions-item>
          <el-descriptions-item label="计划开始">{{ formatDateTime(taskDetail.scheduledAt) }}</el-descriptions-item>
          <el-descriptions-item label="计划结束">{{ formatDateTime(taskDetail.scheduledEndAt) }}</el-descriptions-item>
          <el-descriptions-item label="负责人">{{ taskDetail.assigneeName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="开始作业">{{ formatDateTime(taskDetail.startedAt) }}</el-descriptions-item>
          <el-descriptions-item label="完成作业">{{ formatDateTime(taskDetail.completedAt) }}</el-descriptions-item>
          <el-descriptions-item label="取消时间">{{ formatDateTime(taskDetail.cancelledAt) }}</el-descriptions-item>
          <el-descriptions-item label="作业结果">{{ taskDetail.result ? `${getOutcomeText(taskDetail.result.outcome)} · 实际 ${taskDetail.result.finishedAreaMu.toFixed(2)} 亩` : '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDateTime(taskDetail.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="任务编号">{{ taskDetail.id }}</el-descriptions-item>
          <el-descriptions-item v-if="taskDetail.result?.notes" label="作业说明" :span="2">{{ taskDetail.result.notes }}</el-descriptions-item>
        </el-descriptions>

        <div class="detail-subtitle">该地块控制指令</div>
        <el-table v-if="taskCommands.length" :data="taskCommands" size="small" border>
          <el-table-column label="类型" width="80">
            <template #default="{ row }">{{ getControlTypeText(row.type) }}</template>
          </el-table-column>
          <el-table-column label="来源" width="80" align="center">
            <template #default="{ row }">
              <el-tag :type="getControlOriginType(row.origin)" size="small" effect="dark">{{ getControlOriginText(row.origin) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="getControlStatusType(row.status)" size="small">{{ getControlStatusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="deviceId" label="执行设备" min-width="150" show-overflow-tooltip />
          <el-table-column prop="reason" label="缘由" min-width="200" show-overflow-tooltip />
          <el-table-column label="下达时间" width="160">
            <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-else :description="taskDetail?.plotCode ? '该地块暂无控制指令' : '任务未绑定地块，无从关联指令'" :image-size="60" />
      </div>
      <template #footer>
        <el-button v-if="taskDetail && taskDetail.plotCode" @click="goCommands">查看全部指令</el-button>
        <el-button type="primary" @click="detailVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FarmTaskQuery, FarmTaskStatus } from '@/types'
import { formatDateTime, getControlOriginText, getControlOriginType, getControlStatusText, getControlStatusType, getControlTypeText, getTaskStatusText, getTaskStatusType } from '@/utils'
import { controlApi, operationApi, plotApi } from '@/api'

const getTaskTypeText = (type: string) => {
  const map: Record<string, string> = {
    'TILLAGE': '翻耕',
    'SEEDING': '播种',
    'IRRIGATION': '灌溉',
    'WEEDING': '除草',
    'SPRAYING': '植保',
    'FERTILIZATION': '施肥'
  }
  return map[type] || type
}

const getOutcomeText = (outcome: string) => {
  const map: Record<string, string> = { success: '成功', partial: '部分完成', failed: '失败' }
  return map[outcome] || outcome
}

const loading = ref(false)
const tableData = ref<any[]>([])
const total = ref(0)
const createVisible = ref(false)
const creating = ref(false)
const createForm = reactive({ name: '', plotCode: '', type: 'IRRIGATION', scheduledAt: '', scheduledEndAt: '', assigneeName: '' })

const queryForm = reactive<FarmTaskQuery>({
  page: 1,
  pageSize: 20,
  keyword: '',
  status: undefined,
  taskType: undefined,
  parcelCode: ''
})

// 计划时间区间（operation-service 按 scheduledAt/createdAt 命中）
const planRange = ref<[string, string] | null>(null)

const taskTypeOptions = [
  { label: '翻耕', value: 'TILLAGE' },
  { label: '播种', value: 'SEEDING' },
  { label: '灌溉', value: 'IRRIGATION' },
  { label: '除草', value: 'WEEDING' },
  { label: '植保', value: 'SPRAYING' },
  { label: '施肥', value: 'FERTILIZATION' }
]

async function fetchList() {
  loading.value = true
  try {
    const result = await operationApi.getTasks({
      page: queryForm.page ?? 1,
      size: queryForm.pageSize ?? 20,
      keyword: queryForm.keyword,
      status: queryForm.status,
      type: queryForm.taskType,
      plotCode: queryForm.parcelCode,
      from: planRange.value?.[0],
      to: planRange.value?.[1]
    })
    tableData.value = result.items.map((task) => ({
      ...task,
      taskName: task.name,
      taskType: task.type,
      parcelName: task.plotCode,
      status: task.status === 'RUNNING' ? 'IN_PROGRESS' : task.status,
      planStartDate: task.scheduledAt,
      planEndDate: task.scheduledEndAt
    }))
    total.value = result.total
  } catch (error) {
    console.error(error)
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  queryForm.page = 1
  fetchList()
}

function handleReset() {
  queryForm.keyword = ''
  queryForm.status = undefined
  queryForm.taskType = undefined
  queryForm.parcelCode = ''
  planRange.value = null
  queryForm.page = 1
  fetchList()
}

function handleCreate() {
  Object.assign(createForm, { name: '', plotCode: '', type: 'IRRIGATION', scheduledAt: '', scheduledEndAt: '', assigneeName: '' })
  createVisible.value = true
}

async function submitCreate() {
  if (!createForm.name.trim() || !createForm.plotCode.trim()) { ElMessage.warning('请填写任务名称和地块编码'); return }
  if (createForm.scheduledEndAt && (!createForm.scheduledAt || createForm.scheduledEndAt <= createForm.scheduledAt)) { ElMessage.warning('计划结束时间必须晚于开始时间'); return }
  creating.value = true
  try { await operationApi.createTask(createForm); ElMessage.success('任务已创建'); createVisible.value = false; await fetchList() } catch (error) { console.error('任务创建失败', error) } finally { creating.value = false }
}

/* ---------------- 任务详情 ---------------- */

const router = useRouter()
const detailVisible = ref(false)
const detailLoading = ref(false)
const taskDetail = ref<any | null>(null)
const taskPlot = ref<{ parcelCode: string; parcelName: string; areaMu: number } | null>(null)
const taskCommands = ref<any[]>([])

/** 服务端用 RUNNING，页面与筛选统一显示「进行中」，与列表同口径 */
function displayStatus(status: string): FarmTaskStatus {
  return (status === 'RUNNING' ? 'IN_PROGRESS' : status) as FarmTaskStatus
}

async function showDetail(row: { id: string }) {
  detailVisible.value = true
  detailLoading.value = true
  taskDetail.value = null
  taskPlot.value = null
  taskCommands.value = []
  try {
    const task = await operationApi.getTask(row.id)
    taskDetail.value = task
    // 地块档案与指令分属地块、控制两个服务，任一侧取不到只让对应区块显示空态，不影响任务本身
    const [plots, commands] = await Promise.all([
      task.plotCode ? plotApi.getBounds().catch(() => []) : Promise.resolve([]),
      task.plotCode ? controlApi.getCommands({ plotCode: task.plotCode, size: 50 }).catch(() => ({ items: [] as any[] })) : Promise.resolve({ items: [] as any[] })
    ])
    taskPlot.value = plots.find((plot) => plot.parcelCode === task.plotCode) ?? null
    taskCommands.value = commands.items
  } catch (error) {
    console.error('任务详情加载失败', error)
  } finally {
    detailLoading.value = false
  }
}

function goCommands() {
  void router.push('/device/commands')
}
async function handleStatus(row: { id: string; status: string; version: number }, status: string) {
  try {
    await operationApi.updateStatus(row.id, status, { version: row.version })
    ElMessage.success('任务状态已更新')
    await fetchList()
  } catch (error) {
    console.error('任务状态更新失败', error)
    // 409 说明任务已被他人更新，刷新列表拿最新状态与 version
    await fetchList()
  }
}

async function handleCancel(row: { id: string; name: string; version: number }) {
  try {
    await ElMessageBox.confirm(`确定取消任务「${row.name}」吗？取消后不可恢复执行`, '取消任务', { type: 'warning' })
  } catch { return }
  try {
    await operationApi.updateStatus(row.id, 'CANCELLED', { version: row.version })
    ElMessage.success('任务已取消')
    await fetchList()
  } catch (error) {
    console.error('任务取消失败', error)
    await fetchList()
  }
}

/* ---------------- 完成任务：必须登记实际作业结果 ---------------- */

const completeVisible = ref(false)
const completing = ref(false)
const completeTask = ref<any | null>(null)
const completeForm = reactive<{ outcome: 'success' | 'partial' | 'failed'; finishedAreaMu: number; notes: string }>({ outcome: 'success', finishedAreaMu: 0, notes: '' })

function openComplete(row: any) {
  completeTask.value = row
  Object.assign(completeForm, { outcome: 'success', finishedAreaMu: 0, notes: '' })
  completeVisible.value = true
}

async function submitComplete() {
  if (!completeTask.value) return
  if (typeof completeForm.finishedAreaMu !== 'number' || !Number.isFinite(completeForm.finishedAreaMu) || completeForm.finishedAreaMu < 0) { ElMessage.warning('请填写非负的实际作业面积'); return }
  completing.value = true
  try {
    await operationApi.updateStatus(completeTask.value.id, 'COMPLETED', {
      version: completeTask.value.version,
      result: { outcome: completeForm.outcome, finishedAreaMu: completeForm.finishedAreaMu, notes: completeForm.notes }
    })
    ElMessage.success('任务已完成，作业结果已登记')
    completeVisible.value = false
    await fetchList()
  } catch (error) {
    console.error('任务完成登记失败', error)
    await fetchList()
  } finally {
    completing.value = false
  }
}

onMounted(() => {
  fetchList()
})
</script>

<style scoped>
.detail-subtitle {
  margin: 16px 0 8px;
  color: #303133;
  font-size: 14px;
  font-weight: 600;
}
</style>
