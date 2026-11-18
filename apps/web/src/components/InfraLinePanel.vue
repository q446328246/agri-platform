<template>
  <div class="page-container line-list">
    <div class="card-container">
      <el-form :inline="true" @submit.prevent="reload">
        <el-form-item label="分类">
          <el-select v-model="filterCat" size="small" style="width: 120px">
            <el-option v-for="opt in lineFilterOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="keyword" size="small" style="width: 200px" placeholder="名称或编码关键字" clearable @keyup.enter="reload" />
        </el-form-item>
        <el-form-item label="归属地块">
          <el-select v-model="filterPlot" size="small" style="width: 180px" placeholder="全部地块" clearable filterable>
            <el-option label="未绑定地块" value="__none__" />
            <el-option v-for="plot in plots" :key="plot.parcelCode" :label="`${plot.parcelName}（${plot.parcelCode}）`" :value="plot.parcelCode" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filterEnabled" size="small" style="width: 100px">
            <el-option label="全部" value="" />
            <el-option label="启用" value="true" />
            <el-option label="停用" value="false" />
          </el-select>
        </el-form-item>
        <el-form-item label="模板">
          <el-select v-model="filterTemplate" size="small" style="width: 100px">
            <el-option label="全部" value="" />
            <el-option label="模板线" value="true" />
            <el-option label="普通线" value="false" />
          </el-select>
        </el-form-item>
        <el-form-item label="适用机型">
          <el-select v-model="filterMachine" size="small" style="width: 120px" placeholder="全部" clearable>
            <el-option v-for="opt in machineTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button size="small" type="primary" @click="reload">查询</el-button>
          <el-button size="small" @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
      <div class="line-summary">
        共 {{ rows.length }} 条 · 合计 {{ totalLengthM.toFixed(0) }} 米
        <span v-if="!bridge" class="line-tip">地图入口未就绪，仅可查询</span>
      </div>
    </div>

    <div class="card-container">
      <el-table v-loading="loading" :data="rows" size="small" border max-height="440" empty-text="没有符合条件的管线">
        <el-table-column prop="lineName" label="名称" min-width="150" show-overflow-tooltip />
        <el-table-column label="分类" width="92">
          <template #default="{ row }">
            <span class="line-dot" :style="{ background: lineColorOf(row.lineType) }"></span>{{ catLabel(categorize(row.lineType)) }}
          </template>
        </el-table-column>
        <el-table-column label="类型" width="150">
          <template #default="{ row }">{{ lineTypeLabel(row.lineType) }}</template>
        </el-table-column>
        <el-table-column label="长度(米)" width="104" align="right">
          <template #default="{ row }">{{ Number(row.lengthM ?? 0).toFixed(0) }}</template>
        </el-table-column>
        <el-table-column label="拐点" width="72" align="right">
          <template #default="{ row }">{{ row.geom?.coordinates?.length ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="台账属性" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ attrText(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="(row.enabled ?? true) ? 'success' : 'info'">{{ (row.enabled ?? true) ? '启用' : '停用' }}</el-tag>
            <el-tag v-if="row.isTemplate" size="small" type="warning" style="margin-left: 4px">模板</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lineCode" label="编码" width="150" show-overflow-tooltip />
        <el-table-column label="归属地块" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ plotName(row.plotCode) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="248" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="!bridge" @click="bridge?.locate(row)">定位</el-button>
            <el-button v-if="canWrite" link type="primary" size="small" :disabled="!bridge" @click="bridge?.edit(row)">编辑</el-button>
            <el-button v-if="canWrite" link type="warning" size="small" @click="toggleTemplate(row)">{{ row.isTemplate ? '取消模板' : '设模板' }}</el-button>
            <el-button v-if="canWrite && row.isTemplate" link type="primary" size="small" @click="openReuse(row)">复用</el-button>
            <el-button v-if="canWrite" link type="danger" size="small" :disabled="!bridge" @click="handleRemove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="reuseVisible" title="从模板建档" width="420px" append-to-body>
      <el-form label-width="90px" size="small">
        <el-form-item label="模板线">{{ reuseSource?.lineName }}（{{ reuseSource?.lineCode }}）</el-form-item>
        <el-form-item label="新线名称" required>
          <el-input v-model="reuseName" maxlength="40" placeholder="缺省为模板名-副本" />
        </el-form-item>
        <el-form-item label="归属地块">
          <el-select v-model="reusePlot" style="width: 100%" placeholder="沿用模板归属" clearable filterable>
            <el-option v-for="plot in plots" :key="plot.parcelCode" :label="`${plot.parcelName}（${plot.parcelCode}）`" :value="plot.parcelCode" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="reuse-tip">复制模板的走向与台账属性（宽度/限速/机型），副本自身不再是模板。</div>
      <template #footer>
        <el-button size="small" @click="reuseVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="reusing" @click="submitReuse">建档</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { plotApi } from '@/api'
import type { InfraLine, MachineType } from '@/api'
import { useUserStore } from '@/stores'
import { checkPermission } from '@/utils/permission'
import { LINE_PANEL_BRIDGE, catLabel, categorize, lineColorOf, lineFilterOptions, lineTypeLabel, machineTypeLabel, machineTypeOptions } from '@/utils/infraLine'
import type { LineFilter, LinePanelBridge } from '@/utils/infraLine'

/**
 * 管线列表面板：查询水/电/网/机耕道线路，行操作回到一张图定位与改走向。
 * 一个分类含两种线型（水线含灌水管与施肥管），后端按单一 lineType 过滤，
 * 这里一次取全量后在前端按分类与关键字筛选。
 */
const bridge = inject<LinePanelBridge | null>(LINE_PANEL_BRIDGE, null)
const userStore = useUserStore()
const canWrite = computed(() => checkPermission(userStore.permissions, 'plot:write'))

