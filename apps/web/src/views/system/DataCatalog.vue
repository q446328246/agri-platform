<template>
  <div class="page-container">
    <div class="card-container">
      <el-tabs v-model="tab" @tab-change="onTabChange">
        <el-tab-pane label="资产目录" name="assets">
          <el-form :inline="true" :model="assetQuery" @submit.prevent="reloadAssets">
            <el-form-item label="关键词">
              <el-input v-model="assetQuery.keyword" placeholder="资产名称、编码或说明" clearable style="width: 200px" @keyup.enter="reloadAssets" />
            </el-form-item>
            <el-form-item label="分类">
              <el-select v-model="assetQuery.category" placeholder="全部分类" clearable style="width: 150px">
                <el-option v-for="item in CATEGORY_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="reloadAssets">查询</el-button>
              <el-button @click="resetAssets">重置</el-button>
              <el-button type="success" @click="openAssetDialog()">登记资产</el-button>
            </el-form-item>
          </el-form>

          <el-table v-loading="assetLoading" :data="assets" border stripe row-key="id">
            <el-table-column prop="code" label="资产编码" width="180" show-overflow-tooltip />
            <el-table-column prop="name" label="资产名称" width="150" show-overflow-tooltip />
            <el-table-column label="分类" width="110" align="center">
              <template #default="{ row }">
                <el-tag :type="categoryTag(row.category)" size="small" effect="plain">{{ categoryText(row.category) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="说明" min-width="200" show-overflow-tooltip />
            <el-table-column prop="sourceService" label="来源服务" width="140" show-overflow-tooltip />
            <el-table-column prop="storage" label="存储" width="120" show-overflow-tooltip />
            <el-table-column prop="updateFrequency" label="更新频率" width="110" show-overflow-tooltip />
            <el-table-column label="地块关联" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="row.plotLinked ? 'success' : 'info'" size="small">{{ row.plotLinked ? '是' : '否' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openAssetDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="removeAsset(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无数据资产" />
            </template>
          </el-table>

          <div class="pagination-container">
            <el-pagination
              v-model:current-page="assetQuery.page"
              v-model:page-size="assetQuery.size"
              :total="assetTotal"
              :page-sizes="[10, 20, 50]"
              layout="total, sizes, prev, pager, next"
              @current-change="loadAssets"
              @size-change="reloadAssets"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="数据字典" name="dictionary">
          <el-form :inline="true" :model="dictQuery" @submit.prevent="reloadDictionary">
            <el-form-item label="关键词">
              <el-input v-model="dictQuery.keyword" placeholder="指标名称、键或口径" clearable style="width: 200px" @keyup.enter="reloadDictionary" />
            </el-form-item>
            <el-form-item label="所属资产">
              <el-select v-model="dictQuery.assetCode" placeholder="全部资产" clearable filterable style="width: 220px">
                <el-option v-for="asset in assetOptions" :key="asset.code" :label="`${asset.name}（${asset.code}）`" :value="asset.code" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="reloadDictionary">查询</el-button>
              <el-button @click="resetDictionary">重置</el-button>
              <el-button type="success" @click="openDictDialog()">新增条目</el-button>
            </el-form-item>
          </el-form>

          <el-table v-loading="dictLoading" :data="dictionary" border stripe row-key="id">
            <el-table-column label="所属资产" width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ assetName(row.assetCode) }}</template>
            </el-table-column>
            <el-table-column prop="metricKey" label="指标键" width="160" show-overflow-tooltip />
            <el-table-column prop="label" label="指标名称" width="140" show-overflow-tooltip />
            <el-table-column prop="definition" label="口径定义" min-width="220" show-overflow-tooltip />
            <el-table-column prop="unit" label="单位" width="80" align="center" />
            <el-table-column prop="dataType" label="数据类型" width="100" align="center" />
            <el-table-column prop="source" label="来源" width="130" show-overflow-tooltip />
            <el-table-column prop="updateFrequency" label="更新频率" width="110" show-overflow-tooltip />
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openDictDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="removeDict(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无字典条目" />
            </template>
          </el-table>

          <div class="pagination-container">
            <el-pagination
              v-model:current-page="dictQuery.page"
              v-model:page-size="dictQuery.size"
              :total="dictTotal"
              :page-sizes="[10, 20, 50]"
              layout="total, sizes, prev, pager, next"
              @current-change="loadDictionary"
              @size-change="reloadDictionary"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="assetDialogVisible" :title="assetEditingId ? '编辑资产' : '登记资产'" width="640px">
      <el-form :model="assetForm" label-width="90px">
        <el-form-item label="资产编码" required>
          <el-input v-model="assetForm.code" :disabled="Boolean(assetEditingId)" placeholder="小写字母开头，3~64 位，建议取真实表名" maxlength="64" />
        </el-form-item>
        <el-form-item label="资产名称" required>
          <el-input v-model="assetForm.name" placeholder="如：地块档案" maxlength="100" />
        </el-form-item>
        <el-form-item label="分类" required>
          <el-select v-model="assetForm.category" style="width: 200px">
            <el-option v-for="item in CATEGORY_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="assetForm.description" type="textarea" :rows="2" placeholder="这份数据是什么、给谁用" maxlength="500" />
        </el-form-item>
        <el-form-item label="来源服务">
          <el-input v-model="assetForm.sourceService" placeholder="如：plot-service" maxlength="100" />
        </el-form-item>
        <el-form-item label="存储">
          <el-input v-model="assetForm.storage" placeholder="如：PostgreSQL" maxlength="100" />
        </el-form-item>
        <el-form-item label="更新频率">
          <el-input v-model="assetForm.updateFrequency" placeholder="如：实时 / 每日 / 每季" maxlength="100" />
        </el-form-item>
        <el-form-item label="地块关联">
          <el-switch v-model="assetForm.plotLinked" active-text="可按地块关联" inactive-text="否" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assetDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitAsset">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="dictDialogVisible" :title="dictEditingId ? '编辑字典条目' : '新增字典条目'" width="640px">
      <el-form :model="dictForm" label-width="90px">
        <el-form-item label="所属资产" required>
          <el-select v-model="dictForm.assetCode" :disabled="Boolean(dictEditingId)" filterable placeholder="选择数据资产" style="width: 100%">
            <el-option v-for="asset in assetOptions" :key="asset.code" :label="`${asset.name}（${asset.code}）`" :value="asset.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="指标键" required>
          <el-input v-model="dictForm.metricKey" :disabled="Boolean(dictEditingId)" placeholder="字母开头，如 soilMoisture；同一资产下唯一" maxlength="64" />
        </el-form-item>
        <el-form-item label="指标名称" required>
          <el-input v-model="dictForm.label" placeholder="如：土壤湿度" maxlength="100" />
        </el-form-item>
        <el-form-item label="口径定义">
          <el-input v-model="dictForm.definition" type="textarea" :rows="2" placeholder="统计口径、取值范围与注意事项" maxlength="500" />
        </el-form-item>
        <el-form-item label="单位">
          <el-input v-model="dictForm.unit" placeholder="如：%、mm、m³；无单位留空" maxlength="30" />
        </el-form-item>
        <el-form-item label="数据类型">
          <el-input v-model="dictForm.dataType" placeholder="如：number、string、boolean" maxlength="30" />
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="dictForm.source" placeholder="如：传感器上报 / 人工填报" maxlength="100" />
        </el-form-item>
        <el-form-item label="更新频率">
          <el-input v-model="dictForm.updateFrequency" placeholder="如：每 10 分钟 / 每日" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dictDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitDict">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { platformApi } from '@/api'
import type { DataAsset, DataAssetCategory, DataDictionaryEntry } from '@/types'

// 与后端 DATA_ASSET_CATEGORIES 白名单同步（方案 11.4 五类），非法分类后端 400
const CATEGORY_OPTIONS: { value: DataAssetCategory; label: string; tag: 'success' | 'primary' | 'warning' | 'info' | 'danger' }[] = [
  { value: 'SPATIAL', label: '基础空间', tag: 'success' },
  { value: 'DEVICE', label: '设备台账', tag: 'primary' },
  { value: 'TELEMETRY', label: '实时感知', tag: 'warning' },
  { value: 'BUSINESS', label: '业务过程', tag: 'info' },
  { value: 'STATS', label: '统计分析', tag: 'danger' },
]

const tab = ref<'assets' | 'dictionary'>('assets')
const submitting = ref(false)

const assetLoading = ref(false)
const assets = ref<DataAsset[]>([])
const assetTotal = ref(0)
const assetQuery = reactive({ page: 1, size: 20, keyword: '', category: '' as DataAssetCategory | '' })
const assetDialogVisible = ref(false)
const assetEditingId = ref('')
const assetForm = reactive({
  code: '',
  name: '',
  category: 'BUSINESS' as DataAssetCategory,
  description: '',
  sourceService: '',
  storage: '',
  updateFrequency: '',
  plotLinked: false,
})

const dictLoading = ref(false)
const dictionary = ref<DataDictionaryEntry[]>([])
const dictTotal = ref(0)
const dictQuery = reactive({ page: 1, size: 20, keyword: '', assetCode: '' })
const dictDialogVisible = ref(false)
const dictEditingId = ref('')
const dictForm = reactive({
  assetCode: '',
  metricKey: '',
  label: '',
  definition: '',
  unit: '',
  dataType: '',
  source: '',
  updateFrequency: '',
})

// 字典筛选与表单共用的资产下拉：一次拉满（后端 size 上限 200，种子 26 条）
const assetOptions = ref<DataAsset[]>([])

function categoryText(category: DataAssetCategory): string {
  return CATEGORY_OPTIONS.find((item) => item.value === category)?.label ?? category
}

function categoryTag(category: DataAssetCategory): 'success' | 'primary' | 'warning' | 'info' | 'danger' {
  return CATEGORY_OPTIONS.find((item) => item.value === category)?.tag ?? 'info'
}

function assetName(code: string): string {
  const asset = assetOptions.value.find((item) => item.code === code)
  return asset ? `${asset.name}（${code}）` : code
}

async function loadAssetOptions(): Promise<void> {
  try {
    const result = await platformApi.getDataAssets({ page: 1, size: 200 })
    assetOptions.value = result.items ?? []
  } catch {
    assetOptions.value = []
  }
}

async function loadAssets(): Promise<void> {
  assetLoading.value = true
  try {
    const result = await platformApi.getDataAssets({
      page: assetQuery.page,
      size: assetQuery.size,
      keyword: assetQuery.keyword.trim(),
      ...(assetQuery.category ? { category: assetQuery.category } : {}),
    })
    assets.value = result.items ?? []
    assetTotal.value = result.total ?? 0
  } finally {
    assetLoading.value = false
  }
}

function reloadAssets(): void {
  assetQuery.page = 1
  void loadAssets()
}

function resetAssets(): void {
  assetQuery.keyword = ''
  assetQuery.category = ''
  reloadAssets()
}

async function loadDictionary(): Promise<void> {
  dictLoading.value = true
  try {
    const result = await platformApi.getDataDictionary({
      page: dictQuery.page,
      size: dictQuery.size,
      keyword: dictQuery.keyword.trim(),
      ...(dictQuery.assetCode ? { assetCode: dictQuery.assetCode } : {}),
    })
    dictionary.value = result.items ?? []
    dictTotal.value = result.total ?? 0
  } finally {
    dictLoading.value = false
  }
}

function reloadDictionary(): void {
  dictQuery.page = 1
  void loadDictionary()
}

function resetDictionary(): void {
  dictQuery.keyword = ''
  dictQuery.assetCode = ''
  reloadDictionary()
}

function onTabChange(name: string | number): void {
  if (name === 'dictionary' && dictionary.value.length === 0) void loadDictionary()
}

function openAssetDialog(row?: DataAsset): void {
  assetEditingId.value = row ? row.id : ''
  assetForm.code = row?.code ?? ''
  assetForm.name = row?.name ?? ''
  assetForm.category = row?.category ?? 'BUSINESS'
  assetForm.description = row?.description ?? ''
  assetForm.sourceService = row?.sourceService ?? ''
  assetForm.storage = row?.storage ?? ''
  assetForm.updateFrequency = row?.updateFrequency ?? ''
  assetForm.plotLinked = row?.plotLinked ?? false
  assetDialogVisible.value = true
}

async function submitAsset(): Promise<void> {
  const name = assetForm.name.trim()
  const code = assetForm.code.trim()
  if (!name) {
    ElMessage.warning('请输入资产名称')
    return
  }
  if (!assetEditingId.value && !/^[a-z][a-z0-9_]{2,63}$/.test(code)) {
    ElMessage.warning('资产编码需以小写字母开头，3~64 位小写字母、数字或下划线（建议取真实表名）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      name,
      category: assetForm.category,
      description: assetForm.description.trim(),
      sourceService: assetForm.sourceService.trim(),
      storage: assetForm.storage.trim(),
      updateFrequency: assetForm.updateFrequency.trim(),
      plotLinked: assetForm.plotLinked,
    }
    if (assetEditingId.value) {
      await platformApi.updateDataAsset(assetEditingId.value, payload)
      ElMessage.success('资产已更新')
    } else {
      await platformApi.createDataAsset({ code, ...payload })
      ElMessage.success('资产已登记')
    }
    assetDialogVisible.value = false
    await Promise.all([loadAssets(), loadAssetOptions()])
  } finally {
    submitting.value = false
  }
}

async function removeAsset(row: DataAsset): Promise<void> {
  await ElMessageBox.confirm(`确认删除资产 ${row.name}（${row.code}）？其下仍挂字典条目时不可删除。`, '删除资产', { type: 'warning' })
  await platformApi.deleteDataAsset(row.id)
  ElMessage.success('资产已删除')
  await Promise.all([loadAssets(), loadAssetOptions()])
}

function openDictDialog(row?: DataDictionaryEntry): void {
  dictEditingId.value = row ? row.id : ''
  dictForm.assetCode = row?.assetCode ?? (dictQuery.assetCode || '')
  dictForm.metricKey = row?.metricKey ?? ''
  dictForm.label = row?.label ?? ''
  dictForm.definition = row?.definition ?? ''
  dictForm.unit = row?.unit ?? ''
  dictForm.dataType = row?.dataType ?? ''
  dictForm.source = row?.source ?? ''
  dictForm.updateFrequency = row?.updateFrequency ?? ''
  dictDialogVisible.value = true
}

async function submitDict(): Promise<void> {
  const label = dictForm.label.trim()
  const metricKey = dictForm.metricKey.trim()
  if (!dictForm.assetCode) {
    ElMessage.warning('请选择所属资产')
    return
  }
  if (!label) {
    ElMessage.warning('请输入指标名称')
    return
  }
  if (!dictEditingId.value && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(metricKey)) {
    ElMessage.warning('指标键需以字母开头，1~64 位字母、数字或下划线')
    return
  }
  submitting.value = true
  try {
    const payload = {
      label,
      definition: dictForm.definition.trim(),
      unit: dictForm.unit.trim(),
      dataType: dictForm.dataType.trim(),
      source: dictForm.source.trim(),
      updateFrequency: dictForm.updateFrequency.trim(),
    }
    if (dictEditingId.value) {
      await platformApi.updateDictionaryEntry(dictEditingId.value, payload)
      ElMessage.success('字典条目已更新')
    } else {
      await platformApi.createDictionaryEntry({ assetCode: dictForm.assetCode, metricKey, ...payload })
      ElMessage.success('字典条目已新增')
    }
    dictDialogVisible.value = false
    await loadDictionary()
  } finally {
    submitting.value = false
  }
}

async function removeDict(row: DataDictionaryEntry): Promise<void> {
  await ElMessageBox.confirm(`确认删除字典条目 ${row.label}（${row.assetCode}.${row.metricKey}）？`, '删除字典条目', { type: 'warning' })
  await platformApi.deleteDictionaryEntry(row.id)
  ElMessage.success('字典条目已删除')
  await loadDictionary()
}

onMounted(async () => {
  await loadAssetOptions()
  await loadAssets()
})
</script>