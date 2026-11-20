<template>
  <div class="knowledge-page">
    <div class="query-bar">
      <el-input v-model="queryForm.keyword" placeholder="关键词/标题" clearable style="width: 200px" @keyup.enter="reload" />
      <el-select v-model="queryForm.category" placeholder="全部分类" clearable style="width: 150px">
        <el-option v-for="item in categoryOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button type="primary" @click="reload">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
      <el-button type="primary" plain :icon="Plus" @click="openCreate">新增条目</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="title" label="标题" min-width="140" />
      <el-table-column prop="category" label="分类" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ categoryLabel(row.category) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="keywords" label="检索关键词" min-width="160" show-overflow-tooltip />
      <el-table-column prop="content" label="内容" min-width="260" show-overflow-tooltip />
      <el-table-column prop="source" label="依据来源" min-width="140" show-overflow-tooltip />
      <el-table-column label="状态" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="130" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="queryForm.size"
      :current-page="queryForm.page"
      @current-change="onPageChange"
    />

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑知识条目' : '新增知识条目'" width="640px">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="90px">
        <el-form-item label="分类" prop="category">
          <el-select v-model="form.category" style="width: 100%">
            <el-option v-for="item in categoryOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" placeholder="如：灌溉定额" />
        </el-form-item>
        <el-form-item label="检索关键词" prop="keywords">
          <el-input v-model="form.keywords" placeholder="逗号分隔，问答按关键词命中，如：灌溉,定额,灌水" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="form.content" type="textarea" :rows="4" placeholder="知识正文，回答直接引用" />
        </el-form-item>
        <el-form-item label="依据来源">
          <el-input v-model="form.source" placeholder="如：D1 农艺口径确认（2026-11-20）" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :step="1" controls-position="right" />
          <span class="form-hint">数字越小越靠前，问答命中多条时按此排序</span>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
          <span class="form-hint">停用后不参与问答检索</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { decisionApi, type KnowledgeEntry } from '@/api'

const categoryOptions = [
  { value: 'CROP', label: '作物' },
  { value: 'INDICATOR', label: '指标' },
  { value: 'DISPOSAL', label: '处置' },
  { value: 'CRITERIA', label: '口径' },
]

function categoryLabel(value: string): string {
  return categoryOptions.find((item) => item.value === value)?.label ?? value
}

const rows = ref<KnowledgeEntry[]>([])
const total = ref(0)
const loading = ref(false)
const queryForm = reactive({ keyword: '', category: '' as string, page: 1, size: 20 })

async function load() {
  loading.value = true
  try {
    const result = await decisionApi.getKnowledge({ page: queryForm.page, size: queryForm.size })
    rows.value = result.items.filter((item) => {
      const keywordHit = !queryForm.keyword || item.title.includes(queryForm.keyword) || item.keywords.includes(queryForm.keyword)
      const categoryHit = !queryForm.category || item.category === queryForm.category
      return keywordHit && categoryHit
    })
    total.value = result.total
  } catch (error) {
    ElMessage.error(`知识库加载失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

function reload() {
  queryForm.page = 1
  void load()
}

function resetQuery() {
  queryForm.keyword = ''
  queryForm.category = ''
  reload()
}

function onPageChange(page: number) {
  queryForm.page = page
  void load()
}

const dialogVisible = ref(false)
const saving = ref(false)
const editing = ref<KnowledgeEntry | null>(null)
const formRef = ref<FormInstance | null>(null)
const form = reactive({
  category: 'CRITERIA' as KnowledgeEntry['category'],
  title: '',
  keywords: '',
  content: '',
  source: '',
  sort: 0,
  enabled: true,
})

const formRules: FormRules = {
  category: [{ required: true, message: '请选择分类', trigger: 'change' }],
  title: [{ required: true, message: '请填写标题', trigger: 'blur' }],
  keywords: [{ required: true, message: '请填写检索关键词（逗号分隔）', trigger: 'blur' }],
  content: [{ required: true, message: '请填写内容', trigger: 'blur' }],
}

function openCreate() {
  editing.value = null
  Object.assign(form, { category: 'CRITERIA', title: '', keywords: '', content: '', source: '', sort: 0, enabled: true })
  dialogVisible.value = true
}

function openEdit(row: KnowledgeEntry) {
  editing.value = row
  Object.assign(form, {
    category: row.category,
    title: row.title,
    keywords: row.keywords,
    content: row.content,
    source: row.source ?? '',
    sort: row.sort,
    enabled: row.enabled,
  })
  dialogVisible.value = true
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload: { category: KnowledgeEntry['category']; title: string; keywords: string; content: string; source?: string; enabled: boolean; sort: number } = {
      category: form.category,
      title: form.title,
      keywords: form.keywords,
      content: form.content,
      enabled: form.enabled,
      sort: form.sort,
    }
    if (form.source) payload.source = form.source
    if (editing.value) await decisionApi.updateKnowledge(editing.value.id, payload)
    else await decisionApi.createKnowledge(payload)
    ElMessage.success(editing.value ? '知识条目已更新' : '知识条目已新增')
    dialogVisible.value = false
    void load()
  } catch (error) {
    ElMessage.error(`保存失败：${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}

async function remove(row: KnowledgeEntry) {
  try {
    await ElMessageBox.confirm(`确认删除知识条目「${row.title}」？删除后问答不再引用该条目。`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await decisionApi.deleteKnowledge(row.id)
    ElMessage.success('知识条目已删除')
    if (rows.value.length === 1 && queryForm.page > 1) queryForm.page -= 1
    void load()
  } catch (error) {
    ElMessage.error(`删除失败：${(error as Error).message}`)
  }
}

onMounted(load)
</script>

<style scoped>
.knowledge-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.query-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.pager {
  justify-content: flex-end;
}
.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: #909399;
}
</style>
