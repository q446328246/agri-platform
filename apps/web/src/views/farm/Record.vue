<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="form">
        <el-form-item label="地块编码"><el-input v-model="form.plotCode" clearable /></el-form-item>
        <el-form-item><el-button type="primary" @click="load">查询</el-button></el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="records" border stripe>
        <el-table-column prop="traceCode" label="记录编号" min-width="210" />
        <el-table-column prop="plotCode" label="地块编码" min-width="180" />
        <el-table-column prop="event" label="农事事件" />
        <el-table-column prop="detail" label="详情" min-width="240" />
        <el-table-column prop="operator" label="操作人" />
        <el-table-column prop="createdAt" label="时间" width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && !records.length" description="暂无农事记录" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { traceApi } from '@/api'
import { formatDateTime } from '@/utils'
const loading = ref(false)
const records = ref<any[]>([])
const form = reactive({ plotCode: '' })
async function load() { loading.value = true; try { records.value = (await traceApi.getRecords(form.plotCode ? { plotCode: form.plotCode } : undefined)).items } finally { loading.value = false } }
onMounted(() => void load())
</script>
