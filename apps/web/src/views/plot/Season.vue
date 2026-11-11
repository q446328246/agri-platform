<template>
  <div class="page-container">
    <div class="card-container">
      <div class="rotation">
        <div class="rotation-title">茬口轮作序列</div>
        <div class="rotation-hint">选择地块后按「年份 → 茬次 → 栽期」正序还原该地多年的种植季。这里据实回填的档案用于倒茬与连作判断的决策参考，系统不替农户决定种什么。</div>
        <div class="rotation-form">
          <el-select v-model="rotationPlot" placeholder="选择地块查看轮作" clearable filterable style="width: 260px" @change="onRotationPlot">
            <el-option v-for="p in plotOptions" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
        </div>
      </div>
      <template v-if="rotationPlot && rotationRecords.length">
        <el-alert
          v-if="rotationAdvice"
          :title="rotationAdvice.text"
          :type="rotationAdvice.kind"
          :closable="false"
          show-icon
          class="rotation-advice"
        />
        <el-timeline class="rotation-timeline">
          <el-timeline-item
            v-for="row in rotationRecords"
            :key="row.seasonCode"
            :timestamp="seasonPeriod(row)"
            placement="top"
            :type="seasonTimelineType(row.status)"
          >
            <div class="rotation-node">
              <el-tag :type="seasonStatusType(row.status)" size="small">{{ seasonStatusText(row.status) }}</el-tag>
              <span class="rotation-crop">{{ row.seasonYear }}年第{{ row.seasonIndex }}茬 · {{ row.crop }}<template v-if="row.variety">（{{ row.variety }}）</template></span>
              <span v-if="row.yieldKg !== null" class="rotation-yield">产量 {{ row.yieldKg }} kg</span>
              <span v-if="row.note" class="rotation-note">{{ row.note }}</span>
            </div>
          </el-timeline-item>
        </el-timeline>
      </template>
      <el-empty v-else-if="rotationPlot && !rotationLoading" description="该地块暂无种植季档案" :image-size="60" />
    </div>

    <div class="card-container mt-20">
      <el-form :inline="true" :model="query" @submit.prevent="search">
        <el-form-item label="地块">
          <el-select v-model="query.plotCode" placeholder="全部" clearable filterable style="width: 200px">
            <el-option v-for="p in plotOptions" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="作物"><el-input v-model="query.crop" placeholder="可选" clearable style="width: 140px" /></el-form-item>
        <el-form-item label="年份"><el-input v-model="query.year" placeholder="如 2026" clearable style="width: 110px" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部" clearable style="width: 120px">
            <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item><el-button type="primary" @click="search">查询</el-button><el-button @click="resetQuery">重置</el-button></el-form-item>
      </el-form>

      <div class="table-toolbar">
        <div>
          <el-button v-if="canWrite" type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>新增种植季
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

      <el-table v-loading="loading" :data="seasons" border stripe>
        <el-table-column prop="plotCode" label="地块编码" min-width="180" />
        <el-table-column label="年份/茬次" width="130"><template #default="{ row }">{{ row.seasonYear }}年·第{{ row.seasonIndex }}茬</template></el-table-column>
        <el-table-column prop="crop" label="作物" min-width="120" />
        <el-table-column prop="variety" label="品种" min-width="110"><template #default="{ row }">{{ row.variety || '—' }}</template></el-table-column>
        <el-table-column label="栽插" width="120"><template #default="{ row }">{{ row.plantDate || '—' }}</template></el-table-column>
        <el-table-column label="采收" width="120"><template #default="{ row }">{{ row.harvestDate || '—' }}</template></el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag :type="seasonStatusType(row.status)" size="small">{{ seasonStatusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="产量(kg)" width="100"><template #default="{ row }">{{ row.yieldKg ?? '—' }}</template></el-table-column>
        <el-table-column v-if="canWrite" label="操作" width="130" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑种植季' : '新增种植季'" width="600px" @closed="resetForm">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="96px" @submit.prevent="submit">
        <el-form-item label="地块" prop="plotCode">
          <el-select v-model="form.plotCode" placeholder="选择所属地块" filterable style="width: 100%" :disabled="editing">
            <el-option v-for="p in plotOptions" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="作物" prop="crop"><el-input v-model="form.crop" placeholder="如 水稻、油菜" /></el-form-item>
        <el-form-item label="品种"><el-input v-model="form.variety" placeholder="选填" clearable /></el-form-item>
        <el-form-item label="种植年份" prop="seasonYear">
          <el-input-number v-model="form.seasonYear" :min="1900" :max="2999" :step="1" controls-position="right" style="width: 160px" />
        </el-form-item>
        <el-form-item label="茬次" prop="seasonIndex">
          <el-input-number v-model="form.seasonIndex" :min="1" :max="12" :step="1" controls-position="right" style="width: 160px" />
        </el-form-item>
        <el-form-item label="栽插日期">
          <el-date-picker v-model="form.plantDate" type="date" value-format="YYYY-MM-DD" placeholder="未定可留空" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item label="采收日期">
          <el-date-picker v-model="form.harvestDate" type="date" value-format="YYYY-MM-DD" placeholder="未收可留空" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-select v-model="form.status" style="width: 160px">
            <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="产量(kg)">
          <el-input-number v-model="form.yieldKg" :min="0" :step="10" :value-on-clear="null" controls-position="right" placeholder="未记录留空" style="width: 200px" />
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="2" placeholder="如茬口安排、倒茬原因" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">{{ editing ? '保存' : '新增' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { plotApi } from '@/api'
import { useUserStore } from '@/stores'
import type { CropSeason, CropSeasonStatus } from '@/types'

