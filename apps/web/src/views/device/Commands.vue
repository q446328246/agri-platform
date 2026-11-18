<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="query" @submit.prevent="reload">
        <el-form-item label="地块编码">
          <el-input v-model="query.plotCode" placeholder="地块编码" clearable style="width: 170px" />
        </el-form-item>
        <el-form-item label="指令来源">
          <el-select v-model="query.origin" placeholder="全部" clearable style="width: 120px">
            <el-option label="自动" value="EVENT" />
            <el-option label="人工" value="MANUAL" />
          </el-select>
        </el-form-item>
        <el-form-item label="指令类型">
          <el-select v-model="query.type" placeholder="全部" clearable style="width: 120px">
            <el-option v-for="item in commandTypeFilterOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部" clearable style="width: 130px">
            <el-option label="已入队" value="QUEUED" />
            <el-option label="已下发" value="SENT" />
            <el-option label="设备已接收" value="ACKED" />
            <el-option label="已暂停" value="PAUSED" />
            <el-option label="执行到位" value="DONE" />
            <el-option label="失败" value="FAILED" />
            <el-option label="已取消" value="CANCELLED" />
          </el-select>
        </el-form-item>
        <el-form-item label="设备编号">
          <el-input v-model="query.deviceId" placeholder="设备 ID" clearable style="width: 170px" />
        </el-form-item>
        <el-form-item label="下达时间">
          <el-date-picker
            v-model="query.range"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            clearable
            style="width: 240px"
          />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="query.overdue">只看超时未回执</el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">查询</el-button>
          <el-button @click="reset">重置</el-button>
          <el-button v-if="canControl" @click="openAuthorizations">作业授权</el-button>
        </el-form-item>
      </el-form>

      <div class="command-hint">
        <span>自动指令由越限或处方事件生成，保留来源事件且重复投递不会重复入队；人工指令需二次确认后下达，启用作业授权后超出设备/地块/时间窗范围的下发会被拒绝。</span>
        <span>指令按「已入队 → 已下发 → 设备已接收 → 执行到位」推进，在途可被暂停后恢复；急停与断电指令的执行到位必须带设备侧到位确认。定时指令到点后才进入设备执行队列。</span>
        <span>未领取（已入队）的指令可人工取消；墒情超上限时系统自动取消该地块待执行的灌溉指令。已下发的指令平台远程关不了阀，请走急停。</span>
      </div>

      <el-table v-loading="loading" :data="commands" border stripe>
        <el-table-column prop="deviceId" label="设备编号" min-width="160" show-overflow-tooltip />
        <el-table-column prop="plotCode" label="地块编码" min-width="150" />
        <el-table-column label="指令类型" width="100">
          <template #default="{ row }">{{ getControlTypeText(row.type) }}</template>
        </el-table-column>
        <el-table-column label="来源" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="getControlOriginType(row.origin)" size="small" effect="dark">
              {{ getControlOriginText(row.origin) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getControlStatusType(row.status)" size="small">{{ getControlStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="指令缘由" min-width="220" show-overflow-tooltip />
        <el-table-column label="来源事件" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.sourceEventId" class="command-event">{{ row.sourceEventId }}</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="生命周期" min-width="190">
          <template #default="{ row }">
            <div class="command-timeline">{{ lifecycleText(row) }}</div>
            <el-tag v-if="row.overdue" type="danger" size="small" effect="plain">超时未回执 {{ row.pendingMin }} 分钟</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="定时执行" width="170">
          <template #default="{ row }">{{ row.scheduledAt ? formatDateTime(row.scheduledAt) : '—' }}</template>
        </el-table-column>
        <el-table-column label="回执说明" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ row.receiptMessage || '—' }}</template>
        </el-table-column>
        <el-table-column prop="operatorId" label="操作人" width="130" />
        <el-table-column label="下达时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column v-if="canControl" label="操作" width="160" align="center" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'QUEUED'">
              <el-button link type="primary" size="small" :loading="busyId === row.id" @click="dispatch(row)">
                标记下发
              </el-button>
              <el-button link type="danger" size="small" :loading="busyId === row.id" @click="cancel(row)">
                取消
              </el-button>
            </template>
            <el-button v-else-if="row.status === 'SENT' || row.status === 'ACKED' || row.status === 'PAUSED'" link type="warning" size="small" @click="openReceipt(row)">
              登记回执
            </el-button>
            <span v-else class="command-closed">已结单</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !commands.length" description="暂无控制指令" />

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

    <el-dialog v-model="receiptVisible" title="登记设备回执" width="520px">
      <el-form label-width="90px">
        <el-form-item label="指令">
          <span>{{ receiptTarget?.deviceId }} · {{ getControlTypeText(receiptTarget?.type) }} · 当前{{ getControlStatusText(receiptTarget?.status) }}</span>
        </el-form-item>
        <el-form-item label="回执状态">
          <el-radio-group v-model="receiptForm.status">
            <el-radio-button value="ACKED">设备已接收</el-radio-button>
            <el-radio-button v-if="receiptTarget?.status === 'SENT' || receiptTarget?.status === 'ACKED'" value="PAUSED">已暂停</el-radio-button>
            <el-radio-button value="DONE">执行到位</el-radio-button>
            <el-radio-button value="FAILED">执行失败</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="needConfirm" label="到位确认">
          <el-checkbox v-model="receiptForm.confirmed">已确认设备停止到位</el-checkbox>
          <span class="command-hint">急停/断电指令不带到位确认无法结单</span>
        </el-form-item>
        <el-form-item label="回执说明">
          <el-input
            v-model="receiptForm.message"
            type="textarea"
            :rows="2"
            maxlength="120"
            show-word-limit
            :placeholder="receiptForm.status === 'FAILED' ? '写明失败原因，必填' : '设备侧提示，可留空'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="receiptVisible = false">取消</el-button>
        <el-button type="primary" :loading="receiptSaving" :disabled="!receiptValid" @click="submitReceipt">提交回执</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="authVisible" title="作业授权范围" width="820px">
      <div class="command-hint">
        <span>授权列表为空时范围管控未启用，人工下发不受限；一旦建档，人工指令必须落在某条授权的设备/地块/时间窗内才能下发（留空表示全部）。事件自动指令不受此限。</span>
      </div>
      <el-table v-loading="authLoading" :data="authList" border stripe size="small">
        <el-table-column label="设备" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.deviceId || '全部' }}</template>
        </el-table-column>
        <el-table-column label="地块" min-width="130">
          <template #default="{ row }">{{ row.plotCode || '全部' }}</template>
        </el-table-column>
        <el-table-column label="窗口起" width="160">
          <template #default="{ row }">{{ formatDateTime(row.validFrom) }}</template>
        </el-table-column>
        <el-table-column label="窗口止" width="160">
          <template #default="{ row }">{{ formatDateTime(row.validTo) }}</template>
        </el-table-column>
        <el-table-column label="授权依据" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.note || '—' }}</template>
        </el-table-column>
        <el-table-column prop="createdBy" label="建档人" width="120" show-overflow-tooltip />
        <el-table-column label="操作" width="80" align="center">
          <template #default="{ row }">
            <el-button link type="danger" size="small" @click="removeAuthorization(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!authLoading && !authList.length" description="暂无授权，范围管控未启用" :image-size="60" />

      <el-divider content-position="left">新增授权</el-divider>
      <el-form :inline="true" label-width="80px">
        <el-form-item label="设备">
          <el-input v-model="authForm.deviceId" placeholder="留空 = 全部设备" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item label="地块">
          <el-input v-model="authForm.plotCode" placeholder="留空 = 全部地块" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="授权窗口" required>
          <el-date-picker
            v-model="authForm.range"
            type="datetimerange"
            value-format="YYYY-MM-DDTHH:mm:ss"
            range-separator="至"
            start-placeholder="窗口起"
            end-placeholder="窗口止"
            style="width: 360px"
          />
        </el-form-item>
        <el-form-item label="授权依据">
          <el-input v-model="authForm.note" placeholder="审批单号或授权说明（选填）" maxlength="200" clearable style="width: 260px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="authSaving" @click="submitAuthorization">建档授权</el-button>
        </el-form-item>
      </el-form>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { controlApi, type ControlAuthorization } from '@/api'
