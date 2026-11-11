<template>
  <div class="page-container">
    <div class="summary-grid">
      <div v-for="item in summaryItems" :key="item.label" class="summary-item">
        <span>{{ item.label }}</span><strong>¥ {{ item.value.toFixed(2) }}</strong>
      </div>
    </div>

    <div class="card-container mt-20">
      <div class="report-header">
        <span class="report-title">核算报表</span>
        <span class="report-hint">随上方筛选条件联动，月份按东八区归档</span>
      </div>
      <div class="report-grid">
        <div class="report-cell">
          <div class="report-cell-title">月度投入产出</div>
          <v-chart v-if="report.months.length" class="chart" :option="monthChartOption" autoresize />
          <el-empty v-else description="暂无数据" :image-size="60" />
        </div>
        <div class="report-cell">
          <div class="report-cell-title">类别构成</div>
          <v-chart v-if="report.categories.length" class="chart" :option="categoryChartOption" autoresize />
          <el-empty v-else description="暂无数据" :image-size="60" />
        </div>
        <div class="report-cell">
          <div class="report-cell-title">地块利润排行</div>
          <v-chart v-if="report.plots.length" class="chart" :option="plotChartOption" autoresize />
          <el-empty v-else description="暂无数据" :image-size="60" />
        </div>
      </div>
    </div>

    <div class="card-container mt-20">
      <el-form :inline="true" :model="query" @submit.prevent="search">
        <el-form-item label="地块编码"><el-input v-model="query.plotCode" placeholder="可选" clearable style="width: 170px" /></el-form-item>
        <el-form-item label="类型">
          <el-select v-model="query.kind" placeholder="全部" clearable style="width: 110px">
            <el-option label="投入" value="INPUT" />
            <el-option label="产出" value="OUTPUT" />
          </el-select>
        </el-form-item>
        <el-form-item label="类别"><el-input v-model="query.category" placeholder="如：农资" clearable style="width: 130px" /></el-form-item>
        <el-form-item label="产季"><el-input v-model="query.season" placeholder="如：2026" clearable style="width: 110px" /></el-form-item>
        <el-form-item label="关键词"><el-input v-model="query.keyword" placeholder="备注/类别/地块" clearable style="width: 160px" /></el-form-item>
        <el-form-item label="登记时间">
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
        <el-form-item><el-button type="primary" @click="search">查询</el-button><el-button @click="reset">重置</el-button></el-form-item>
      </el-form>

      <div class="table-toolbar">
        <div>
          <el-button v-if="canWrite" type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>登记收支
          </el-button>
        </div>
        <div>
          <el-tooltip content="刷新">
            <el-button circle :loading="loading" @click="load">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </div>

      <el-table v-loading="loading" :data="pagedEntries" border stripe>
        <el-table-column prop="plotCode" label="地块编码" min-width="180" />
        <el-table-column prop="kind" label="类型" width="90"><template #default="{ row }">{{ row.kind === 'INPUT' ? '投入' : '产出' }}</template></el-table-column>
        <el-table-column prop="category" label="类别" />
        <el-table-column label="金额" min-width="120">
          <template #default="{ row }">{{ row.amount }} {{ row.unit }}</template>
        </el-table-column>
        <el-table-column prop="season" label="产季" width="90" />
        <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip />
        <el-table-column prop="createdAt" label="登记时间" width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      </el-table>
      <div class="pagination-container">
        <el-pagination
          v-model:current-page="page.page"
          v-model:page-size="page.size"
          :total="entries.length"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
        />
      </div>
    </div>

    <el-dialog v-model="createVisible" title="登记投入产出" width="560px" @closed="resetForm">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="88px" @submit.prevent="submit">
        <el-form-item label="地块编码" prop="plotCode">
          <el-input v-model="form.plotCode" placeholder="选填，留空表示不关联地块" clearable />
        </el-form-item>
        <el-form-item label="类型" prop="kind">
          <el-radio-group v-model="form.kind">
            <el-radio value="INPUT">投入</el-radio>
            <el-radio value="OUTPUT">产出</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="类别" prop="category">
          <el-input v-model="form.category" placeholder="如：农资、人工、机械" />
        </el-form-item>
        <el-form-item label="金额" prop="amount">
          <el-input-number v-model="form.amount" :min="0" :precision="2" :step="100" style="width: 180px" />
          <span class="form-hint">单位「{{ form.unit }}」，可在下方修改</span>
        </el-form-item>
        <el-form-item label="单位" prop="unit">
          <el-input v-model="form.unit" style="width: 140px" />
        </el-form-item>
        <el-form-item label="产季" prop="season">
          <el-input v-model="form.season" placeholder="如：2026" style="width: 140px" />
        </el-form-item>
        <el-form-item label="备注" prop="note">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="写明处置依据，便于按关键词复盘" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submit">登记</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components'
