<template>
  <div class="page-container">
    <div class="summary-grid">
      <div v-for="item in summaryItems" :key="item.label" class="summary-item">
        <span>{{ item.label }}</span><strong>¥ {{ item.value.toFixed(2) }}</strong>
      </div>
    </div>
    <div class="card-container mt-20">
      <el-form :inline="true" :model="form">
        <el-form-item label="地块编码"><el-input v-model="form.plotCode" placeholder="可选" /></el-form-item>
        <el-form-item label="类型"><el-select v-model="form.kind"><el-option label="投入" value="INPUT" /><el-option label="产出" value="OUTPUT" /></el-select></el-form-item>
        <el-form-item label="类别"><el-input v-model="form.category" /></el-form-item>
        <el-form-item label="金额"><el-input-number v-model="form.amount" :min="0" /></el-form-item>
        <el-form-item><el-button type="primary" @click="submit">登记</el-button><el-button @click="load">刷新</el-button></el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="entries" border stripe>
        <el-table-column prop="plotCode" label="地块编码" min-width="180" />
        <el-table-column prop="kind" label="类型" width="90"><template #default="{ row }">{{ row.kind === 'INPUT' ? '投入' : '产出' }}</template></el-table-column>
        <el-table-column prop="category" label="类别" />
        <el-table-column prop="amount" label="金额" />
        <el-table-column prop="createdAt" label="登记时间" width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { financeApi } from '@/api'
import { formatDateTime } from '@/utils'
const loading = ref(false)
const entries = ref<any[]>([])
const summary = ref({ input: 0, output: 0, profit: 0, currency: 'CNY' })
const form = reactive({ plotCode: '', season: String(new Date().getFullYear()), kind: 'INPUT' as 'INPUT' | 'OUTPUT', category: '农资', amount: 0, unit: '元', note: '' })
const summaryItems = computed(() => [{ label: '投入合计', value: summary.value.input }, { label: '产出合计', value: summary.value.output }, { label: '利润', value: summary.value.profit }])
async function load() { loading.value = true; try { [entries.value, summary.value] = await Promise.all([financeApi.getEntries(form.plotCode || undefined), financeApi.getSummary(form.plotCode || undefined)]) } finally { loading.value = false } }
async function submit() { if (!form.amount) { ElMessage.warning('请输入金额'); return } await financeApi.createEntry(form); ElMessage.success('登记成功'); form.amount = 0; await load() }
onMounted(() => void load())
</script>

<style scoped>
.summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.summary-item { background: #fff; padding: 20px; border-radius: 8px; display: flex; flex-direction: column; gap: 10px; color: #909399; }
.summary-item strong { color: #303133; font-size: 24px; }
</style>
