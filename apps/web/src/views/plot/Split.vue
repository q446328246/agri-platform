<template>
  <div class="page-container">
    <div v-loading="loading" class="card-container">
      <template v-if="source">
        <div class="split-header">
          <h3>拆分地块 · {{ source.name }}（{{ source.parcelCode }}）</h3>
          <el-button @click="router.back()">返回</el-button>
        </div>
        <el-alert type="warning" :closable="false" class="split-alert">
          拆分将按你逐块绘制的边界生成新地块，面积一律以各自边界现算；原地块默认整块归档（可勾选保留）。
          子地块要沿原边界切开：边界重叠或画出原地块会让合计面积超过原地块，此时无法提交。
        </el-alert>
        <div class="split-summary">
          <span>原地块台账面积：<b>{{ sourceAreaMu.toFixed(2) }}</b> 亩</span>
          <span>子地块合计：<b :class="{ 'split-over': overSourceArea }">{{ pieceAreaSum.toFixed(2) }}</b> 亩</span>
          <span v-if="overSourceArea" class="split-over">合计已超过原地块，请检查边界是否重叠或画出原地块</span>
        </div>

        <div class="split-tabs">
          <div class="split-tabs__list">
            <button
              v-for="(piece, index) in pieces"
              :key="index"
              type="button"
              class="split-tab"
              :class="{ 'split-tab--active': index === activeIndex }"
              @click="activeIndex = index"
            >
              第 {{ index + 1 }} 块
              <span class="split-tab__area">{{ piece.areaMu.toFixed(2) }} 亩</span>
            </button>
            <el-button size="small" @click="addPiece">新增子地块</el-button>
            <el-button size="small" :disabled="pieces.length <= 2" @click="removeActivePiece">删除当前块</el-button>
          </div>
          <div class="split-tabs__form">
            <el-input v-model="activePiece.name" size="small" placeholder="子地块名称（留空按「原名称-序号」生成）" class="split-name" />
          </div>
        </div>

        <PlotPolygonEditor
          :key="activeIndex"
          v-model="activePiece.coordinates"
          @area-change="handlePieceArea(activeIndex, $event)"
        />
        <div class="split-editor-hint">
          正在绘制第 {{ activeIndex + 1 }} 块（{{ activePiece.name || `子地块 ${activeIndex + 1}` }}）。
          切换子地块不会丢失已绘制的顶点；单击地图加顶点，至少 3 点自动闭合。
        </div>

        <div class="split-actions">
          <el-checkbox v-model="keepSource">保留原地块（默认拆分后归档原边界）</el-checkbox>
          <div>
            <el-button type="primary" :loading="submitting" :disabled="overSourceArea" @click="handleSplit">确认拆分</el-button>
            <el-button @click="router.back()">取消</el-button>
          </div>
        </div>
      </template>
      <el-empty v-else-if="!loading" description="该地块暂无边界几何，请先在编辑页补画边界再拆分">
        <el-button type="primary" @click="router.push(`/plot/edit/${route.params.id}`)">去编辑页补边界</el-button>
      </el-empty>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PlotPolygonEditor from '@/components/PlotPolygonEditor.vue'
import { plotApi, toPolygonGeom } from '@/api'
import { parsePlotBoundary, polygonAreaMu, type PlotBoundarySource } from '@/utils/geo'
import type { Plot } from '@/types'

interface SplitPiece {
  name: string
  coordinates: [number, number][]
  areaMu: number
}

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const submitting = ref(false)
const source = ref<Plot | null>(null)
const activeIndex = ref(0)
const keepSource = ref(false)

/** 子地块顶点存在各自 piece 里，切换编辑目标只换挂载的编辑器实例，画过的点不丢。 */
const pieces = reactive<SplitPiece[]>([
  { name: '', coordinates: [], areaMu: 0 },
  { name: '', coordinates: [], areaMu: 0 },
])

// 服务端逐块校验用的就是台账面积，前端预检沿用同一口径，避免"前端放行、后端拒绝"
const sourceAreaMu = computed(() => Number(source.value?.areaMu ?? 0))
const pieceAreaSum = computed(() => pieces.reduce((total, piece) => total + piece.areaMu, 0))
// 与服务端同口径：每块各自两位小数进位，允许 pieces × 0.01 亩舍入余量
const pieceAreaSlack = computed(() => 0.01 * pieces.length)
const overSourceArea = computed(() => pieceAreaSum.value > sourceAreaMu.value + pieceAreaSlack.value)
// activeIndex 只在列表内切换且删除时钳制，取不到只可能出现在渲染瞬间，兜到首块即可
const activePiece = computed(() => pieces[activeIndex.value] ?? pieces[0]!)

