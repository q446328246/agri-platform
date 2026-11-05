<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="form">
        <el-form-item label="地块编码"><el-input v-model="form.plotCode" clearable /></el-form-item>
        <el-form-item label="事件类型">
          <el-select v-model="form.event" placeholder="全部" clearable style="width: 150px">
            <el-option label="处方生成" value="PRESCRIPTION_ISSUED" />
            <el-option label="农事作业" value="FARM_OPERATION" />
            <el-option label="作业完成" value="OPERATION_COMPLETED" />
          </el-select>
        </el-form-item>
        <el-form-item><el-button type="primary" @click="search">查询</el-button><el-button @click="reset">重置</el-button></el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="records" border stripe>
        <el-table-column prop="traceCode" label="记录编号" min-width="210" />
        <el-table-column prop="plotCode" label="地块编码" min-width="180" />
        <el-table-column label="农事事件" width="130">
          <template #default="{ row }">
            <el-tag :type="getTraceEventType(row.event)" size="small">{{ getTraceEventText(row.event) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="详情" min-width="240" />
        <el-table-column prop="operator" label="操作人" />
        <el-table-column prop="createdAt" label="时间" width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && !records.length" description="暂无农事记录" />
      <div class="pagination-container">
        <el-pagination
          v-model:current-page="page.page"
          v-model:page-size="page.size"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="search"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { traceApi } from '@/api'
import { formatDateTime, getTraceEventText, getTraceEventType } from '@/utils'
const loading = ref(false)
const records = ref<any[]>([])
const total = ref(0)
const form = reactive<{ plotCode: string; event: string }>({ plotCode: '', event: '' })
const page = reactive({ page: 1, size: 20 })
async function load() {
  loading.value = true
  try {
    const result = await traceApi.getRecords({
      ...(form.plotCode ? { plotCode: form.plotCode } : {}),
      ...(form.event ? { event: form.event } : {}),
      page: page.page,
      size: page.size
    })
    records.value = result.items
    total.value = result.total
  } finally { loading.value = false }
}
function search() { page.page = 1; void load() }
function reset() { form.plotCode = ''; form.event = ''; search() }
onMounted(() => void load())
</script>