import { useUserStore } from '@/stores'
import {
  formatDateTime,
  getControlOriginText,
  getControlOriginType,
  getControlStatusText,
  getControlStatusType,
  getControlTypeText
} from '@/utils'

const loading = ref(false)
const commands = ref<any[]>([])
const total = ref(0)
const busyId = ref('')
const query = reactive<{
  plotCode: string
  origin: '' | 'EVENT' | 'MANUAL'
  type: string
  status: string
  deviceId: string
  range: [string, string] | null
  overdue: boolean
  page: number
  size: number
}>({
  plotCode: '',
  origin: '',
  type: '',
  status: '',
  deviceId: '',
  range: null,
  overdue: false,
  page: 1,
  size: 20
})

// 后端 /control/device/* 需要 device:control，无权限就不显示操作列，避免点开后必然 403
const userStore = useUserStore()
const canControl = computed(() => userStore.hasPermission('device:control'))

// 与服务端十一码白名单同步（迁移 050），非法枚举后端回 400
const commandTypeFilterOptions = ['SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION', 'TILLAGE', 'PAUSE', 'RESUME', 'RETURN_HOME', 'TOOL_SWITCH', 'ESTOP', 'POWER_OFF'].map((value) => ({ value, label: getControlTypeText(value) }))

/** 已走过的节点逐行铺开，未发生的阶段不占位 */
function lifecycleText(row: any): string {
  const endLabel = row.status === 'FAILED' ? '失败' : row.status === 'CANCELLED' ? '取消' : '到位'
  const marks: Array<[string, string | undefined]> = [
    ['入队', row.createdAt],
    ['下发', row.sentAt],
    ['接收', row.ackedAt],
    [endLabel, row.finishedAt]
  ]
  return marks
    .filter(([, at]) => Boolean(at))
    .map(([label, at]) => `${label} ${formatDateTime(at as string)}`)
    .join('\n')
}