const lines = ref<InfraLine[]>([])
const plots = ref<{ parcelCode: string; parcelName: string }[]>([])
const loading = ref(false)
const filterCat = ref<LineFilter>('ALL')
const keyword = ref('')
const filterPlot = ref('')
const filterEnabled = ref('')
const filterTemplate = ref('')
const filterMachine = ref<MachineType | ''>('')

const plotNameByCode = computed(() => new Map(plots.value.map((plot) => [plot.parcelCode, plot.parcelName])))
function plotName(code?: string): string {
  if (!code) return '未绑定地块'
  return plotNameByCode.value.get(code) ?? code
}

const rows = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return lines.value.filter((line) => (filterCat.value === 'ALL' || categorize(line.lineType) === filterCat.value)
    && (text === '' || line.lineName.toLowerCase().includes(text) || line.lineCode.toLowerCase().includes(text))
    && (filterPlot.value === '' || (filterPlot.value === '__none__' ? !line.plotCode : line.plotCode === filterPlot.value))
    && (filterEnabled.value === '' || String(line.enabled ?? true) === filterEnabled.value)
    && (filterTemplate.value === '' || String(line.isTemplate ?? false) === filterTemplate.value)
    && (filterMachine.value === '' || (line.applicableMachines ?? []).includes(filterMachine.value)))
})
const totalLengthM = computed(() => rows.value.reduce((sum, line) => sum + Number(line.lengthM ?? 0), 0))

/** 台账属性摘要：未登记的项不占位，全未登记显占位符 */
function attrText(line: InfraLine): string {
  const parts: string[] = []
  if (line.widthM != null) parts.push(`宽 ${line.widthM} 米`)
  if (line.speedLimitKmh != null) parts.push(`限速 ${line.speedLimitKmh} km/h`)
  if ((line.applicableMachines ?? []).length > 0) parts.push((line.applicableMachines ?? []).map(machineTypeLabel).join('/'))
  return parts.length > 0 ? parts.join(' · ') : '—'
}

let reloadSeq = 0
async function reload() {
  const seq = ++reloadSeq
  loading.value = true
  try {
    const [list, plotPage] = await Promise.all([plotApi.getInfraLines(), plotApi.getList({ page: 1, pageSize: 200 })])
    if (seq !== reloadSeq) return
    lines.value = list
    plots.value = plotPage.items.map((item: { parcelCode: string; parcelName?: string; name?: string }) => ({
      parcelCode: item.parcelCode,
      parcelName: item.parcelName ?? item.name ?? item.parcelCode,
    }))
  } catch {
    if (seq === reloadSeq) { lines.value = []; plots.value = [] }
  } finally {
    if (seq === reloadSeq) loading.value = false
  }
}

function reset() {
  filterCat.value = 'ALL'
  keyword.value = ''
  filterPlot.value = ''
  filterEnabled.value = ''
  filterTemplate.value = ''
  filterMachine.value = ''
  void reload()
}

/** 设/取消模板：只改 isTemplate，成功后让地图重查（revision 带动本面板 reload） */
async function toggleTemplate(line: InfraLine) {
  const next = !(line.isTemplate ?? false)
  try {
    await ElMessageBox.confirm(next ? `将「${line.lineName}」设为模板？模板可供一键复制建档。` : `取消「${line.lineName}」的模板身份？已复制的副本不受影响。`, '模板设置', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
  } catch { return }
  try {
    await plotApi.updateInfraLine(line.lineCode, { isTemplate: next })
    ElMessage.success(next ? '已设为模板' : '已取消模板')
    await bridge?.refresh()
    if (!bridge) await reload()
  } catch (error: any) {
    ElMessage.error(error?.message ?? '模板设置失败')
  }
}

const reuseVisible = ref(false)
const reusing = ref(false)
const reuseSource = ref<InfraLine | null>(null)
const reuseName = ref('')
const reusePlot = ref('')

function openReuse(line: InfraLine) {
  reuseSource.value = line
  reuseName.value = `${line.lineName}-副本`
  reusePlot.value = line.plotCode ?? ''
  reuseVisible.value = true
}

async function submitReuse() {
  const source = reuseSource.value
  if (!source) return
  const name = reuseName.value.trim()
  if (!name) { ElMessage.warning('请输入新线名称'); return }
  reusing.value = true
  try {
    const created = await plotApi.createInfraLineFromTemplate({
      templateCode: source.lineCode,
      lineName: name,
      ...(reusePlot.value ? { plotCode: reusePlot.value } : {}),
    })
    ElMessage.success(`已建档「${created.lineName}」`)
    reuseVisible.value = false
    await bridge?.refresh()
    if (!bridge) await reload()
  } catch (error: any) {
    ElMessage.error(error?.message ?? '模板建档失败')
  } finally {
    reusing.value = false
  }
}

async function handleRemove(line: InfraLine) {
  if (!bridge) return
  // 二次确认与地图图层刷新都在一张图侧完成，删除成功后 revision 会带动下面的 watch 重查
  await bridge.remove(line)
}

// 面板挂在 KeepAlive 下，首次挂载也会触发 activated，不要再叠一次 onMounted
onActivated(reload)
// 改走向发生在一张图地图上，面板收不到事件只能跟着地图的加载次数重查
watch(() => bridge?.revision.value, reload)
</script>

<style scoped lang="scss">
.line-list { padding: 12px; }
.line-summary { display: flex; align-items: center; gap: 10px; margin-top: 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.line-tip { color: var(--el-color-warning); }
.line-dot { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; vertical-align: -1px; }
.reuse-tip { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
:deep(.el-form-item) { margin-bottom: 8px; }
</style>
