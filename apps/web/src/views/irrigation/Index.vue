<template>
  <div class="page-container">
    <el-row :gutter="16">
      <el-col :span="11">
        <div class="card-container">
          <div class="section-head"><h4>灌溉参数</h4><el-button link type="primary" @click="addZone">增加分区</el-button></div>
          <el-form label-width="96px">
            <el-form-item label="地块编码"><el-input v-model="form.plotCode" placeholder="选填，用于关联灌溉指令" /></el-form-item>
            <el-form-item label="供水流量">
              <el-input-number v-model="form.flowM3h" :min="1" :max="500" :step="1" />
              <span class="hint">立方米/小时</span>
            </el-form-item>
            <el-form-item label="执行设备"><el-input v-model="form.deviceId" placeholder="阀门或首部控制器标识" /></el-form-item>
          </el-form>

          <el-table :data="form.zones" border size="small" class="zone-table">
            <el-table-column label="分区" width="120"><template #default="{ row }"><el-input v-model="row.zoneCode" placeholder="自动编号" /></template></el-table-column>
            <el-table-column label="面积（亩）" width="130"><template #default="{ row }"><el-input-number v-model="row.areaMu" :min="0.1" :max="10000" :step="0.5" size="small" /></template></el-table-column>
            <el-table-column label="定额（毫米）" width="130"><template #default="{ row }"><el-input-number v-model="row.targetMm" :min="1" :max="100" :step="1" size="small" /></template></el-table-column>
            <el-table-column label="操作" width="70"><template #default="{ $index }"><el-button link type="danger" @click="removeZone($index)">删除</el-button></template></el-table-column>
          </el-table>

          <div class="section-head mt-16"><h4>水肥配比</h4><el-switch v-model="form.withRecipe" active-text="按配比施肥" /></div>
          <el-form v-if="form.withRecipe" label-width="96px">
            <el-form-item label="氮（kg/亩）"><el-input-number v-model="form.recipe.nitrogen" :min="0" :max="100" :step="0.5" /></el-form-item>
            <el-form-item label="磷（kg/亩）"><el-input-number v-model="form.recipe.phosphorus" :min="0" :max="100" :step="0.5" /></el-form-item>
            <el-form-item label="钾（kg/亩）"><el-input-number v-model="form.recipe.potassium" :min="0" :max="100" :step="0.5" /></el-form-item>
            <el-form-item label="搅拌时长"><el-input-number v-model="form.stir.durationMin" :min="1" :max="120" :step="1" /><span class="hint">分钟</span></el-form-item>
            <el-form-item label="搅拌转速"><el-input-number v-model="form.stir.rpm" :min="0" :max="300" :step="10" /><span class="hint">转/分</span></el-form-item>
          </el-form>

          <div class="actions">
            <el-button type="primary" :loading="calculating" @click="calculate">生成方案</el-button>
            <el-button :disabled="!plan" :loading="dispatching" @click="dispatch">下发灌溉指令</el-button>
          </div>
        </div>
      </el-col>

      <el-col :span="13">
        <div class="card-container">
          <div class="section-head"><h4>方案预演</h4><span v-if="plan" class="hint">流量 {{ plan.flowM3h }} m³/h · 采样间隔 5 分钟</span></div>
          <el-empty v-if="!plan" description="填写分区面积与灌水定额后生成方案" />
          <template v-else>
            <el-row :gutter="12" class="plan-metrics">
              <el-col :span="6"><div class="plan-metric"><span>总面积</span><strong>{{ plan.totalAreaMu }}</strong><small>亩</small></div></el-col>
              <el-col :span="6"><div class="plan-metric"><span>总用水量</span><strong>{{ plan.totalWaterVolume }}</strong><small>m³</small></div></el-col>
              <el-col :span="6"><div class="plan-metric"><span>总时长</span><strong>{{ plan.totalDurationMin }}</strong><small>分钟</small></div></el-col>
              <el-col :span="6"><div class="plan-metric"><span>施肥总量</span><strong>{{ plan.recipe ? plan.recipe.totalKg : '—' }}</strong><small>kg</small></div></el-col>
            </el-row>
            <el-alert v-for="warning in plan.warnings" :key="warning" :title="warning" type="warning" :closable="false" show-icon class="plan-warning" />
            <v-chart class="chart" :option="chartOption" autoresize />
            <el-table :data="plan.zones" border size="small">
              <el-table-column prop="zoneCode" label="分区" width="110" />
              <el-table-column prop="areaMu" label="面积（亩）" width="110" />
              <el-table-column prop="targetMm" label="定额（毫米）" width="120" />
              <el-table-column prop="waterVolume" label="用水量（m³）" width="130" />
              <el-table-column prop="startMin" label="开始（分钟）" width="120" />
              <el-table-column prop="endMin" label="结束（分钟）" width="120" />
              <el-table-column label="时长（分钟）"><template #default="{ row }">{{ row.durationMin }}</template></el-table-column>
            </el-table>
            <div v-if="plan.recipe" class="recipe-line">
              配比 氮 {{ plan.recipe.nitrogen }} : 磷 {{ plan.recipe.phosphorus }} : 钾 {{ plan.recipe.potassium }} kg/亩
              <span v-if="plan.stir">，搅拌 {{ plan.stir.durationMin }} 分钟 @ {{ plan.stir.rpm }} 转/分</span>
            </div>
          </template>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components'