async function load() {
  loading.value = true
  try {
    const result = await controlApi.getCommands({
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.origin ? { origin: query.origin } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      ...(query.range?.[0] ? { from: query.range[0] } : {}),
      ...(query.range?.[1] ? { to: query.range[1] } : {}),
      ...(query.overdue ? { overdue: true } : {}),
      page: query.page,
      size: query.size
    })
    commands.value = result.items
    total.value = result.total
  } finally {
    loading.value = false
  }
}

function reload() {
  query.page = 1
  void load()
}

function reset() {
  query.plotCode = ''
  query.origin = ''
  query.type = ''
  query.status = ''
  query.deviceId = ''
  query.range = null
  query.overdue = false
  reload()
}

async function dispatch(row: any) {
  try {
    await ElMessageBox.confirm(
      `确认把指令标记为「已下发」？这一步代表指令已送达设备 ${row.deviceId}，后续等设备回执推进。`,
      '二次确认',
      { type: 'warning', confirmButtonText: '已下发' }
    )
  } catch {
    return
  }
  busyId.value = row.id
  try {
    await controlApi.dispatchCommand(row.id)
    ElMessage.success('指令已标记下发')
    await load()
  } catch (error) {
    console.error('标记下发失败', error)
  } finally {
    busyId.value = ''
  }
}

/** 取消只撤未领取的指令；若刚被网关领取，服务端回 409，刷新列表让最新状态呈现 */
async function cancel(row: any) {
  let reason = ''
  try {
    const result = await ElMessageBox.prompt(
      `确认取消发往设备 ${row.deviceId} 的「${getControlTypeText(row.type)}」指令？取消后不再下发执行。`,
      '取消指令',
      {
        type: 'warning',
        confirmButtonText: '确认取消',
        cancelButtonText: '再想想',
        inputPlaceholder: '取消依据（选填），会记入指令回执说明',
        inputValue: ''
      }
    )
    reason = (result.value ?? '').trim()
  } catch {
    return
  }
  busyId.value = row.id
  try {
    await controlApi.cancelCommand(row.id, reason || undefined)
    ElMessage.success('指令已取消')
    await load()
  } catch (error) {
    console.error('取消指令失败', error)
    await load()
  } finally {
    busyId.value = ''
  }
}

/* ---------------- 回执登记 ---------------- */

const receiptVisible = ref(false)
const receiptSaving = ref(false)
const receiptTarget = ref<any>(null)
const receiptForm = reactive<{ status: 'ACKED' | 'PAUSED' | 'DONE' | 'FAILED'; message: string; confirmed: boolean }>({
  status: 'ACKED',
  message: '',
  confirmed: false
})

