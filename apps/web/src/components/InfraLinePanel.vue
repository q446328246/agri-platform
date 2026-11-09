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
        <el-table-column prop="lineCode" label="编码" width="150" show-overflow-tooltip />
        <el-table-column label="操作" width="168" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="!bridge" @click="bridge?.locate(row)">定位</el-button>
            <el-button v-if="canWrite" link type="primary" size="small" :disabled="!bridge" @click="bridge?.edit(row)">编辑</el-button>
            <el-button v-if="canWrite" link type="danger" size="small" :disabled="!bridge" @click="handleRemove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, ref, watch } from 'vue'
import { plotApi } from '@/api'
import type { InfraLine } from '@/api'
import { useUserStore } from '@/stores'
import { checkPermission } from '@/utils/permission'
import { LINE_PANEL_BRIDGE, catLabel, categorize, lineColorOf, lineFilterOptions, lineTypeLabel } from '@/utils/infraLine'
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
const loading = ref(false)
const filterCat = ref<LineFilter>('ALL')
const keyword = ref('')

const rows = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return lines.value.filter((line) => (filterCat.value === 'ALL' || categorize(line.lineType) === filterCat.value)
    && (text === '' || line.lineName.toLowerCase().includes(text) || line.lineCode.toLowerCase().includes(text)))
})
const totalLengthM = computed(() => rows.value.reduce((sum, line) => sum + Number(line.lengthM ?? 0), 0))

let reloadSeq = 0
async function reload() {
  const seq = ++reloadSeq
  loading.value = true
  try {
    const list = await plotApi.getInfraLines()
    if (seq === reloadSeq) lines.value = list
  } catch {
    if (seq === reloadSeq) lines.value = []
  } finally {
    if (seq === reloadSeq) loading.value = false
  }
}

function reset() {
  filterCat.value = 'ALL'
  keyword.value = ''
  void reload()
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
:deep(.el-form-item) { margin-bottom: 8px; }
</style>
