<template>
  <div class="page-container" v-loading="loading">
    <div class="card-container" v-if="plotData">
      <div class="flex-between mb-20">
        <h3>{{ plotData.name }}</h3>
        <div>
          <el-button @click="goBack">
            <el-icon><ArrowLeft /></el-icon>返回
          </el-button>
          <el-button type="warning" @click="handleSplit">
            <el-icon><Scissor /></el-icon>拆分
          </el-button>
          <el-button type="success" plain @click="openTransfer">
            <el-icon><Switch /></el-icon>流转
          </el-button>
          <el-button type="primary" @click="handleEdit">
            <el-icon><Edit /></el-icon>编辑
          </el-button>
        </div>
      </div>

      <el-descriptions :column="3" border>
        <el-descriptions-item label="地块编码">{{ plotData.parcelCode }}</el-descriptions-item>
        <el-descriptions-item label="地块名称">{{ plotData.name }}</el-descriptions-item>
        <el-descriptions-item label="地块类型">
          <el-tag>{{ getPlotTypeText(plotData.type) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="所属区域">{{ plotData.regionName }}</el-descriptions-item>
        <el-descriptions-item label="所属村组">{{ plotData.villageName }}</el-descriptions-item>
        <el-descriptions-item label="地块状态">
          <el-tag :type="getPlotStatusType(plotData.status)">
            {{ getPlotStatusText(plotData.status) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="面积">{{ formatArea(plotData.areaMu) }}</el-descriptions-item>
        <el-descriptions-item label="网格编码">{{ plotData.gridCode }}</el-descriptions-item>
        <el-descriptions-item label="土壤类型">{{ plotData.soilType ? getSoilTypeText(plotData.soilType) : '-' }}</el-descriptions-item>
        <el-descriptions-item label="当前作物">{{ plotData.currentCrop || '-' }}</el-descriptions-item>
        <el-descriptions-item label="负责人">{{ plotData.ownerName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="联系电话">{{ plotData.ownerPhone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间" :span="1">{{ formatDateTime(plotData.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="更新时间" :span="2">{{ formatDateTime(plotData.updatedAt) }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="3">{{ plotData.remark || '-' }}</el-descriptions-item>
      </el-descriptions>

      <div class="mt-20">
        <h4 class="mb-16">地块位置</h4>
        <PlotBoundaryMap :source="plotData" />
      </div>

      <div class="mt-20">
        <h4 class="mb-16">近期农事活动</h4>
        <el-table :data="recentTasks" border>
          <el-table-column prop="type" label="任务类型" width="120">
            <template #default="{ row }">
              {{ getTaskTypeText(row.type) }}
            </template>
          </el-table-column>
          <el-table-column prop="name" label="任务名称" />
          <el-table-column prop="status" label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="getTaskStatusType(row.status)" size="small">
                {{ getTaskStatusText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="plotCode" label="地块编码" width="240" />
          <el-table-column prop="scheduledAt" label="计划时间" width="170">
            <template #default="{ row }">
              {{ formatDateTime(row.scheduledAt || row.createdAt) }}
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!recentTasks.length" description="该地块暂无农事任务" :image-size="80" />
      </div>

      <div class="mt-20">
        <h4 class="mb-16">变更历史</h4>
        <el-timeline v-if="changeLogs.length">
          <el-timeline-item
            v-for="log in changeLogs"
            :key="log.id"
            :timestamp="formatDateTime(log.createdAt)"
            placement="top"
            :type="changeActionType(log.action)"
          >
            <div class="change-node">
              <el-tag :type="changeActionType(log.action)" size="small">{{ changeActionText(log.action) }}</el-tag>
              <span class="change-summary">{{ log.summary }}</span>
              <span class="change-actor">操作人：{{ log.actor }}</span>
            </div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无变更记录（历史自启用留痕起记录）" :image-size="80" />
      </div>
    </div>
    <div v-else-if="!loading" class="card-container">
      <el-empty :description="loadError || '地块不存在或已被删除'">
        <el-button @click="goBack">返回</el-button>
        <el-button type="primary" @click="loadDetail">重新加载</el-button>
      </el-empty>
    </div>

    <el-dialog v-model="transferVisible" title="地块流转（权属变更）" width="520px">
      <p class="transfer-hint">流转只变更负责人与联系电话，地块档案其余字段不动；变更会写入下方变更历史，含原负责人、新负责人与事由。</p>
      <el-form :model="transferForm" label-width="100px">
        <el-form-item label="当前负责人"><span>{{ plotData?.ownerName || '未登记' }}</span></el-form-item>
        <el-form-item label="新负责人" required>
          <el-input v-model="transferForm.ownerName" maxlength="100" placeholder="流转后的负责人姓名" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="transferForm.ownerPhone" maxlength="30" placeholder="选填，留空表示清空原电话" />
        </el-form-item>
        <el-form-item label="流转事由">
          <el-input v-model="transferForm.reason" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="选填，如：承包到期转包、继承、合作社调整" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="transferVisible = false">取消</el-button>
        <el-button type="primary" :loading="transferring" @click="submitTransfer">确认流转</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import PlotBoundaryMap from '@/components/PlotBoundaryMap.vue'
import { useRoute, useRouter } from 'vue-router'
import { plotApi, operationApi } from '@/api'
import type { Plot, PlotChangeAction, PlotChangeLog } from '@/types'
import { parsePlotBoundary, type PlotBoundarySource } from '@/utils/geo'
import {
  formatDateTime, formatArea,
  getPlotStatusText, getPlotStatusType, getPlotTypeText,
  getSoilTypeText, getTaskStatusText, getTaskStatusType
} from '@/utils'

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

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const loadError = ref('')
const plotData = ref<Plot | null>(null)
const recentTasks = ref<any[]>([])
const changeLogs = ref<PlotChangeLog[]>([])

const changeActionText = (action: PlotChangeAction): string =>
  action === 'CREATE' ? '建档' : action === 'UPDATE' ? '修改'
    : action === 'MERGE' ? '合并生成' : action === 'SPLIT' ? '拆分生成' : action === 'TRANSFER' ? '流转' : '删除'
const changeActionType = (action: PlotChangeAction): 'primary' | 'success' | 'warning' | 'danger' =>
  action === 'CREATE' ? 'primary' : action === 'UPDATE' ? 'warning'
    : action === 'MERGE' ? 'success' : action === 'SPLIT' ? 'success' : action === 'TRANSFER' ? 'warning' : 'danger'

async function loadDetail() {
  loading.value = true
  loadError.value = ''
  plotData.value = null
  recentTasks.value = []
  changeLogs.value = []
  try {
    plotData.value = await plotApi.getById(route.params.id as string)
  } catch {
    loadError.value = '地块详情加载失败'
  } finally {
    loading.value = false
  }
  const code = plotData.value?.parcelCode
  if (!code) return
  try {
    // 按地块编码关联农事任务，后端 keyword 同时匹配任务名与地块编码
    const result = await operationApi.getTasks({ page: 1, size: 50, keyword: code })
    recentTasks.value = result.items.map((task) => ({
      ...task,
      status: task.status === 'RUNNING' ? 'IN_PROGRESS' : task.status
    }))
  } catch {
    // 农事任务拉取失败不影响档案本身，表格下方已有空态提示
  }
  try {
    changeLogs.value = await plotApi.getHistory(code)
  } catch {
    // 变更历史拉取失败仅显示空态，不影响档案与任务展示
  }
}

function goBack() {
  router.back()
}

function handleEdit() {
  router.push(`/plot/edit/${route.params.id}`)
}

/** 拆分要逐块画边界，无边界的地块先走编辑页补全，否则拆完面积没有几何依据 */
function handleSplit() {
  if (!plotData.value) return
  if (!parsePlotBoundary(plotData.value as unknown as PlotBoundarySource)) {
    ElMessage.warning('该地块暂无边界几何，请先在编辑页补画边界再拆分')
    return
  }
  router.push(`/plot/split/${plotData.value.parcelCode}`)
}

/* ---------------- 权属流转 ---------------- */

const transferVisible = ref(false)
const transferring = ref(false)
const transferForm = reactive({ ownerName: '', ownerPhone: '', reason: '' })

function openTransfer() {
  if (!plotData.value) return
  transferForm.ownerName = ''
  transferForm.ownerPhone = plotData.value.ownerPhone ?? ''
  transferForm.reason = ''
  transferVisible.value = true
}

async function submitTransfer() {
  if (!plotData.value) return
  const ownerName = transferForm.ownerName.trim()
  if (!ownerName) { ElMessage.warning('请填写流转后的负责人'); return }
  transferring.value = true
  try {
    await plotApi.transfer(plotData.value.parcelCode, {
      ownerName,
      ownerPhone: transferForm.ownerPhone.trim(),
      ...(transferForm.reason.trim() ? { reason: transferForm.reason.trim() } : {})
    })
    ElMessage.success('地块已流转，变更已留痕')
    transferVisible.value = false
    await loadDetail()
  } catch (error) {
    console.error('地块流转失败', error)
  } finally {
    transferring.value = false
  }
}

// 同一路由记录换 id 时组件会复用，只靠 onMounted 会留在上一条地块
watch(() => route.params.id, () => void loadDetail(), { immediate: true })
</script>

<style scoped>
.transfer-hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
</style>
