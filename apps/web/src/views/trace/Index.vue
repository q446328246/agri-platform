<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="form">
        <el-form-item label="地块编码"><el-input v-model="form.plotCode" /></el-form-item>
        <el-form-item label="事件"><el-input v-model="form.event" /></el-form-item>
        <el-form-item label="详情"><el-input v-model="form.detail" /></el-form-item>
        <el-form-item><el-button type="primary" @click="submit">新增记录</el-button><el-button @click="load">查询</el-button></el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="records" border stripe>
        <el-table-column prop="traceCode" label="追溯码" min-width="210" />
        <el-table-column prop="plotCode" label="地块编码" min-width="180" />
        <el-table-column label="事件" width="130">
          <template #default="{ row }">
            <el-tag :type="getTraceEventType(row.event)" size="small">{{ getTraceEventText(row.event) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="详情" min-width="220" />
        <el-table-column prop="operator" label="操作人" />
        <el-table-column prop="createdAt" label="时间" width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { traceApi } from '@/api'
import { formatDateTime, getTraceEventText, getTraceEventType } from '@/utils'
const loading = ref(false)
const records = ref<any[]>([])
const form = reactive({ plotCode: '', event: 'FARM_OPERATION', detail: '', operator: 'admin' })
async function load() { loading.value = true; try { const result = await traceApi.getRecords(form.plotCode ? { plotCode: form.plotCode } : undefined); records.value = result.items } finally { loading.value = false } }
async function submit() { if (!form.detail) { ElMessage.warning('请输入记录详情'); return } await traceApi.createRecord(form); ElMessage.success('追溯记录已新增'); form.detail = ''; await load() }
onMounted(() => void load())
</script>
