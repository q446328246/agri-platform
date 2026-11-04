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
          <el-table-column prop="assigneeName" label="负责人" width="120" />
          <el-table-column prop="startTime" label="开始时间" width="170">
            <template #default="{ row }">
              {{ formatDateTime(row.startTime) }}
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PlotBoundaryMap from '@/components/PlotBoundaryMap.vue'
import { useRoute, useRouter } from 'vue-router'
import { plotApi } from '@/api'
import type { Plot } from '@/types'
import { FarmTaskStatus } from '@/types'
import {
  formatDateTime, formatArea,
  getPlotStatusText, getPlotStatusType, getPlotTypeText,
  getSoilTypeText, getTaskStatusText, getTaskStatusType
} from '@/utils'

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

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const plotData = ref<Plot | null>(null)
const recentTasks = ref<any[]>([])

async function loadDetail() {
  loading.value = true
  try {
    plotData.value = await plotApi.getById(route.params.id as string)
    // 模拟近期农事数据
    recentTasks.value = [
      {
        id: '1',
        plotId: plotData.value.id,
        plotName: plotData.value.name,
        type: 'FERTILIZING',
        name: '春季追肥',
        status: FarmTaskStatus.COMPLETED,
        assigneeName: '张三',
        startTime: '2026-03-15T08:00:00Z',
        seasonId: '',
        operatorId: '',
        endTime: '2026-03-15T12:00:00Z',
        createdAt: '2026-03-10T10:00:00Z',
        updatedAt: '2026-03-15T12:00:00Z'
      }
    ]
  } catch (error) {
    console.error('加载地块详情失败', error)
  } finally {
    loading.value = false
  }
}

function goBack() {
  router.back()
}

function handleEdit() {
  router.push(`/plot/edit/${route.params.id}`)
}

onMounted(() => {
  loadDetail()
})
</script>

<style scoped>
</style>