function handlePieceArea(index: number, area: number) {
  const piece = pieces[index]
  if (piece) piece.areaMu = Number(area.toFixed(2))
}

function addPiece() {
  pieces.push({ name: '', coordinates: [], areaMu: 0 })
  activeIndex.value = pieces.length - 1
}

function removeActivePiece() {
  if (pieces.length <= 2) return
  pieces.splice(activeIndex.value, 1)
  activeIndex.value = Math.min(activeIndex.value, pieces.length - 1)
}

function validatePieces(): string | null {
  if (pieces.length < 2) return '至少需要两块子地块边界'
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]!
    if (piece.coordinates.length < 3) return `第 ${i + 1} 块边界不足 3 个顶点`
    if (piece.areaMu <= 0) return `第 ${i + 1} 块面积为 0，请检查边界`
    if (piece.areaMu > sourceAreaMu.value + 0.01) {
      return `第 ${i + 1} 块面积 ${piece.areaMu.toFixed(2)} 亩超过原地块 ${sourceAreaMu.value.toFixed(2)} 亩`
    }
  }
  if (overSourceArea.value) {
    return `子地块合计 ${pieceAreaSum.value.toFixed(2)} 亩超过原地块 ${sourceAreaMu.value.toFixed(2)} 亩，请检查边界是否重叠或画出原地块`
  }
  return null
}

async function loadSource() {
  loading.value = true
  try {
    const res = await plotApi.getById(route.params.id as string)
    source.value = res
    const boundary = parsePlotBoundary(res as unknown as PlotBoundarySource)
    const ring = boundary?.rings[0]
    if (!ring) return
    // 只把原边界塞给第一块作参照：每块都复制整份原边界的话，
    // 用户只改其中一块就会让合计面积凭空翻倍，拆分前踩到过
    const first = pieces[0]!
    first.coordinates = ring.map(([lat, lng]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))] as [number, number])
    first.areaMu = Number(polygonAreaMu(first.coordinates).toFixed(2))
  } catch (error) {
    console.error('加载地块失败', error)
  } finally {
    loading.value = false
  }
}

async function handleSplit() {
  if (!source.value) return
  const problem = validatePieces()
  if (problem) {
    ElMessage.warning(problem)
    return
  }
  const lines = pieces.map((piece, index) => `第 ${index + 1} 块：${piece.name || `子地块 ${index + 1}`} · ${piece.areaMu.toFixed(2)} 亩`)
  const archiveTip = keepSource.value
    ? `原地块 ${source.value.parcelCode} 保留不归档。`
    : `原地块 ${source.value.parcelCode}（${sourceAreaMu.value.toFixed(2)} 亩）将被归档。`
  try {
    await ElMessageBox.confirm(
      `${lines.join('\n')}\n\n${archiveTip}拆分后台账面积按各自边界现算，管线与种植季不会自动迁移。`,
      '确认拆分',
      { type: 'warning', confirmButtonText: '确认拆分', cancelButtonText: '再检查下' },
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    const result = await plotApi.split({
      parcelCode: source.value.parcelCode,
      pieces: pieces.map((piece) => ({
        parcelName: piece.name,
        geom: toPolygonGeom(piece.coordinates),
      })),
      keepSource: keepSource.value,
    })
    ElMessage.success(`拆分完成：${result.plots.map((plot) => `${plot.parcelCode}（${plot.areaMu.toFixed(2)} 亩）`).join('、')}`)
    router.back()
  } catch (error) {
    console.error('拆分失败', error)
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  loadSource()
})
</script>

<style scoped lang="scss">
.split-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.split-alert {
  margin-bottom: 12px;
}

.split-summary {
  display: flex;
  gap: 24px;
  margin-bottom: 12px;
  color: #606266;
  font-size: 13px;
}

.split-over {
  color: #e6a23c;
  font-weight: 600;
}

.split-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.split-tabs__list {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.split-tab {
  padding: 4px 10px;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  background: #fff;
  color: #606266;
  font-size: 12px;
  cursor: pointer;

  &--active {
    border-color: #409eff;
    color: #409eff;
    background: rgba(64, 158, 255, 0.08);
  }
}

.split-tab__area {
  margin-left: 6px;
  color: #909399;
}

.split-tab--active .split-tab__area {
  color: #409eff;
}

.split-name {
  width: 320px;
}

.split-editor-hint {
  margin: 6px 0 12px;
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}

.split-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
