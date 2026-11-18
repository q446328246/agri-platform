<template>
  <div class="m-page">
    <div class="m-card">
      <div class="m-field">
        <label class="m-field__label">地块</label>
        <select v-model="filterPlot" class="m-select" @change="load">
          <option value="">全部地块</option>
          <option v-for="plot in plots" :key="plot.parcelCode" :value="plot.parcelCode">{{ plot.parcelName }}（{{ plot.parcelCode }}）</option>
        </select>
      </div>
      <div class="m-field" style="margin-bottom: 0">
        <label class="m-field__label">事件类型</label>
        <select v-model="filterEvent" class="m-select" @change="load">
          <option value="">全部事件</option>
          <option v-for="(label, code) in TRACE_EVENT_LABELS" :key="code" :value="code">{{ label }}</option>
        </select>
      </div>
    </div>

    <div class="m-card">
      <div class="m-card__title">
        巡田记录（{{ total }}）
        <button v-if="canWrite" class="m-btn m-btn--small" @click="openForm">巡田登记</button>
      </div>
      <div v-if="loading" class="m-loading">加载中…</div>
      <div v-else-if="!records.length" class="m-empty">暂无巡田记录</div>
      <div v-for="record in records" :key="record.id" class="m-item">
        <div class="m-item__head">
          <span class="m-tag m-tag--green">{{ TRACE_EVENT_LABELS[record.event] ?? record.event }}</span>
          <span class="m-item__title">{{ record.plotCode }}</span>
        </div>
        <div class="m-item__detail">{{ record.detail }}</div>
        <div class="m-item__meta">{{ record.operator }} · {{ shortTime(record.createdAt) }} · {{ record.traceCode }}</div>
      </div>
      <div v-if="page < pages" style="text-align: center; padding-top: 10px">
        <button class="m-btn m-btn--ghost m-btn--small" :disabled="loading" @click="loadMore">加载更多</button>
      </div>
    </div>

    <div v-if="formVisible" class="m-sheet-mask" @click.self="formVisible = false">
      <div class="m-sheet">
        <div class="m-sheet__title">
          巡田登记
          <button class="m-sheet__close" @click="formVisible = false">✕</button>
        </div>
        <div class="m-field">
          <label class="m-field__label">地块（必选）</label>
          <select v-model="form.plotCode" class="m-select">
            <option value="" disabled>请选择地块</option>
            <option v-for="plot in plots" :key="plot.parcelCode" :value="plot.parcelCode">{{ plot.parcelName }}（{{ plot.parcelCode }}）</option>
          </select>
        </div>
        <div class="m-field">
          <label class="m-field__label">事件类型</label>
          <select v-model="form.event" class="m-select">
            <option v-for="code in MANUAL_TRACE_EVENTS" :key="code" :value="code">{{ TRACE_EVENT_LABELS[code] }}</option>
          </select>
        </div>
        <div class="m-field">
          <label class="m-field__label">巡田详情（必填）</label>
          <textarea v-model.trim="form.detail" class="m-textarea" maxlength="500" placeholder="长势、病虫害、墒情等现场情况"></textarea>
        </div>
        <p class="m-muted">登记人：{{ session.user?.name || session.user?.username }}；灌溉/施肥完成由设备结单自动写入，不在此登记</p>
        <div class="m-actions">
          <button class="m-btn m-btn--ghost" @click="formVisible = false">取消</button>
          <button class="m-btn" :disabled="busy || !form.plotCode || !form.detail" @click="submit">{{ busy ? '提交中…' : '提交登记' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { api, shortTime, showToast } from '../api'
import { hasPerm, session } from '../auth'
import { MANUAL_TRACE_EVENTS, TRACE_EVENT_LABELS } from '../labels'
import type { PlotItem, TraceRecord } from '../types'

const plots = ref<PlotItem[]>([])
const records = ref<TraceRecord[]>([])
const total = ref(0)
const page = ref(1)
const pages = ref(1)
const loading = ref(false)
const filterPlot = ref('')
const filterEvent = ref('')

const canWrite = hasPerm('trace:write')
const formVisible = ref(false)
const busy = ref(false)
const form = reactive({ plotCode: '', event: MANUAL_TRACE_EVENTS[0] ?? 'FARM_OPERATION', detail: '' })

async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await api.traceRecords({ plotCode: filterPlot.value, event: filterEvent.value, page: 1 })
    records.value = result.items
    total.value = result.total
    page.value = result.page
    pages.value = result.pages
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载失败', 'err')
  } finally {
    loading.value = false
  }
}

async function loadMore(): Promise<void> {
  loading.value = true
  try {
    const result = await api.traceRecords({ plotCode: filterPlot.value, event: filterEvent.value, page: page.value + 1 })
    records.value = [...records.value, ...result.items]
    page.value = result.page
    pages.value = result.pages
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载失败', 'err')
  } finally {
    loading.value = false
  }
}

function openForm(): void {
  form.plotCode = filterPlot.value || ''
  form.detail = ''
  formVisible.value = true
}

async function submit(): Promise<void> {
  busy.value = true
  try {
    await api.createTrace({
      plotCode: form.plotCode,
      event: form.event,
      detail: form.detail,
      operator: session.user?.name || session.user?.username || ''
    })
    showToast('巡田登记已提交', 'ok')
    formVisible.value = false
    await load()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '提交失败', 'err')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    const result = await api.plots()
    plots.value = result.items
  } catch {
    // 地块下拉失败不阻断记录浏览，登记表单里会提示重选
  }
  await load()
})
</script>