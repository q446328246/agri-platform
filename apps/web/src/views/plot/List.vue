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
          <el-button type="danger" :disabled="!selectedCodes.length" :loading="deleting" @click="handleBatchDelete">
            <el-icon><Delete /></el-icon>批量删除
          </el-button>
          <el-button type="warning" :disabled="selectedCodes.length < 2" @click="openMerge">
            <el-icon><CopyDocument /></el-icon>合并地块
          </el-button>
          <el-button :loading="exporting" @click="handleExport">
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

    <el-dialog v-model="mergeVisible" title="合并地块" width="560px">
      <el-alert type="warning" :closable="false" show-icon class="merge-alert">
        <template #title>所选地块必须相邻（边界首尾相接，容差由服务端配置）才能合并：凸包会把不相邻地块之间的空地圈进新台账，服务端会直接拒掉并提示分成几组。合并后面积为新边界现算值。</template>
      </el-alert>
      <div class="merge-sources">
        <div v-for="row in mergeRows" :key="row.parcelCode" class="merge-source">
          <span>{{ row.name }}（{{ row.parcelCode }}）</span>
          <span class="merge-source__area">{{ Number(row.areaMu ?? 0).toFixed(2) }} 亩</span>
        </div>
      </div>
      <el-form label-width="90px">
        <el-form-item label="合并后名称">
          <el-input v-model="mergeForm.name" maxlength="40" :placeholder="mergeRows[0] ? `默认沿用「${mergeRows[0].name}」` : '请输入合并后名称'" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="mergeForm.remark" type="textarea" :rows="2" placeholder="可选，写入合并后地块档案" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button type="warning" :loading="merging" @click="submitMerge">
          确认合并 {{ mergeRows.length }} 块
        </el-button>
      </template>
    </el-dialog>
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
import { exportCsv } from '@/utils/export'

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
const selectedCodes = ref<string[]>([])
const selectedRows = ref<any[]>([])
const exporting = ref(false)
const deleting = ref(false)

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
  if (!selectedCodes.value.length || deleting.value) return
  const parcelCodes = [...selectedCodes.value]
  let confirmed = false
  deleting.value = true
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${parcelCodes.length} 个地块吗？此操作不可恢复`, '警告', {
      type: 'warning'
    })
    confirmed = true
    const { succeededCodes, failedCodes } = await plotApi.batchDelete(parcelCodes)
    if (failedCodes.length) {
      const message = `成功删除 ${succeededCodes.length} 个地块，失败 ${failedCodes.length} 个（${failedCodes.join('、')}），请重试失败地块`
      if (succeededCodes.length) ElMessage.warning(message)
      else ElMessage.error(message)
    } else {
      ElMessage.success(`批量删除成功，共 ${succeededCodes.length} 个地块`)
    }
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error('批量删除失败', error)
      ElMessage.error('批量删除失败，部分地块可能已删除，请刷新列表确认')
    }
  } finally {
    if (confirmed) {
      selectedCodes.value = []
      selectedRows.value = []
      await fetchList()
    }
    deleting.value = false
  }
}

function handleSelectionChange(selection: any[]) {
  selectedRows.value = selection
  selectedCodes.value = selection.map(item => item.parcelCode)
}

const mergeVisible = ref(false)
const merging = ref(false)
const mergeRows = ref<any[]>([])
const mergeForm = reactive({ name: '', remark: '' })

function openMerge() {
  if (selectedRows.value.length < 2) {
    ElMessage.warning('请至少勾选两个地块')
    return
  }
  mergeRows.value = [...selectedRows.value]
  mergeForm.name = ''
  mergeForm.remark = ''
  mergeVisible.value = true
}

async function submitMerge() {
  if (merging.value) return
  merging.value = true
  try {
    const codes = mergeRows.value.map((row) => row.parcelCode)
    // 名称/备注留空即不发：合并后地块默认沿用首个源地块的档案，不发才不会被空串清掉
    const result = await plotApi.merge({
      parcelCodes: codes,
      ...(mergeForm.name.trim() ? { parcelName: mergeForm.name.trim() } : {}),
      ...(mergeForm.remark.trim() ? { remark: mergeForm.remark.trim() } : {}),
    })
    ElMessage.success(`已合并为「${result.plot.name}」· ${result.plot.areaMu.toFixed(2)} 亩，源地块已归档`)
    mergeVisible.value = false
    selectedCodes.value = []
    selectedRows.value = []
    await fetchList()
  } catch (error) {
    console.error('合并地块失败', error)
  } finally {
    merging.value = false
  }
}

const exportHeaders = ['地块编码', '地块名称', '所属片区', '地块类型', '状态', '面积(亩)', '当前作物', '负责人', '创建时间']

function toExportRow(plot: any) {
  return [
    plot.parcelCode,
    plot.name,
    plot.zoneCode || '未划入',
    getPlotTypeText(plot.type),
    getPlotStatusText(plot.status),
    Number(plot.areaMu ?? 0).toFixed(2),
    plot.currentCrop || '',
    plot.ownerName || '',
    plot.createdAt ? formatDateTime(plot.createdAt) : ''
  ]
}

/** 列表接口单页上限 200，按当前筛选条件逐页取全量 */
async function fetchAllByFilter() {
  const first = await plotApi.getList({ ...queryForm, page: 1, pageSize: 200 })
  const items = first.items ?? first.list ?? []
  const rows = [...items]
  const pages = Math.ceil((first.total ?? 0) / 200)
  for (let page = 2; page <= pages; page += 1) {
    const res = await plotApi.getList({ ...queryForm, page, pageSize: 200 })
    rows.push(...(res.items ?? res.list ?? []))
  }
  return rows
}

async function handleExport() {
  exporting.value = true
  try {
    const rows = selectedRows.value.length ? selectedRows.value : await fetchAllByFilter()
    if (!rows.length) {
      ElMessage.warning('没有可导出的地块')
      return
    }
    exportCsv(`地块列表_${formatDateTime(new Date(), 'YYYYMMDD_HHmmss')}.csv`, exportHeaders, rows.map(toExportRow))
    ElMessage.success(`已导出 ${rows.length} 条地块`)
  } catch (error) {
    console.error('导出地块列表失败', error)
  } finally {
    exporting.value = false
  }
}

onMounted(() => {
  fetchList()
})
</script>

<style scoped>
.merge-alert { margin-bottom: 12px; }
.merge-sources { max-height: 160px; overflow-y: auto; margin-bottom: 12px; border: 1px solid var(--el-border-color); border-radius: 4px; padding: 4px 10px; }
.merge-source { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 13px; color: var(--el-text-color-regular); }
.merge-source__area { font-variant-numeric: tabular-nums; }
</style>
