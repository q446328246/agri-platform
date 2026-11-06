<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="query" @submit.prevent="reload">
        <el-form-item label="地块编码">
          <el-input v-model="query.plotCode" placeholder="地块编码" clearable style="width: 170px" />
        </el-form-item>
        <el-form-item label="指令来源">
          <el-select v-model="query.origin" placeholder="全部" clearable style="width: 120px">
            <el-option label="自动" value="EVENT" />
            <el-option label="人工" value="MANUAL" />
          </el-select>
        </el-form-item>
        <el-form-item label="指令类型">
          <el-select v-model="query.type" placeholder="全部" clearable style="width: 120px">
            <el-option label="播种" value="SEEDING" />
            <el-option label="灌溉" value="IRRIGATION" />
            <el-option label="除草" value="WEEDING" />
            <el-option label="水肥" value="FERTILIZATION" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部" clearable style="width: 120px">
            <el-option label="已入队" value="QUEUED" />
            <el-option label="已下发" value="SENT" />
            <el-option label="失败" value="FAILED" />
          </el-select>
        </el-form-item>
        <el-form-item label="设备编号">
          <el-input v-model="query.deviceId" placeholder="设备 ID" clearable style="width: 170px" />
        </el-form-item>
        <el-form-item label="下达时间">
          <el-date-picker
            v-model="query.range"
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
          <el-button type="primary" @click="reload">查询</el-button>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>

      <div class="command-hint">
        <span>自动指令由越限或处方事件生成，保留来源事件且重复投递不会重复入队；人工指令需二次确认后下达。</span>
      </div>

      <el-table v-loading="loading" :data="commands" border stripe>
        <el-table-column prop="deviceId" label="设备编号" min-width="160" show-overflow-tooltip />
        <el-table-column prop="plotCode" label="地块编码" min-width="150" />
        <el-table-column label="指令类型" width="100">
          <template #default="{ row }">{{ getControlTypeText(row.type) }}</template>
        </el-table-column>
        <el-table-column label="来源" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="getControlOriginType(row.origin)" size="small" effect="dark">
              {{ getControlOriginText(row.origin) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getControlStatusType(row.status)" size="small">{{ getControlStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="指令缘由" min-width="220" show-overflow-tooltip />
        <el-table-column label="来源事件" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.sourceEventId" class="command-event">{{ row.sourceEventId }}</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column prop="operatorId" label="操作人" width="130" />
        <el-table-column label="下达时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !commands.length" description="暂无控制指令" />

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.size"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="reload"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { controlApi } from '@/api'
import {
  formatDateTime,
  getControlOriginText,
  getControlOriginType,
  getControlStatusText,
  getControlStatusType,
  getControlTypeText
} from '@/utils'

const loading = ref(false)
const commands = ref<any[]>([])
const total = ref(0)
const query = reactive<{
  plotCode: string
  origin: '' | 'EVENT' | 'MANUAL'
  type: string
  status: string
  deviceId: string
  range: [string, string] | null
  page: number
  size: number
}>({
  plotCode: '',
  origin: '',
  type: '',
  status: '',
  deviceId: '',
  range: null,
  page: 1,
  size: 20
})

async function load() {
  loading.value = true
  try {
    const result = await controlApi.getCommands({
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.origin ? { origin: query.origin } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      ...(query.range?.[0] ? { from: query.range[0] } : {}),
      ...(query.range?.[1] ? { to: query.range[1] } : {}),
      page: query.page,
      size: query.size
    })
    commands.value = result.items
    total.value = result.total
  } finally {
    loading.value = false
  }
}

function reload() {
  query.page = 1
  void load()
}

function reset() {
  query.plotCode = ''
  query.origin = ''
  query.type = ''
  query.status = ''
  query.deviceId = ''
  query.range = null
  reload()
}

onMounted(() => void load())
</script>

<style scoped>
.command-hint {
  margin-bottom: 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.command-event {
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 12px;
}
</style>
