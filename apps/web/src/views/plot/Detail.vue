<template>
  <div class="page-container" v-loading="loading">
    <div class="card-container" v-if="plotData">
      <div class="flex-between mb-20">
        <h3>{{ plotData.name }}</h3>
        <div>
          <el-button @click="goBack">
            <el-icon><ArrowLeft /></el-icon>返回
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
    </div>
    <div v-else-if="!loading" class="card-container">
      <el-empty :description="loadError || '地块不存在或已被删除'">
        <el-button @click="goBack">返回</el-button>
        <el-button type="primary" @click="loadDetail">重新加载</el-button>
      </el-empty>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import PlotBoundaryMap from '@/components/PlotBoundaryMap.vue'
import { useRoute, useRouter } from 'vue-router'
import { plotApi, operationApi } from '@/api'
import type { Plot } from '@/types'
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

async function loadDetail() {
  loading.value = true
  loadError.value = ''
  plotData.value = null
  recentTasks.value = []
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
}

function goBack() {
  router.back()
}

function handleEdit() {
  router.push(`/plot/edit/${route.params.id}`)
}

// 同一路由记录换 id 时组件会复用，只靠 onMounted 会留在上一条地块
watch(() => route.params.id, () => void loadDetail(), { immediate: true })
</script>

<style scoped>
</style>
