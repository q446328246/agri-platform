<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="query" @submit.prevent="reload">
        <el-form-item label="类型">
          <el-select v-model="query.type" placeholder="全部" clearable style="width: 120px">
            <el-option label="告警" value="ALERT" />
            <el-option label="通知" value="NOTICE" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.read" placeholder="全部" clearable style="width: 120px">
            <el-option label="未读" value="false" />
            <el-option label="已读" value="true" />
          </el-select>
        </el-form-item>
        <el-form-item label="地块">
          <el-input v-model="query.plotCode" placeholder="地块编码" clearable style="width: 170px" />
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="query.keyword" placeholder="标题或内容" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">查询</el-button>
          <el-button @click="reset">重置</el-button>
          <el-button type="success" @click="openDialog">新建通知</el-button>
          <el-button @click="openPreferences">订阅偏好</el-button>
        </el-form-item>
      </el-form>

      <div class="message-toolbar">
        <div class="message-summary">
          <el-tag type="danger" effect="plain">未读 {{ unread }}</el-tag>
          <span class="message-hint">告警来自遥测阈值事件，通知来自处方下发或手工创建</span>
        </div>
        <el-button :disabled="selectedUnread.length === 0" @click="readSelected">
          标记所选已读（{{ selectedUnread.length }}）
        </el-button>
      </div>

      <el-table
        v-loading="loading"
        :data="messages"
        border
        stripe
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" :selectable="selectable" />
        <el-table-column label="级别" width="90">
          <template #default="{ row }">
            <el-tag :type="levelType(row.level)" size="small" effect="dark">{{ levelText(row.level) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <el-tag :type="row.type === 'ALERT' ? 'danger' : 'info'" size="small" effect="plain">
              {{ row.type === 'ALERT' ? '告警' : '通知' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
        <el-table-column prop="content" label="内容" min-width="280" show-overflow-tooltip />
        <el-table-column prop="plotCode" label="地块编码" width="150" />
        <el-table-column label="来源" width="90">
          <template #default="{ row }">{{ row.sourceEventId ? '事件' : '手工' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.read ? 'info' : 'warning'" size="small">{{ row.read ? '已读' : '未读' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button v-if="!row.read" link type="primary" @click="markRead(row)">标记已读</el-button>
            <span v-else class="message-done">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无消息" />
        </template>
      </el-table>

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

    <el-dialog v-model="dialogVisible" title="新建通知" width="520px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="标题" required>
          <el-input v-model="form.title" placeholder="请输入通知标题" maxlength="80" show-word-limit />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.content" type="textarea" :rows="3" placeholder="补充说明（可选）" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="form.type">
            <el-radio value="NOTICE">通知</el-radio>
            <el-radio value="ALERT">告警</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="级别">
          <el-select v-model="form.level" style="width: 160px">
            <el-option label="提示" value="INFO" />
            <el-option label="警告" value="WARNING" />
            <el-option label="严重" value="CRITICAL" />
          </el-select>
        </el-form-item>
        <el-form-item label="地块">
          <el-input v-model="form.plotCode" placeholder="地块编码（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">发送</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="preferenceVisible" title="订阅偏好" width="620px">
      <p class="message-hint preference-hint">
        关闭订阅后该类事件不再写入消息中心；低于最低级别的消息会被过滤，全部关闭也不影响手工通知。
      </p>
      <el-table v-loading="preferenceLoading" :data="preferenceRows" border size="small">
        <el-table-column prop="label" label="消息来源" min-width="200" />
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="row.type === 'ALERT' ? 'danger' : 'info'" size="small" effect="plain">
              {{ row.type === 'ALERT' ? '告警' : '通知' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="接收" width="80">
          <template #default="{ row }">
            <el-switch v-model="row.enabled" />
          </template>
        </el-table-column>
        <el-table-column label="最低级别" width="150">
          <template #default="{ row }">
            <el-select v-model="row.minLevel" :disabled="!row.enabled" size="small" style="width: 110px">
              <el-option label="提示" value="INFO" />
              <el-option label="警告" value="WARNING" />
              <el-option label="严重" value="CRITICAL" />
            </el-select>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无可配置的消息来源" />
        </template>
      </el-table>
      <template #footer>
        <el-button @click="preferenceVisible = false">取消</el-button>
        <el-button type="primary" :loading="preferenceSaving" @click="savePreferences">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { messageApi } from '@/api'
import type { MessageLevel, MessagePreference, MessageQuery } from '@/api'
import { formatDateTime } from '@/utils'

interface MessageRow {
  id: string
  type: 'ALERT' | 'NOTICE'
  title: string
  content: string
  level: 'INFO' | 'WARNING' | 'CRITICAL'
  read: boolean
  plotCode?: string
  sourceEventId?: string
  createdAt: string
}

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const messages = ref<MessageRow[]>([])
const total = ref(0)
const unread = ref(0)
const selection = ref<MessageRow[]>([])

const query = reactive({
  page: 1,
  size: 20,
  type: '' as '' | 'ALERT' | 'NOTICE',
  read: '' as '' | 'true' | 'false',
  plotCode: '',
  keyword: '',
})

const form = reactive({
  title: '',
  content: '',
  type: 'NOTICE' as 'ALERT' | 'NOTICE',
  level: 'INFO' as 'INFO' | 'WARNING' | 'CRITICAL',
  plotCode: '',
})

const selectedUnread = computed(() => selection.value.filter((item) => !item.read))

// 订阅偏好：列表按模板目录返回，保存时逐个主题提交
const preferenceVisible = ref(false)
const preferenceLoading = ref(false)
const preferenceSaving = ref(false)
const preferenceRows = ref<MessagePreference[]>([])

async function openPreferences(): Promise<void> {
  preferenceVisible.value = true
  preferenceLoading.value = true
  try {
    const result = await messageApi.getPreferences()
    preferenceRows.value = (result.items ?? []).map((item) => ({ ...item }))
  } finally {
    preferenceLoading.value = false
  }
}

async function savePreferences(): Promise<void> {
  preferenceSaving.value = true
  try {
    await Promise.all(
      preferenceRows.value.map((row) =>
        messageApi.updatePreference(row.topic, { enabled: row.enabled, minLevel: row.minLevel as MessageLevel }),
      ),
    )
    ElMessage.success('订阅偏好已保存，后续事件按新配置过滤')
    preferenceVisible.value = false
  } finally {
    preferenceSaving.value = false
  }
}

function levelText(level: string): string {
  if (level === 'CRITICAL') return '严重'
  return level === 'WARNING' ? '警告' : '提示'
}

function levelType(level: string): 'danger' | 'warning' | 'info' {
  if (level === 'CRITICAL') return 'danger'
  return level === 'WARNING' ? 'warning' : 'info'
}

function selectable(row: MessageRow): boolean {
  return !row.read
}

function buildParams(): MessageQuery {
  const params: MessageQuery = { page: query.page, size: query.size }
  if (query.type) params.type = query.type
  if (query.read === 'true' || query.read === 'false') params.read = query.read === 'true'
  const plotCode = query.plotCode.trim()
  if (plotCode) params.plotCode = plotCode
  const keyword = query.keyword.trim()
  if (keyword) params.keyword = keyword
  return params
}

async function refreshUnread(): Promise<void> {
  try {
    unread.value = (await messageApi.getUnreadCount()).unread
  } catch {
    // 角标失败不影响列表浏览
    unread.value = 0
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await messageApi.getList(buildParams())
    messages.value = (result.items ?? []) as MessageRow[]
    total.value = result.total ?? 0
    selection.value = []
  } finally {
    loading.value = false
  }
  await refreshUnread()
}

function reload(): void {
  query.page = 1
  void load()
}

function reset(): void {
  query.type = ''
  query.read = ''
  query.plotCode = ''
  query.keyword = ''
  reload()
}

function onSelectionChange(rows: MessageRow[]): void {
  selection.value = rows
}

async function markRead(row: MessageRow): Promise<void> {
  await messageApi.markRead(row.id)
  row.read = true
  ElMessage.success('已标记为已读')
  await refreshUnread()
}

async function readSelected(): Promise<void> {
  const targets = selectedUnread.value
  if (!targets.length) return
  await Promise.all(targets.map((item) => messageApi.markRead(item.id)))
  ElMessage.success(`已标记 ${targets.length} 条消息为已读`)
  await load()
}

function openDialog(): void {
  form.title = ''
  form.content = ''
  form.type = 'NOTICE'
  form.level = 'INFO'
  form.plotCode = ''
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const title = form.title.trim()
  if (!title) {
    ElMessage.warning('请输入通知标题')
    return
  }
  submitting.value = true
  try {
    await messageApi.create({
      title,
      content: form.content,
      type: form.type,
      level: form.level,
      ...(form.plotCode.trim() ? { plotCode: form.plotCode.trim() } : {}),
    })
    ElMessage.success('通知已发送')
    dialogVisible.value = false
    reload()
  } finally {
    submitting.value = false
  }
}

onMounted(() => void load())
</script>

<style scoped>
.message-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.message-summary {
  display: flex;
  align-items: center;
  gap: 12px;
}

.message-hint {
  color: #909399;
  font-size: 13px;
}

.message-done {
  color: #c0c4cc;
}

.preference-hint {
  margin: 0 0 12px;
  line-height: 1.6;
}
</style>