import { financeApi } from '@/api'
import type { FinanceQuery, FinanceReport } from '@/api'
import { useUserStore } from '@/stores'
import { formatDateTime } from '@/utils'
use([CanvasRenderer, BarChart, LineChart, PieChart, TooltipComponent, LegendComponent, GridComponent])
const userStore = useUserStore()
const loading = ref(false)
const entries = ref<any[]>([])
const summary = ref({ input: 0, output: 0, profit: 0, currency: 'CNY' })
const report = ref<FinanceReport>({ months: [], categories: [], plots: [] })
const form = reactive({ plotCode: '', season: String(new Date().getFullYear()), kind: 'INPUT' as 'INPUT' | 'OUTPUT', category: '农资', amount: 0, unit: '元', note: '' })
const createVisible = ref(false)
const creating = ref(false)
const formRef = ref<FormInstance>()
const canWrite = computed(() => userStore.hasPermission('finance:write'))
const formRules: FormRules = {
  category: [{ required: true, message: '请填写类别，列表按它归类统计', trigger: 'blur' }],
  amount: [{ required: true, type: 'number', min: 0.01, message: '金额需大于 0', trigger: 'change' }],
  unit: [{ required: true, message: '请填写单位', trigger: 'blur' }],
  season: [{ required: true, message: '请填写产季，如 2026', trigger: 'blur' }]
}
const query = reactive<{ plotCode: string; kind: '' | 'INPUT' | 'OUTPUT'; category: string; season: string; keyword: string; range: [string, string] | null }>({
  plotCode: '', kind: '', category: '', season: '', keyword: '', range: null
})
const page = reactive({ page: 1, size: 20 })
const summaryItems = computed(() => [{ label: '投入合计', value: summary.value.input }, { label: '产出合计', value: summary.value.output }, { label: '利润', value: summary.value.profit }])
// 后端返回全量筛选结果，分页在前端切片
const pagedEntries = computed(() => {
  const start = (page.page - 1) * page.size
  return entries.value.slice(start, start + page.size)
})
function buildQuery(): FinanceQuery {
  return {
    ...(query.plotCode ? { plotCode: query.plotCode } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.season ? { season: query.season } : {}),
    ...(query.keyword ? { keyword: query.keyword } : {}),
    ...(query.range?.[0] ? { from: query.range[0] } : {}),
    ...(query.range?.[1] ? { to: query.range[1] } : {})
  }
}
async function load() {
  loading.value = true
  try {
    const params = buildQuery()
    // 列表、汇总与报表共用同一套筛选条件，卡片与图表随查询条联动
    ;[entries.value, summary.value, report.value] = await Promise.all([financeApi.getEntries(params), financeApi.getSummary(params), financeApi.getReport(params)])
  } finally { loading.value = false }
}
const money = (value: number): string => `¥ ${Number(value).toFixed(2)}`
const monthChartOption = computed(() => ({
  tooltip: { trigger: 'axis', valueFormatter: money },
  legend: { data: ['投入', '产出', '利润'], top: 0 },
  grid: { left: 8, right: 12, bottom: 4, top: 34, containLabel: true },
  xAxis: { type: 'category', data: report.value.months.map((m) => m.month) },
  yAxis: { type: 'value' },
  series: [
    { name: '投入', type: 'bar', data: report.value.months.map((m) => m.input), itemStyle: { color: '#e6a23c' } },
    { name: '产出', type: 'bar', data: report.value.months.map((m) => m.output), itemStyle: { color: '#67c23a' } },
    { name: '利润', type: 'line', data: report.value.months.map((m) => m.profit), itemStyle: { color: '#409eff' } },
  ],
}))
const categoryChartOption = computed(() => ({
  tooltip: { trigger: 'item', valueFormatter: money },
  legend: { type: 'scroll', bottom: 0 },
  series: [{
    type: 'pie', radius: ['38%', '62%'], center: ['50%', '44%'], avoidLabelOverlap: true,
    data: report.value.categories.map((c) => ({ name: `${c.kind === 'INPUT' ? '投入' : '产出'}·${c.category}`, value: c.amount })),
    label: { formatter: '{b}\n{d}%' },
  }],
}))
const plotChartOption = computed(() => ({
  tooltip: { trigger: 'axis', valueFormatter: money },
  grid: { left: 8, right: 20, bottom: 4, top: 18, containLabel: true },
  xAxis: { type: 'value' },
  yAxis: { type: 'category', data: report.value.plots.map((p) => p.plotCode || '未关联地块').reverse() },
  series: [{
    type: 'bar', data: report.value.plots.map((p) => p.profit).reverse(),
    label: { show: true, position: 'right', formatter: (v: any) => Number(v.value).toFixed(0) },
    itemStyle: { color: (v: any) => (Number(v.value) >= 0 ? '#67c23a' : '#f56c6c') },
  }],
}))
function search() { page.page = 1; void load() }
function reset() {
  query.plotCode = ''
  query.kind = ''
  query.category = ''
  query.season = ''
  query.keyword = ''
  query.range = null
  search()
}
function openCreate() {
  form.plotCode = query.plotCode
  form.season = query.season || String(new Date().getFullYear())
  createVisible.value = true
}
function resetForm() {
  formRef.value?.clearValidate()
  form.amount = 0
  form.note = ''
}
async function submit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  creating.value = true
  try {
    await financeApi.createEntry({ ...form, plotCode: form.plotCode.trim() })
    ElMessage.success('登记成功')
    createVisible.value = false
    await load()
  } finally {
    creating.value = false
  }
}
onMounted(() => void load())
</script>

<style scoped>
.summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.summary-item { background: #fff; padding: 20px; border-radius: 8px; display: flex; flex-direction: column; gap: 10px; color: #909399; }
.summary-item strong { color: #303133; font-size: 24px; }
.form-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); }
.report-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
.report-title { font-size: 15px; font-weight: 600; color: #303133; }
.report-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.report-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.report-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.report-cell-title { font-size: 13px; color: #606266; }
/* vue-echarts 根节点没有 intrinsic 高度，不给高度图表会塌成 0 像素 */
.chart { height: 260px; width: 100%; }
@media (max-width: 1200px) { .report-grid { grid-template-columns: 1fr; } }
</style>