const userStore = useUserStore()
const loading = ref(false)
const rotationLoading = ref(false)
const saving = ref(false)
const seasons = ref<CropSeason[]>([])
const rotationRecords = ref<CropSeason[]>([])
const rotationPlot = ref('')
const plotOptions = ref<{ value: string; label: string }[]>([])
const query = reactive<{ plotCode: string; crop: string; year: string; status: CropSeasonStatus | '' }>({ plotCode: '', crop: '', year: '', status: '' })
const statusOptions: { value: CropSeasonStatus; label: string }[] = [
  { value: 'planned', label: '计划中' },
  { value: 'growing', label: '种植中' },
  { value: 'harvested', label: '已采收' },
]
const canWrite = computed(() => userStore.hasPermission('plot:write'))

const dialogVisible = ref(false)
const editing = ref(false)
const formRef = ref<FormInstance>()
const currentCode = ref('')
const currentYear = new Date().getFullYear()
const form = reactive({
  plotCode: '',
  crop: '',
  variety: '',
  seasonYear: currentYear,
  seasonIndex: 1,
  plantDate: '',
  harvestDate: '',
  status: 'planned' as CropSeasonStatus,
  yieldKg: null as number | null,
  note: '',
})
const formRules: FormRules = {
  plotCode: [{ required: true, message: '请选择所属地块', trigger: 'change' }],
  crop: [{ required: true, message: '请填写作物名称', trigger: 'blur' }],
  seasonYear: [{ required: true, message: '请填写种植年份', trigger: 'blur' }],
  status: [{ required: true, message: '请选择状态', trigger: 'change' }],
}

function seasonStatusText(status: CropSeasonStatus): string {
  return status === 'harvested' ? '已采收' : status === 'growing' ? '种植中' : '计划中'
}
function seasonStatusType(status: CropSeasonStatus): 'success' | 'warning' | 'info' {
  return status === 'harvested' ? 'success' : status === 'growing' ? 'warning' : 'info'
}
function seasonTimelineType(status: CropSeasonStatus): 'success' | 'primary' | 'info' {
  return status === 'harvested' ? 'success' : status === 'growing' ? 'primary' : 'info'
}
function seasonPeriod(row: CropSeason): string {
  if (row.plantDate && row.harvestDate) return `${row.plantDate} 至 ${row.harvestDate}`
  if (row.plantDate) return `${row.plantDate} 栽插`
  if (row.harvestDate) return `${row.harvestDate} 采收`
  return `${row.seasonYear}年·第${row.seasonIndex}茬（未定栽期）`
}

/** 连作提示：相邻两茬作物相同则提醒倒茬，仅是经验性提示，非权威判定 */
const rotationAdvice = computed<{ kind: 'warning' | 'success'; text: string } | null>(() => {
  const rows = rotationRecords.value
  if (rows.length < 2) return null
  let repeat = 0
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i - 1] && rows[i] && rows[i - 1]!.crop === rows[i]!.crop) repeat += 1
  }
  if (repeat > 0) return { kind: 'warning', text: `该地块有 ${repeat} 处相邻两茬种植相同作物，可能存在连作，建议结合农艺意见安排倒茬。` }
  return { kind: 'success', text: '相邻茬口作物未重复，轮作安排暂无连作提示。' }
})