/** 急停/断电 + 执行到位 = 必须勾到位确认，与服务端 CONFIRM_REQUIRED_TYPES 同口径 */
const needConfirm = computed(() => (receiptTarget.value?.type === 'ESTOP' || receiptTarget.value?.type === 'POWER_OFF') && receiptForm.status === 'DONE')
const receiptValid = computed(() => {
  if (receiptForm.status === 'FAILED' && receiptForm.message.trim() === '') return false
  if (needConfirm.value && !receiptForm.confirmed) return false
  return true
})

function openReceipt(row: any) {
  receiptTarget.value = row
  // 已下发/已暂停的行默认登记「设备已接收」（暂停行即恢复语义），其余默认结单
  receiptForm.status = row.status === 'SENT' || row.status === 'PAUSED' ? 'ACKED' : 'DONE'
  receiptForm.message = ''
  receiptForm.confirmed = false
  receiptVisible.value = true
}

async function submitReceipt() {
  if (!receiptTarget.value || !receiptValid.value) return
  receiptSaving.value = true
  try {
    await controlApi.reportReceipt({
      commandId: receiptTarget.value.id,
      status: receiptForm.status,
      ...(receiptForm.message.trim() ? { message: receiptForm.message.trim() } : {}),
      ...(needConfirm.value ? { result: { confirmed: true } } : {})
    })
    ElMessage.success('回执已登记')
    receiptVisible.value = false
    await load()
  } catch (error) {
    console.error('回执登记失败', error)
  } finally {
    receiptSaving.value = false
  }
}

onMounted(() => void load())

/* ---------------- 作业授权（A8 范围管控） ---------------- */

const authVisible = ref(false)
const authLoading = ref(false)
const authSaving = ref(false)
const authList = ref<ControlAuthorization[]>([])
const authForm = reactive<{ deviceId: string; plotCode: string; range: [string, string] | null; note: string }>({
  deviceId: '',
  plotCode: '',
  range: null,
  note: ''
})

async function loadAuthorizations() {
  authLoading.value = true
  try {
    authList.value = await controlApi.getAuthorizations()
  } catch (error) {
    console.error('作业授权加载失败', error)
  } finally {
    authLoading.value = false
  }
}

function openAuthorizations() {
  authForm.deviceId = ''
  authForm.plotCode = ''
  authForm.range = null
  authForm.note = ''
  authVisible.value = true
  void loadAuthorizations()
}

async function submitAuthorization() {
  if (!authForm.range?.[0] || !authForm.range?.[1]) {
    ElMessage.warning('请选择授权时间窗口')
    return
  }
  const validFrom = new Date(authForm.range[0])
  const validTo = new Date(authForm.range[1])
  if (!(validTo.getTime() > validFrom.getTime())) {
    ElMessage.warning('窗口止必须晚于窗口起')
    return
  }
  authSaving.value = true
  try {
    await controlApi.createAuthorization({
      ...(authForm.deviceId.trim() ? { deviceId: authForm.deviceId.trim() } : {}),
      ...(authForm.plotCode.trim() ? { plotCode: authForm.plotCode.trim() } : {}),
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      ...(authForm.note.trim() ? { note: authForm.note.trim() } : {})
    })
    ElMessage.success('授权已建档，人工下发将按范围校验')
    authForm.deviceId = ''
    authForm.plotCode = ''
    authForm.range = null
    authForm.note = ''
    await loadAuthorizations()
  } catch (error) {
    console.error('授权建档失败', error)
  } finally {
    authSaving.value = false
  }
}

async function removeAuthorization(row: ControlAuthorization) {
  try {
    await ElMessageBox.confirm(
      `确认删除该条授权？删空后范围管控回到未启用状态，人工下发不再受限。`,
      '删除授权',
      { type: 'warning', confirmButtonText: '确认删除' }
    )
  } catch {
    return
  }
  try {
    await controlApi.deleteAuthorization(row.id)
    ElMessage.success('授权已删除')
    await loadAuthorizations()
  } catch (error) {
    console.error('授权删除失败', error)
  }
}
</script>

<style scoped>
.command-hint {
  margin-bottom: 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.command-hint span {
  display: block;
}

.command-timeline {
  white-space: pre-line;
  font-size: 12px;
  line-height: 1.6;
}

.command-closed {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.command-event {
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 12px;
}
</style>
