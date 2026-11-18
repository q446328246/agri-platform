<template>
  <div class="m-page">
    <div class="m-chips">
      <button v-for="chip in statusChips" :key="chip.value" class="m-chip" :class="{ active: filterStatus === chip.value }" @click="setStatus(chip.value)">
        {{ chip.label }}
      </button>
    </div>

    <div class="m-card">
      <div class="m-card__title">
        农事任务（{{ total }}）
        <button class="m-link" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
      <div v-if="loading && !tasks.length" class="m-loading">加载中…</div>
      <div v-else-if="!tasks.length" class="m-empty">暂无任务</div>
      <div v-for="task in tasks" :key="task.id" class="m-item" @click="openDetail(task)">
        <div class="m-item__head">
          <span class="m-item__title">{{ task.name }}</span>
          <span class="m-tag" :class="statusClass(task.status)">{{ TASK_STATUS_LABELS[task.status] ?? task.status }}</span>
        </div>
        <div class="m-item__meta">
          {{ TASK_TYPE_LABELS[task.type] ?? task.type }} · {{ task.plotCode }}<br />
          {{ task.assigneeName || '未指派' }} · 计划 {{ shortTime(task.scheduledAt) }}
        </div>
      </div>
    </div>

    <div v-if="current" class="m-sheet-mask" @click.self="closeDetail">
      <div class="m-sheet">
        <div class="m-sheet__title">
          {{ current.name }}
          <button class="m-sheet__close" @click="closeDetail">✕</button>
        </div>
        <div class="m-item__meta" style="margin-bottom: 10px">
          类型：{{ TASK_TYPE_LABELS[current.type] ?? current.type }} · 状态：{{ TASK_STATUS_LABELS[current.status] ?? current.status }}<br />
          地块：{{ current.plotCode }} · 执行人：{{ current.assigneeName || '未指派' }}<br />
          计划：{{ shortTime(current.scheduledAt) }} ~ {{ shortTime(current.scheduledEndAt) }}
        </div>

        <template v-if="current.status === 'RUNNING' && showReceipt">
          <div class="m-field">
            <label class="m-field__label">作业结果</label>
            <select v-model="receipt.outcome" class="m-select">
              <option value="success">成功完成</option>
              <option value="partial">部分完成</option>
              <option value="failed">作业失败</option>
            </select>
          </div>
          <div class="m-field">
            <label class="m-field__label">完成面积（亩）</label>
            <input v-model.number="receipt.finishedAreaMu" class="m-input" type="number" min="0" step="0.1" />
          </div>
          <div class="m-field">
            <label class="m-field__label">回执说明</label>
            <textarea v-model.trim="receipt.notes" class="m-textarea" maxlength="500" placeholder="作业情况、异常与备注"></textarea>
          </div>
        </template>

        <div v-if="current.result" class="m-item__detail" style="margin-bottom: 10px">
          回执：{{ outcomeLabel(current.result.outcome) }} · 完成 {{ current.result.finishedAreaMu }} 亩<br />
          {{ current.result.notes || '无备注' }}
        </div>

        <div v-if="canWrite && (current.status === 'PENDING' || current.status === 'RUNNING')" class="m-actions">
          <template v-if="current.status === 'PENDING'">
            <button class="m-btn m-btn--danger" :disabled="busy" @click="changeStatus('CANCELLED')">取消任务</button>
            <button class="m-btn" :disabled="busy" @click="changeStatus('RUNNING')">开工</button>
          </template>
          <template v-else-if="!showReceipt">
            <button class="m-btn m-btn--danger" :disabled="busy" @click="changeStatus('CANCELLED')">取消任务</button>
            <button class="m-btn" @click="showReceipt = true">提交回执</button>
          </template>
          <template v-else>
            <button class="m-btn m-btn--ghost" :disabled="busy" @click="showReceipt = false">返回</button>
            <button class="m-btn" :disabled="busy || !receiptValid" @click="submitReceipt">{{ busy ? '提交中…' : '完成并提交' }}</button>
          </template>
        </div>
        <p v-else-if="current.status === 'PENDING' || current.status === 'RUNNING'" class="m-muted" style="margin-top: 10px">当前账号无任务操作权限，仅可查看</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, shortTime, showToast } from '../api'
import { hasPerm } from '../auth'
import { TASK_STATUS_LABELS, TASK_TYPE_LABELS } from '../labels'
import type { FarmTask, TaskStatus } from '../types'

const statusChips: Array<{ value: TaskStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'PENDING', label: '待执行' },
  { value: 'RUNNING', label: '进行中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' }
]

const tasks = ref<FarmTask[]>([])
const total = ref(0)
const loading = ref(false)
const filterStatus = ref<TaskStatus | ''>('')
const current = ref<FarmTask | null>(null)
const showReceipt = ref(false)
const busy = ref(false)
const receipt = reactive<{ outcome: 'success' | 'partial' | 'failed'; finishedAreaMu: number; notes: string }>({ outcome: 'success', finishedAreaMu: 0, notes: '' })

const canWrite = hasPerm('operation:write')
const receiptValid = computed(() => Number.isFinite(receipt.finishedAreaMu) && receipt.finishedAreaMu >= 0)

function statusClass(status: TaskStatus): string {
  if (status === 'COMPLETED') return 'm-tag--green'
  if (status === 'RUNNING') return 'm-tag--blue'
  if (status === 'CANCELLED') return 'm-tag--gray'
  return 'm-tag--amber'
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'success') return '成功完成'
  if (outcome === 'partial') return '部分完成'
  return '作业失败'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await api.tasks(filterStatus.value ? { status: filterStatus.value } : undefined)
    tasks.value = result.items
    total.value = result.total
    // 弹层开着时同步最新版本号，避免拿旧 version 提交撞 409
    if (current.value) {
      current.value = result.items.find((task) => task.id === current.value?.id) ?? null
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载失败', 'err')
  } finally {
    loading.value = false
  }
}

function setStatus(value: TaskStatus | ''): void {
  filterStatus.value = value
  void load()
}

function openDetail(task: FarmTask): void {
  current.value = task
  showReceipt.value = false
  receipt.outcome = 'success'
  receipt.finishedAreaMu = 0
  receipt.notes = ''
}

function closeDetail(): void {
  current.value = null
  showReceipt.value = false
}

/** 状态流转失败（含 409 版本冲突）统一提示并重载，弹层内版本号随之刷新 */
async function changeStatus(status: TaskStatus): Promise<void> {
  if (!current.value) return
  busy.value = true
  try {
    const updated = await api.taskStatus(current.value.id, status, current.value.version)
    showToast(status === 'RUNNING' ? '已开工' : '任务已取消', 'ok')
    current.value = updated
    await load()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '操作失败，已刷新最新状态', 'err')
    await load()
  } finally {
    busy.value = false
  }
}

async function submitReceipt(): Promise<void> {
  if (!current.value) return
  busy.value = true
  try {
    const updated = await api.taskStatus(current.value.id, 'COMPLETED', current.value.version, {
      outcome: receipt.outcome,
      finishedAreaMu: receipt.finishedAreaMu,
      notes: receipt.notes
    })
    showToast('回执已提交，任务完成', 'ok')
    current.value = updated
    showReceipt.value = false
    await load()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '提交失败，已刷新最新状态', 'err')
    await load()
  } finally {
    busy.value = false
  }
}

onMounted(() => void load())
</script>