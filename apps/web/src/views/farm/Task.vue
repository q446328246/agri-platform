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
        <el-table-column label="操作" width="200" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="showDetail(row)">详情</el-button>
            <el-button v-if="row.status === 'PENDING'" link type="success" size="small" @click="handleStatus(row, 'RUNNING')">开始</el-button>
            <el-button v-if="row.status === 'IN_PROGRESS'" link type="success" size="small" @click="handleStatus(row, 'COMPLETED')">完成</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="queryForm.page"
          v-model:page-size="queryForm.pageSize"
          :total="total"
          layout="total, prev, pager, next"
          @current-change="fetchList"
          @size-change="fetchList"
        />
      </div>
    </div>

    <el-dialog v-model="createVisible" title="新建农事任务" width="520px">
      <el-form :model="createForm" label-width="90px">
        <el-form-item label="任务名称" required><el-input v-model="createForm.name" /></el-form-item>
        <el-form-item label="地块编码" required><el-input v-model="createForm.plotCode" /></el-form-item>
        <el-form-item label="任务类型"><el-select v-model="createForm.type" style="width: 100%"><el-option label="翻耕" value="TILLAGE" /><el-option label="播种" value="SEEDING" /><el-option label="灌溉" value="IRRIGATION" /><el-option label="除草" value="WEEDING" /><el-option label="植保" value="SPRAYING" /></el-select></el-form-item>
        <el-form-item label="计划时间"><el-date-picker v-model="createForm.scheduledAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" style="width: 100%" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="createVisible = false">取消</el-button><el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { FarmTaskQuery } from '@/types'
import { formatDateTime, getTaskStatusText, getTaskStatusType } from '@/utils'
import { operationApi } from '@/api'

const getTaskTypeText = (type: string) => {
  const map: Record<string, string> = {
    'SOWING': '播种',
    'FERTILIZING': '施肥',
    'IRRIGATION': '灌溉',
    'PEST_CONTROL': '病虫害防治',
    'HARVEST': '收获',
    'OTHER': '其他'
  }
  return map[type] || type
}

const loading = ref(false)
const tableData = ref<any[]>([])
const total = ref(0)
const createVisible = ref(false)
const creating = ref(false)
const createForm = reactive({ name: '', plotCode: '', type: 'IRRIGATION', scheduledAt: '' })

const queryForm = reactive<FarmTaskQuery>({
  page: 1,
  pageSize: 20,
  keyword: '',
  status: undefined
})

async function fetchList() {
  loading.value = true
  try {
    const result = await operationApi.getTasks({ page: queryForm.page ?? 1, size: queryForm.pageSize ?? 20, keyword: queryForm.keyword, status: queryForm.status })
    tableData.value = result.items.map((task) => ({
      ...task,
      taskName: task.name,
      taskType: task.type,
      parcelName: task.plotCode,
      status: task.status === 'RUNNING' ? 'IN_PROGRESS' : task.status,
      planStartDate: task.scheduledAt || task.createdAt,
      planEndDate: task.scheduledAt || task.createdAt
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
  fetchList()
}

function handleCreate() {
  Object.assign(createForm, { name: '', plotCode: '', type: 'IRRIGATION', scheduledAt: '' })
  createVisible.value = true
}

async function submitCreate() {
  if (!createForm.name.trim() || !createForm.plotCode.trim()) { ElMessage.warning('请填写任务名称和地块编码'); return }
  creating.value = true
  try { await operationApi.createTask(createForm); ElMessage.success('任务已创建'); createVisible.value = false; await fetchList() } catch (error) { console.error('任务创建失败', error) } finally { creating.value = false }
}

function showDetail(row: { name: string; plotCode: string; status: string }) { ElMessage.info(`${row.name}：${row.plotCode}，状态 ${getTaskStatusText(row.status as any)}`) }

async function handleStatus(row: { id: string; status: string }, status: string) {
  try {
    await operationApi.updateStatus(row.id, status)
    ElMessage.success('任务状态已更新')
    await fetchList()
  } catch (error) {
    console.error('任务状态更新失败', error)
  }
}

onMounted(() => {
  fetchList()
})
</script>