async function loadPlots() {
  try {
    const result = await plotApi.getList({ page: 1, pageSize: 200 } as never)
    plotOptions.value = result.items.map((p) => ({ value: p.parcelCode, label: `${p.name}（${p.parcelCode}）` }))
  } catch { /* 列表加载失败不阻断档案浏览 */ }
}

async function load() {
  loading.value = true
  try {
    seasons.value = await plotApi.getSeasons({
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.crop ? { crop: query.crop } : {}),
      ...(query.year ? { year: query.year } : {}),
      ...(query.status ? { status: query.status } : {}),
    })
  } finally { loading.value = false }
}

async function onRotationPlot() {
  if (!rotationPlot.value) { rotationRecords.value = []; return }
  rotationLoading.value = true
  try { rotationRecords.value = await plotApi.getSeasons({ plotCode: rotationPlot.value }) }
  catch { rotationRecords.value = [] }
  finally { rotationLoading.value = false }
}

function search() { void load() }
function resetQuery() { query.plotCode = ''; query.crop = ''; query.year = ''; query.status = ''; search() }

function openCreate() {
  editing.value = false
  currentCode.value = ''
  form.plotCode = query.plotCode
  form.crop = ''
  form.variety = ''
  form.status = 'planned'
  dialogVisible.value = true
}
function openEdit(row: CropSeason) {
  editing.value = true
  currentCode.value = row.seasonCode
  form.plotCode = row.plotCode
  form.crop = row.crop
  form.variety = row.variety
  form.seasonYear = row.seasonYear
  form.seasonIndex = row.seasonIndex
  form.plantDate = row.plantDate
  form.harvestDate = row.harvestDate
  form.status = row.status
  form.yieldKg = row.yieldKg
  form.note = row.note
  dialogVisible.value = true
}
function resetForm() {
  formRef.value?.clearValidate()
  form.plotCode = ''
  form.crop = ''
  form.variety = ''
  form.seasonYear = currentYear
  form.seasonIndex = 1
  form.plantDate = ''
  form.harvestDate = ''
  form.status = 'planned'
  form.yieldKg = null
  form.note = ''
}

async function submit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (form.plantDate && form.harvestDate && form.harvestDate < form.plantDate) {
    ElMessage.error('采收日期不能早于栽插日期')
    return
  }
  saving.value = true
  try {
    const payload = {
      plotCode: form.plotCode.trim(),
      crop: form.crop.trim(),
      variety: form.variety.trim(),
      seasonYear: form.seasonYear,
      seasonIndex: form.seasonIndex,
      plantDate: form.plantDate,
      harvestDate: form.harvestDate,
      status: form.status,
      yieldKg: form.yieldKg,
      note: form.note.trim(),
    }
    if (editing.value) {
      await plotApi.updateSeason(currentCode.value, payload)
      ElMessage.success('种植季已更新')
    } else {
      await plotApi.createSeason(payload)
      ElMessage.success('种植季已新增')
    }
    dialogVisible.value = false
    await load()
    if (rotationPlot.value) await onRotationPlot()
  } finally { saving.value = false }
}

async function remove(row: CropSeason) {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.seasonYear}年第${row.seasonIndex}茬「${row.crop}」档案？`, '删除种植季', { type: 'warning' })
  } catch { return }
  await plotApi.deleteSeason(row.seasonCode)
  ElMessage.success('种植季已删除')
  await load()
  if (rotationPlot.value === row.plotCode) await onRotationPlot()
}

onMounted(async () => {
  await loadPlots()
  void load()
})
</script>

<style scoped>
.rotation { padding: 4px 0 8px; }
.rotation-title { font-size: 15px; font-weight: 600; color: #303133; }
.rotation-hint { margin: 6px 0 12px; font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }
.rotation-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.rotation-advice { margin: 8px 0 4px; }
.rotation-timeline { margin-top: 16px; padding-left: 4px; }
.rotation-node { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.rotation-crop { color: #303133; font-weight: 500; }
.rotation-yield, .rotation-note { font-size: 12px; color: var(--el-text-color-secondary); }
</style>
