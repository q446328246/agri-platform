<template>
  <div class="page-container">
    <div class="card-container">
      <div class="chain-lookup">
        <div class="chain-lookup-title">全链条质量溯源</div>
        <div class="chain-lookup-hint">输入或扫溯源码查看该批产品从整地到采收的完整生产链条；下游加工、仓储、物流、质检由外部系统提供，暂未接入。</div>
        <div class="chain-lookup-form">
          <el-input v-model="lookupCode" placeholder="溯源码，如 BT-2026-E01" clearable style="width: 260px" @keyup.enter="lookupChain" />
          <el-button type="primary" :loading="chainLoading" @click="lookupChain">查询链条</el-button>
          <el-button :loading="chainLoading" @click="loadBatches">载入示范溯源码</el-button>
          <el-select v-if="batchOptions.length" v-model="pickedBatch" placeholder="或选择已有溯源码" clearable style="width: 200px" @change="lookupChain">
            <el-option v-for="b in batchOptions" :key="b" :label="b" :value="b" />
          </el-select>
        </div>
      </div>
      <el-timeline v-if="chainRecords.length" class="chain-timeline">
        <el-timeline-item v-for="row in chainRecords" :key="row.id" :timestamp="formatDateTime(row.createdAt)" placement="top" :type="traceTimelineType(row.event)">
          <div class="chain-node">
            <el-tag :type="getTraceEventType(row.event)" size="small">{{ getTraceEventText(row.event) }}</el-tag>
            <span class="chain-node-detail">{{ row.detail || '（无详情）' }}</span>
            <span class="chain-node-meta">{{ row.plotCode }} · {{ row.operator }}</span>
          </div>
        </el-timeline-item>
        <el-timeline-item :hollow="true" type="info" placement="top">
          <div class="chain-node chain-node-external">加工 / 仓储 / 物流 / 质检 / 销售：由外部系统提供，尚未接入本平台</div>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else-if="chainSearched && !chainLoading" description="未找到该溯源码对应的生产链条" :image-size="60" />
    </div>

    <div class="card-container mt-20">
      <el-form :inline="true" :model="query" @submit.prevent="search">
        <el-form-item label="溯源码"><el-input v-model="query.batchCode" placeholder="可选" clearable style="width: 170px" /></el-form-item>
        <el-form-item label="地块编码"><el-input v-model="query.plotCode" placeholder="可选" clearable style="width: 170px" /></el-form-item>
        <el-form-item label="事件">
          <el-select v-model="query.event" placeholder="全部" clearable style="width: 140px">
            <el-option v-for="option in traceEventOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词"><el-input v-model="query.keyword" placeholder="追溯码/详情/操作人" clearable style="width: 170px" /></el-form-item>
        <el-form-item label="记录时间">
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
        <el-form-item><el-button type="primary" @click="search">查询</el-button><el-button @click="resetQuery">重置</el-button></el-form-item>
      </el-form>

      <div class="table-toolbar">
        <div>
          <el-button v-if="canWrite" type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>新增记录
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

      <el-table v-loading="loading" :data="records" border stripe>
        <el-table-column prop="traceCode" label="追溯码" min-width="190" />
        <el-table-column prop="batchCode" label="溯源码" min-width="140"><template #default="{ row }">{{ row.batchCode || '—' }}</template></el-table-column>
        <el-table-column prop="plotCode" label="地块编码" min-width="180" />
        <el-table-column label="事件" width="130">
          <template #default="{ row }">
            <el-tag :type="getTraceEventType(row.event)" size="small">{{ getTraceEventText(row.event) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="详情" min-width="200" />
        <el-table-column prop="operator" label="操作人" />
        <el-table-column prop="createdAt" label="时间" width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" width="90" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="!row.batchCode" @click="viewChain(row.batchCode)">看链条</el-button>
          </template>
        </el-table-column>
      </el-table>
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

    <el-dialog v-model="createVisible" title="新增溯源记录" width="560px" @closed="resetForm">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="88px" @submit.prevent="submit">
        <el-form-item label="地块编码" prop="plotCode">
          <el-input v-model="form.plotCode" placeholder="选填，留空表示不关联地块" clearable />
        </el-form-item>
        <el-form-item label="溯源码" prop="batchCode">
          <el-input v-model="form.batchCode" placeholder="选填，填写后可按溯源码串起整条生产链" clearable />
        </el-form-item>
        <el-form-item label="事件" prop="event">
          <el-select v-model="form.event" style="width: 180px">
            <el-option v-for="option in manualTraceEventOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="详情" prop="detail">
          <el-input v-model="form.detail" type="textarea" :rows="3" placeholder="写明作业内容与结果，追溯页按关键词检索此栏" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="form.operator" style="width: 200px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submit">新增</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { traceApi } from '@/api'
import { useUserStore } from '@/stores'
import { formatDateTime, getTraceEventText, getTraceEventType, manualTraceEventOptions, traceEventOptions } from '@/utils'
const userStore = useUserStore()
const loading = ref(false)
const records = ref<any[]>([])
const total = ref(0)
const query = reactive<{ plotCode: string; event: string; batchCode: string; keyword: string; range: [string, string] | null }>({ plotCode: '', event: '', batchCode: '', keyword: '', range: null })
const page = reactive({ page: 1, size: 20 })
const form = reactive({ plotCode: '', batchCode: '', event: 'FARM_OPERATION', detail: '', operator: '' })
const createVisible = ref(false)
const creating = ref(false)
const formRef = ref<FormInstance>()
const canWrite = computed(() => userStore.hasPermission('trace:write'))
// 全链条溯源：按溯源码取时间正序的档案链
const lookupCode = ref('')
const pickedBatch = ref('')
const batchOptions = ref<string[]>([])
const chainRecords = ref<any[]>([])
const chainLoading = ref(false)
const chainSearched = ref(false)
const formRules: FormRules = {
  detail: [{ required: true, message: '请填写记录详情', trigger: 'blur' }],
  event: [{ required: true, message: '请选择事件类型', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}
async function load() {
  loading.value = true
  try {
    const result = await traceApi.getRecords({
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.event ? { event: query.event } : {}),
      ...(query.batchCode ? { batchCode: query.batchCode } : {}),
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.range?.[0] ? { from: query.range[0] } : {}),
      ...(query.range?.[1] ? { to: query.range[1] } : {}),
      page: page.page,
      size: page.size
    })
    records.value = result.items
    total.value = result.total
  } finally { loading.value = false }
}
function search() { page.page = 1; void load() }
function resetQuery() { query.plotCode = ''; query.event = ''; query.batchCode = ''; query.keyword = ''; query.range = null; search() }
/** 时间轴节点色：已落地的作业（处方、灌溉结单、采收）绿、归档橙、其余蓝，与列表标签口径一致 */
function traceTimelineType(event: string): 'success' | 'warning' | 'primary' {
  const kind = getTraceEventType(event)
  return kind === 'info' ? 'primary' : kind
}
async function fetchChain(code: string) {
  const target = code.trim()
  chainSearched.value = true
  if (!target) { chainRecords.value = []; return }
  chainLoading.value = true
  try { chainRecords.value = await traceApi.getChain(target) }
  catch { chainRecords.value = [] }
  finally { chainLoading.value = false }
}
function lookupChain() {
  const code = pickedBatch.value || lookupCode.value
  lookupCode.value = code
  void fetchChain(code)
}
function viewChain(code: string) {
  pickedBatch.value = ''
  lookupCode.value = code
  void fetchChain(code)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
/** 从当前列表去重出已有溯源码，便于快速选择示范链条 */
function loadBatches() {
  const codes = new Set<string>()
  for (const row of records.value) { if (row.batchCode) codes.add(row.batchCode) }
  batchOptions.value = [...codes].sort()
  if (!batchOptions.value.length) ElMessage.info('当前列表没有带溯源码的记录，可在下方登记时填写溯源码')
}
function openCreate() {
  form.plotCode = query.plotCode
  form.batchCode = query.batchCode
  // 操作人默认落到当前登录账号，代他人补录时可改
  form.operator = userStore.userInfo?.name || userStore.userInfo?.username || ''
  createVisible.value = true
}
function resetForm() {
  formRef.value?.clearValidate()
  form.detail = ''
}
async function submit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  creating.value = true
  try {
    await traceApi.createRecord({ ...form, plotCode: form.plotCode.trim(), batchCode: form.batchCode.trim() })
    ElMessage.success('追溯记录已新增')
    createVisible.value = false
    await load()
  } finally {
    creating.value = false
  }
}
onMounted(() => void load())
</script>

<style scoped>
.chain-lookup { padding: 4px 0 8px; }
.chain-lookup-title { font-size: 15px; font-weight: 600; color: #303133; }
.chain-lookup-hint { margin: 6px 0 12px; font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }
.chain-lookup-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.chain-timeline { margin-top: 16px; padding-left: 4px; }
.chain-node { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.chain-node-detail { color: #303133; }
.chain-node-meta { font-size: 12px; color: var(--el-text-color-secondary); }
.chain-node-external { color: var(--el-text-color-secondary); font-size: 13px; }
</style>
