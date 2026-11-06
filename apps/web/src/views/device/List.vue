<template>
  <div class="page-container">
    <div class="card-container">
      <div class="search-bar">
        <el-form :inline="true" :model="queryForm" @submit.prevent="handleSearch">
          <el-form-item label="设备名称">
            <el-input v-model="queryForm.keyword" placeholder="设备名称/编号" clearable style="width: 200px" />
          </el-form-item>
          <el-form-item label="设备类型">
            <el-select v-model="queryForm.type" placeholder="请选择" clearable style="width: 160px">
              <el-option
                v-for="item in deviceTypeOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="设备状态">
            <el-select v-model="queryForm.status" placeholder="请选择" clearable style="width: 120px">
              <el-option label="在线" value="ONLINE" />
              <el-option label="离线" value="OFFLINE" />
            </el-select>
          </el-form-item>
          <el-form-item label="所属地块">
            <el-input v-model="queryForm.plotCode" placeholder="地块编码" clearable style="width: 160px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSearch">查询</el-button>
            <el-button @click="handleReset">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="table-toolbar">
        <el-button type="primary"><el-icon><Plus /></el-icon>添加设备</el-button>
      </div>

      <el-table v-loading="loading" :data="tableData" border stripe>
        <el-table-column prop="serialNo" label="设备编号" width="150" />
        <el-table-column prop="name" label="设备名称" min-width="150" />
        <el-table-column prop="plotName" label="所属地块" width="150" />
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getDeviceStatusType(row.status)" size="small">
              {{ getDeviceStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastReportAt" label="最后上报时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.lastReportAt) }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="安装时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="showDetail(row)">详情</el-button>
            <el-button link type="primary" size="small" @click="configure(row)">配置</el-button>
            <el-button link type="primary" size="small" @click="refreshDevice(row)">刷新</el-button>
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
          @size-change="fetchList"
          @current-change="fetchList"
        />
      </div>
    </div>
    <el-dialog v-model="detailVisible" title="设备详情" width="520px">
      <el-descriptions v-if="selectedDevice" :column="1" border>
        <el-descriptions-item label="设备编号">{{ selectedDevice.deviceNo }}</el-descriptions-item>
        <el-descriptions-item label="名称">{{ selectedDevice.name }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ selectedDevice.type }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ getDeviceStatusText(selectedDevice.status) }}</el-descriptions-item>
        <el-descriptions-item label="所属地块">{{ selectedDevice.plotCode || '-' }}</el-descriptions-item>
        <el-descriptions-item label="最后在线">{{ formatDateTime(selectedDevice.lastSeenAt) }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { DeviceQuery } from '@/types'
import { formatDateTime, getDeviceStatusText, getDeviceStatusType } from '@/utils'
import { iotApi } from '@/api'

const loading = ref(false)
const tableData = ref<any[]>([])
const total = ref(0)
const detailVisible = ref(false)
const selectedDevice = ref<any | null>(null)

const queryForm = reactive<DeviceQuery>({
  page: 1,
  pageSize: 20,
  keyword: '',
  status: undefined,
  type: undefined,
  plotCode: ''
})

// 与 iot-service 设备台账的 type 取值保持同源
const deviceTypeOptions = [
  { label: '气象站', value: 'WEATHER_STATION' },
  { label: '墒情传感器', value: 'SOIL_SENSOR' },
  { label: '综合监测站', value: 'INTEGRATED_STATION' },
  { label: '遥感反演节点', value: 'REMOTE_SENSE' },
  { label: '虫情测报灯', value: 'INSECT_LAMP' },
  { label: '水肥阀', value: 'FERTILIZER_VALVE' },
  { label: '灌溉阀门', value: 'IRRIGATION_VALVE' },
  { label: '灌溉泵站', value: 'IRRIGATION_PUMP' },
  { label: '植保无人机', value: 'AGRICULTURAL_DRONE' },
  { label: '无人驾驶拖拉机', value: 'AUTO_TRACTOR' }
]

async function fetchList() {
  loading.value = true
  try {
    const result = await iotApi.getDevices({
      page: queryForm.page,
      size: queryForm.pageSize,
      keyword: queryForm.keyword || undefined,
      type: queryForm.type,
      status: queryForm.status,
      plotCode: queryForm.plotCode || undefined
    })
    tableData.value = result.items
      .map((device) => ({ ...device, serialNo: device.deviceNo, plotName: device.plotCode || '-', lastReportAt: device.lastSeenAt, createdAt: device.lastSeenAt }))
    total.value = result.total
  } catch (error) {
    tableData.value = []
    total.value = 0
    console.error('设备列表加载失败', error)
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
  queryForm.type = undefined
  queryForm.plotCode = ''
  queryForm.page = 1
  fetchList()
}

function showDetail(row: any) { selectedDevice.value = row; detailVisible.value = true }

async function configure(row: any) {
  try { await iotApi.sendCommand(row.id, { type: 'CONFIGURE', parameters: { requestedAt: new Date().toISOString() } }); ElMessage.success('配置指令已排队') } catch (error) { console.error('设备配置失败', error) }
}

async function refreshDevice(row: any) {
  try { const latest = await iotApi.getDevice(row.id); const index = tableData.value.findIndex((item) => item.id === row.id); if (index >= 0) tableData.value[index] = { ...latest, serialNo: latest.deviceNo, plotName: latest.plotCode || '-', lastReportAt: latest.lastSeenAt, createdAt: latest.lastSeenAt }; ElMessage.success('设备状态已刷新') } catch (error) { console.error('设备刷新失败', error) }
}

onMounted(() => {
  fetchList()
})
</script>
