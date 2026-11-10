<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="query" @submit.prevent="search">
        <el-form-item label="地块编码"><el-input v-model="query.plotCode" placeholder="可选" clearable style="width: 170px" /></el-form-item>
        <el-form-item label="事件">
          <el-select v-model="query.event" placeholder="全部" clearable style="width: 140px">
            <el-option label="处方生成" value="PRESCRIPTION_ISSUED" />
            <el-option label="农事作业" value="FARM_OPERATION" />
            <el-option label="作业完成" value="OPERATION_COMPLETED" />
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
        <el-form-item label="事件" prop="event">
          <el-select v-model="form.event" style="width: 180px">
            <el-option label="农事作业" value="FARM_OPERATION" />
            <el-option label="作业完成" value="OPERATION_COMPLETED" />
            <el-option label="处方生成" value="PRESCRIPTION_ISSUED" />
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
import { formatDateTime, getTraceEventText, getTraceEventType } from '@/utils'
const userStore = useUserStore()
const loading = ref(false)
const records = ref<any[]>([])
const total = ref(0)
const query = reactive<{ plotCode: string; event: string; keyword: string; range: [string, string] | null }>({ plotCode: '', event: '', keyword: '', range: null })
const page = reactive({ page: 1, size: 20 })
const form = reactive({ plotCode: '', event: 'FARM_OPERATION', detail: '', operator: '' })
const createVisible = ref(false)
const creating = ref(false)
const formRef = ref<FormInstance>()
const canWrite = computed(() => userStore.hasPermission('trace:write'))
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
function resetQuery() { query.plotCode = ''; query.event = ''; query.keyword = ''; query.range = null; search() }
function openCreate() {
  form.plotCode = query.plotCode
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
    await traceApi.createRecord({ ...form, plotCode: form.plotCode.trim() })
    ElMessage.success('追溯记录已新增')
    createVisible.value = false
    await load()
  } finally {
    creating.value = false
  }
}
onMounted(() => void load())
</script>
