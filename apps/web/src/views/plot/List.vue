<template>
  <div class="page-container">
    <div class="card-container">
      <div class="search-bar">
        <el-form :inline="true" :model="queryForm" @submit.prevent="handleSearch">
          <el-form-item label="关键词">
            <el-input v-model="queryForm.keyword" placeholder="编码/名称/作物/负责人" clearable style="width: 200px" />
          </el-form-item>
          <el-form-item label="地块类型">
            <el-select v-model="queryForm.type" placeholder="请选择" clearable style="width: 150px">
              <el-option
                v-for="item in plotTypeOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="地块状态">
            <el-select v-model="queryForm.status" placeholder="请选择" clearable style="width: 150px">
              <el-option
                v-for="item in plotStatusOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="土壤类型">
            <el-select v-model="queryForm.soilType" placeholder="请选择" clearable style="width: 130px">
              <el-option
                v-for="item in soilTypeOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="当前作物">
            <el-input v-model="queryForm.currentCrop" placeholder="如：水稻" clearable style="width: 120px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSearch">
              <el-icon><Search /></el-icon>查询
            </el-button>
            <el-button @click="handleReset">
              <el-icon><Refresh /></el-icon>重置
            </el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="table-toolbar">
        <div>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>新增地块
          </el-button>
          <el-button type="danger" :disabled="!selectedIds.length" @click="handleBatchDelete">
            <el-icon><Delete /></el-icon>批量删除
          </el-button>
          <el-button>
            <el-icon><Download /></el-icon>导出
          </el-button>
        </div>
        <div>
          <el-tooltip content="刷新">
            <el-button circle @click="fetchList">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </div>

      <el-table
        v-loading="loading"
        :data="tableData"
        border
        stripe
        style="width: 100%"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="50" align="center" />
        <el-table-column prop="parcelCode" label="地块编码" width="220" />
        <el-table-column prop="name" label="地块名称" min-width="150" />
        <el-table-column prop="zoneCode" label="所属片区" width="110" align="center">
          <template #default="{ row }">
            {{ row.zoneCode || '未划入' }}
          </template>
        </el-table-column>
        <el-table-column prop="type" label="地块类型" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small">{{ getPlotTypeText(row.type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getPlotStatusType(row.status)" size="small">
              {{ getPlotStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="areaMu" label="面积(亩)" width="100" align="right">
          <template #default="{ row }">
            {{ row.areaMu.toFixed(2) }}
          </template>
        </el-table-column>
        <el-table-column prop="currentCrop" label="当前作物" width="120">
          <template #default="{ row }">
            {{ row.currentCrop || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="ownerName" label="负责人" width="100" />
        <el-table-column prop="createdAt" label="创建时间" width="170">
          <template #default="{ row }">
            {{ formatDateTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleDetail(row.parcelCode)">
              详情
            </el-button>
            <el-button link type="primary" size="small" @click="handleEdit(row.parcelCode)">
              编辑
            </el-button>
            <el-popconfirm title="确定删除该地块吗？" @confirm="handleDelete(row.parcelCode)">
              <template #reference>
                <el-button link type="danger" size="small">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="queryForm.page"
          v-model:page-size="queryForm.pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="fetchList"
          @current-change="fetchList"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { plotApi } from '@/api'
import type { PlotQuery, PlotStatus, PlotType } from '@/types'
import { PlotStatus as PS, PlotType as PT, SoilType as ST } from '@/types'
import { formatDateTime } from '@/utils'

// 简单的工具函数
const getPlotTypeText = (type: PlotType) => {
  const map: Record<PlotType, string> = {
    [PT.FIELD]: '大田',
    [PT.GREENHOUSE]: '大棚',
    [PT.ORCHARD]: '果园',
    [PT.AQUACULTURE]: '水产养殖'
  }
  return map[type] || type
}

const getPlotStatusText = (status: PlotStatus) => {
  const map: Record<PlotStatus, string> = {
    [PS.DRAFT]: '草稿',
    [PS.ACTIVE]: '种植中',
    [PS.FALLOW]: '休耕',
    [PS.ARCHIVED]: '已归档'
  }
  return map[status] || status
}

const getPlotStatusType = (status: PlotStatus) => {
  const map: Record<PlotStatus, any> = {
    [PS.DRAFT]: 'info',
    [PS.ACTIVE]: 'success',
    [PS.FALLOW]: 'warning',
    [PS.ARCHIVED]: 'info'
  }
  return map[status] || 'info'
}

const router = useRouter()
const loading = ref(false)
const tableData = ref<any[]>([])
const total = ref(0)
const selectedIds = ref<string[]>([])

const queryForm = reactive<PlotQuery>({
  page: 1,
  pageSize: 20,
  keyword: '',
  type: undefined,
  status: undefined,
  soilType: undefined,
  currentCrop: ''
})

const soilTypeOptions = [
  { label: '壤土', value: ST.LOAM },
  { label: '黏土', value: ST.CLAY },
  { label: '沙土', value: ST.SAND },
  { label: '淤土', value: ST.SILT },
  { label: '泥炭土', value: ST.PEAT }
]

const plotTypeOptions = [
  { label: '大田', value: PT.FIELD },
  { label: '大棚', value: PT.GREENHOUSE },
  { label: '果园', value: PT.ORCHARD },
  { label: '水产养殖', value: PT.AQUACULTURE }
]

const plotStatusOptions = [
  { label: '草稿', value: PS.DRAFT },
  { label: '种植中', value: PS.ACTIVE },
  { label: '休耕', value: PS.FALLOW },
  { label: '已归档', value: PS.ARCHIVED }
]

async function fetchList() {
  loading.value = true
  try {
    const res = await plotApi.getList(queryForm)
    tableData.value = res.items ?? res.list ?? []
    total.value = res.total
  } catch (error) {
    console.error('获取地块列表失败', error)
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
  queryForm.type = undefined
  queryForm.status = undefined
  queryForm.soilType = undefined
  queryForm.currentCrop = ''
  queryForm.page = 1
  fetchList()
}

function handleCreate() {
  router.push('/plot/create')
}

function handleEdit(id: string) {
  router.push(`/plot/edit/${id}`)
}

function handleDetail(id: string) {
  router.push(`/plot/detail/${id}`)
}

async function handleDelete(id: string) {
  try {
    await plotApi.delete(id)
    ElMessage.success('删除成功')
    fetchList()
  } catch (error) {
    console.error('删除失败', error)
  }
}

async function handleBatchDelete() {
  try {
    await ElMessageBox.confirm('确定删除选中的地块吗？此操作不可恢复', '警告', {
      type: 'warning'
    })
    await plotApi.batchDelete(selectedIds.value)
    ElMessage.success('批量删除成功')
    fetchList()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('批量删除失败', error)
    }
  }
}

function handleSelectionChange(selection: any[]) {
  selectedIds.value = selection.map(item => item.id)
}

onMounted(() => {
  fetchList()
})
</script>