import { controlApi } from '@/api'
import type { IrrigationPlan } from '@/api'

/**
 * 水肥配比与变量灌溉页。
 *
 * 分区按「面积 × 灌水定额」换算用水量，服务端按供水流量排阀门时序并返回累计供水曲线；
 * 这里的方案只做预演，确认后再用水肥参数下发控制指令，避免误灌。
 */

use([CanvasRenderer, LineChart, BarChart, TooltipComponent, LegendComponent, GridComponent])

const form = reactive({
  plotCode: '',
  flowM3h: 20,
  deviceId: 'device-valve-001',
  withRecipe: false,
  zones: [
    { zoneCode: 'A', areaMu: 10, targetMm: 10 },
    { zoneCode: 'B', areaMu: 5, targetMm: 20 },
  ] as Array<{ zoneCode: string; areaMu: number; targetMm: number }>,
  recipe: { nitrogen: 2, phosphorus: 1, potassium: 1 },
  stir: { durationMin: 15, rpm: 60 },
})

const plan = ref<IrrigationPlan | null>(null)
const calculating = ref(false)
const dispatching = ref(false)

const chartOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['累计供水 (m³)', '瞬时流量 (m³/h)'], bottom: 0 },
  grid: { left: '3%', right: '4%', bottom: '16%', containLabel: true },
  xAxis: { type: 'category', name: '分钟', data: plan.value?.curve.map((point) => point.minute) ?? [] },
  yAxis: [
    { type: 'value', name: 'm³' },
    { type: 'value', name: 'm³/h' },
  ],
  series: [
    { name: '累计供水 (m³)', type: 'line', smooth: true, areaStyle: {}, data: plan.value?.curve.map((point) => point.cumulativeM3) ?? [] },
    { name: '瞬时流量 (m³/h)', type: 'bar', yAxisIndex: 1, barWidth: '40%', data: plan.value?.curve.map((point) => point.flowM3h) ?? [] },
  ],
}))

function addZone() {
  form.zones.push({ zoneCode: `ZONE-${form.zones.length + 1}`, areaMu: 5, targetMm: 10 })
}

function removeZone(index: number) {
  form.zones.splice(index, 1)
}

async function calculate() {
  if (form.zones.length === 0) {
    ElMessage.warning('至少需要一个灌溉分区')
    return
  }
  calculating.value = true
  try {
    plan.value = await controlApi.buildIrrigationPlan({
      ...(form.plotCode ? { plotCode: form.plotCode } : {}),
      flowM3h: form.flowM3h,
      zones: form.zones.map((zone) => ({ ...zone })),
      ...(form.withRecipe ? { recipe: { ...form.recipe }, stir: { ...form.stir } } : {}),
    })
  } catch (error) {
    plan.value = null
    ElMessage.error(error instanceof Error ? error.message : '方案生成失败')
  } finally {
    calculating.value = false
  }
}

async function dispatch() {
  if (!plan.value) return
  if (!form.deviceId.trim()) {
    ElMessage.warning('请填写执行设备标识')
    return
  }
  dispatching.value = true
  try {
    await controlApi.sendCommand({
      deviceId: form.deviceId,
      ...(form.plotCode ? { plotCode: form.plotCode } : {}),
      type: form.withRecipe ? 'FERTILIZATION' : 'IRRIGATION',
      parameters: {
        zones: plan.value.zones.map((zone) => ({ zoneCode: zone.zoneCode, areaMu: zone.areaMu, targetMm: zone.targetMm })),
        flowM3h: plan.value.flowM3h,
        ...(plan.value.recipe ? { recipe: { nitrogen: plan.value.recipe.nitrogen, phosphorus: plan.value.recipe.phosphorus, potassium: plan.value.recipe.potassium } } : {}),
        ...(plan.value.stir ? { stir: plan.value.stir } : {}),
      },
    })
    ElMessage.success('灌溉指令已进入执行队列')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '指令下发失败')
  } finally {
    dispatching.value = false
  }
}
</script>

<style scoped lang="scss">
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.section-head h4 { margin: 0; color: #303133; font-size: 15px; }
.hint { margin-left: 8px; color: #909399; font-size: 12px; }
.zone-table { margin-bottom: 4px; }
.actions { display: flex; gap: 12px; margin-top: 18px; }
.plan-metrics { margin-bottom: 12px; }
.plan-metric { display: flex; flex-direction: column; gap: 4px; padding: 12px; background: #f5f7fa; border-radius: 4px; }
.plan-metric span { color: #606266; font-size: 12px; }
.plan-metric strong { color: #303133; font-size: 20px; font-variant-numeric: tabular-nums; }
.plan-metric small { color: #909399; font-size: 11px; }
.plan-warning { margin-bottom: 10px; }
.chart { height: 240px; margin-bottom: 12px; }
.recipe-line { margin-top: 10px; color: #606266; font-size: 13px; }
.mt-16 { margin-top: 16px; }
</style>
