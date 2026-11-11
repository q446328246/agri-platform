<template>
  <div class="page-container">
    <div class="card-container">
      <div class="search-bar">
        <el-form :inline="true" :model="queryForm" @submit.prevent="handleSearch">
          <el-form-item label="设备名称">
            <el-input v-model="queryForm.keyword" placeholder="设备名称/编号" clearable style="width: 200px" />
          </el-form-item>
          <el-form-item label="设备类型">
            <el-select v-model="queryForm.type" placeholder="请选择" clearable style="width: 160px">
              <el-option
                v-for="item in deviceTypeOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="设备状态">
            <el-select v-model="queryForm.status" placeholder="请选择" clearable style="width: 120px">
              <el-option label="在线" value="ONLINE" />
              <el-option label="离线" value="OFFLINE" />
            </el-select>
          </el-form-item>
          <el-form-item label="所属地块">
            <el-input v-model="queryForm.plotCode" placeholder="地块编码" clearable style="width: 160px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSearch">查询</el-button>
            <el-button @click="handleReset">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="table-toolbar">
        <el-button v-if="canManage" type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>添加设备
        </el-button>
      </div>

      <el-table v-loading="loading" :data="tableData" border stripe>
        <el-table-column prop="serialNo" label="设备编号" width="150" />
        <el-table-column prop="name" label="设备名称" min-width="150" />
        <el-table-column prop="plotName" label="所属地块" width="150" />
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="getDeviceStatusType(row.status)" size="small">
              {{ getDeviceStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastReportAt" label="最后上报时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.lastReportAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="showDetail(row)">详情</el-button>
            <el-button v-if="canManage" link type="primary" size="small" @click="openConfig(row)">配置</el-button>
            <el-button v-if="canManage" link type="warning" size="small" @click="openCommand(row)">控制</el-button>
            <el-button link type="primary" size="small" @click="refreshDevice(row)">刷新</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="queryForm.page"
          v-model:page-size="queryForm.pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          @size-change="fetchList"
          @current-change="fetchList"
        />
      </div>
    </div>
    <el-dialog v-model="detailVisible" title="设备详情" width="520px">
      <el-descriptions v-if="selectedDevice" :column="1" border>
        <el-descriptions-item label="设备编号">{{ selectedDevice.deviceNo }}</el-descriptions-item>
        <el-descriptions-item label="名称">{{ selectedDevice.name }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ deviceTypeLabel(selectedDevice.type) }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ getDeviceStatusText(selectedDevice.status) }}</el-descriptions-item>
        <el-descriptions-item label="所属地块">{{ selectedDevice.plotCode || '-' }}</el-descriptions-item>
        <el-descriptions-item label="最后在线">{{ formatDateTime(selectedDevice.lastSeenAt) }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>

    <el-dialog v-model="createVisible" title="添加设备" width="560px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="90px">
        <el-form-item label="设备名称" prop="name">
          <el-input v-model="createForm.name" placeholder="请输入设备名称" maxlength="40" />
        </el-form-item>
        <el-form-item label="设备编号" prop="deviceNo">
          <el-input v-model="createForm.deviceNo" placeholder="台账内唯一，如 DZ-S-005" maxlength="32" />
        </el-form-item>
        <el-form-item label="设备类型" prop="type">
          <el-select v-model="createForm.type" placeholder="请选择设备类型" style="width: 100%">
            <el-option v-for="item in deviceTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="所属地块">
          <el-select v-model="createForm.plotCode" placeholder="未绑定地块" clearable filterable style="width: 100%">
            <el-option
              v-for="plot in plotOptions"
              :key="plot.parcelCode"
              :label="`${plot.parcelName}（${plot.parcelCode}）`"
              :value="plot.parcelCode"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="初始状态" prop="status">
          <el-radio-group v-model="createForm.status">
            <el-radio v-for="item in deviceStatusOptions" :key="item.value" :value="item.value">{{ item.label }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="configVisible" title="设备配置" width="560px">
      <el-form ref="configFormRef" :model="configForm" :rules="configRules" label-width="90px">
        <el-form-item label="设备编号">
          <el-input :model-value="configForm.deviceNo" disabled />
          <span class="form-hint">出厂编号用于关联遥测与控制指令，登记后不可修改</span>
        </el-form-item>
        <el-form-item label="设备名称" prop="name">
          <el-input v-model="configForm.name" placeholder="请输入设备名称" maxlength="40" />
        </el-form-item>
        <el-form-item label="设备类型" prop="type">
          <el-select v-model="configForm.type" placeholder="请选择设备类型" style="width: 100%">
            <el-option v-for="item in deviceTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="所属地块">
          <el-select v-model="configForm.plotCode" placeholder="未绑定地块" clearable filterable style="width: 100%">
            <el-option
              v-for="plot in plotOptions"
              :key="plot.parcelCode"
              :label="`${plot.parcelName}（${plot.parcelCode}）`"
              :value="plot.parcelCode"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="在线状态" prop="status">
          <el-radio-group v-model="configForm.status">
            <el-radio v-for="item in deviceStatusOptions" :key="item.value" :value="item.value">{{ item.label }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="configVisible = false">取消</el-button>
        <el-button type="primary" :loading="configSaving" @click="submitConfig">保存配置</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="commandVisible" title="下发控制指令" width="640px">
      <el-form ref="commandFormRef" :model="commandForm" :rules="commandRules" label-width="90px">
        <el-form-item label="执行设备">
          <el-input :model-value="`${commandForm.deviceName}（${commandForm.deviceNo}）`" disabled />
        </el-form-item>
        <el-form-item label="指令类型" prop="type">
          <el-select v-model="commandForm.type" style="width: 100%" @change="resetParameters">
            <el-option v-for="item in commandTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="作业地块">
          <el-select v-model="commandForm.plotCode" placeholder="不指定地块" clearable filterable style="width: 100%" @change="fillZoneArea">
            <el-option
              v-for="plot in plotOptions"
              :key="plot.parcelCode"
              :label="`${plot.parcelName}（${plot.parcelCode}）`"
              :value="plot.parcelCode"
            />
          </el-select>
        </el-form-item>

        <template v-if="isWaterFertilizer">
          <el-form-item label="灌溉分区">
            <el-table :data="commandForm.zones" size="small" border class="zone-table">
              <el-table-column label="分区编码" width="150">
                <template #default="{ row }"><el-input v-model="row.zoneCode" placeholder="ZONE-01" /></template>
              </el-table-column>
              <el-table-column label="面积(亩)" width="130">
                <template #default="{ row }"><el-input-number v-model="row.areaMu" :min="0.1" :precision="2" :step="1" controls-position="right" style="width: 100%" /></template>
              </el-table-column>
              <el-table-column label="灌水定额(mm)" width="150">
                <template #default="{ row }"><el-input-number v-model="row.targetMm" :min="1" :max="100" :precision="0" :step="1" controls-position="right" style="width: 100%" /></template>
              </el-table-column>
              <el-table-column label="操作" width="70" align="center">
                <template #default="{ $index }">
                  <el-button link type="danger" size="small" :disabled="commandForm.zones.length === 1" @click="removeZone($index)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-button link type="primary" size="small" @click="addZone">添加分区</el-button>
          </el-form-item>
          <el-form-item label="供水流量">
            <el-input-number v-model="commandForm.flowM3h" :min="1" :max="500" :precision="0" :step="5" controls-position="right" />
            <span class="form-hint">m³/h，用于估算分区开启时长</span>
          </el-form-item>
          <template v-if="commandForm.type === 'FERTILIZATION'">
            <el-form-item label="配比(kg/亩)">
              <el-input-number v-model="commandForm.recipe.nitrogen" :min="0" :precision="2" :step="0.1" controls-position="right" />
              <el-input-number v-model="commandForm.recipe.phosphorus" :min="0" :precision="2" :step="0.1" controls-position="right" />
              <el-input-number v-model="commandForm.recipe.potassium" :min="0" :precision="2" :step="0.1" controls-position="right" />
              <span class="form-hint">氮 / 磷 / 钾，三项不能全为 0</span>
            </el-form-item>
            <el-form-item label="搅拌">
              <el-input-number v-model="commandForm.stir.durationMin" :min="1" :max="120" :precision="0" :step="1" controls-position="right" />
              <span class="form-hint">分钟</span>
              <el-input-number v-model="commandForm.stir.rpm" :min="0" :max="300" :precision="0" :step="10" controls-position="right" />
              <span class="form-hint">转/分</span>
            </el-form-item>
          </template>
          <el-form-item v-if="plan" label="用水预演">
            <div class="plan-line">
              总用水量 {{ plan.totalWaterVolume }} m³，预计时长 {{ plan.totalDurationMin }} 分钟
              <el-button link type="primary" size="small" @click="simulatePlan">重新预演</el-button>
            </div>
            <div v-for="warning in plan.warnings" :key="warning" class="plan-warning">
              <el-alert :title="warning" type="warning" :closable="false" show-icon />
            </div>
          </el-form-item>
          <el-form-item v-else label="用水预演">
            <el-button link type="primary" size="small" :loading="planning" @click="simulatePlan">按分区算用水量与阀门时序</el-button>
          </el-form-item>
        </template>

        <el-form-item label="指令缘由" prop="reason">
          <el-input v-model="commandForm.reason" type="textarea" :rows="2" maxlength="120" show-word-limit placeholder="写明处置依据，指令列表与生产档案按此复盘" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="commandVisible = false">取消</el-button>
        <el-button type="warning" :loading="sending" @click="submitCommand">确认下发</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import type { DeviceQuery } from '@/types'
import { formatDateTime, getControlTypeText, getDeviceStatusText, getDeviceStatusType } from '@/utils'
import { deviceStatusOptions, deviceTypeLabel, deviceTypeOptions } from '@/utils/device'
import { controlApi, iotApi, plotApi, type IrrigationPlan } from '@/api'
import { useUserStore } from '@/stores'

const loading = ref(false)
const route = useRoute()
const tableData = ref<any[]>([])
const total = ref(0)
const detailVisible = ref(false)
const selectedDevice = ref<any | null>(null)

const userStore = useUserStore()
// 后端 POST /api/v1/devices 走 device:control，只有该权限才显示入口，避免点开后必然 403
const canManage = computed(() => userStore.hasPermission('device:control'))

const queryForm = reactive<DeviceQuery>({
  page: 1,
  pageSize: 20,
  keyword: '',
  status: undefined,
  type: undefined,
  plotCode: ''
})

const createVisible = ref(false)
const submitting = ref(false)
const createFormRef = ref<FormInstance | null>(null)

const createForm = reactive({
  name: '',
  deviceNo: '',
  type: '',
  // el-select 清空后把值置为 undefined，地块是可选项，类型上如实保留
  plotCode: '' as string | undefined,
  status: 'OFFLINE' as 'ONLINE' | 'OFFLINE'
})

const createRules: FormRules = {
  name: [{ required: true, message: '请输入设备名称', trigger: 'blur' }],
  deviceNo: [
    { required: true, message: '请输入设备编号', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9-]{3,32}$/, message: '编号由字母、数字和连字符组成，长度 3~32', trigger: 'blur' }
  ],
  type: [{ required: true, message: '请选择设备类型', trigger: 'change' }],
  status: [{ required: true, message: '请选择初始状态', trigger: 'change' }]
}

async function fetchList() {
  loading.value = true
  try {
    const result = await iotApi.getDevices({
      page: queryForm.page,
      size: queryForm.pageSize,
      keyword: queryForm.keyword || undefined,
      type: queryForm.type,
      status: queryForm.status,
      plotCode: queryForm.plotCode || undefined
    })
    tableData.value = result.items.map(toRow)
    total.value = result.total
  } catch (error) {
    tableData.value = []
    total.value = 0
    console.error('设备列表加载失败', error)
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  queryForm.page = 1
  fetchList()
}

function handleReset() {
  queryForm.keyword = ''
  queryForm.status = undefined
  queryForm.type = undefined
  queryForm.plotCode = ''
  queryForm.page = 1
  fetchList()
}

function showDetail(row: any) { selectedDevice.value = row; detailVisible.value = true }

async function refreshDevice(row: any) {
  try { const latest = await iotApi.getDevice(row.id); const index = tableData.value.findIndex((item) => item.id === row.id); if (index >= 0) tableData.value[index] = toRow(latest); ElMessage.success('设备状态已刷新') } catch (error) { console.error('设备刷新失败', error) }
}

function openCreate() {
  createForm.name = ''
  createForm.deviceNo = ''
  createForm.type = ''
  createForm.plotCode = ''
  createForm.status = 'OFFLINE'
  createFormRef.value?.clearValidate()
  createVisible.value = true
}

async function submitCreate() {
  const valid = await createFormRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    await iotApi.createDevice({
      deviceNo: createForm.deviceNo.trim(),
      name: createForm.name.trim(),
      type: createForm.type,
      status: createForm.status,
      plotCode: createForm.plotCode?.trim() || undefined
    })
    ElMessage.success('设备已登记')
    createVisible.value = false
    queryForm.page = 1
    fetchList()
  } catch (error) {
    // 编号重复等业务原因由请求拦截器直接提示，这里只留日志
    console.error('设备登记失败', error)
  } finally {
    submitting.value = false
  }
}

/** 台账字段与列表展示字段的一次映射，配置保存后也按同一口径回写行 */
function toRow(device: any) {
  return { ...device, serialNo: device.deviceNo, plotName: device.plotCode || '-', lastReportAt: device.lastSeenAt }
}

/* ---------------- 地块下拉 ---------------- */

interface PlotOption { parcelCode: string; parcelName: string; areaMu: number }

const plotOptions = ref<PlotOption[]>([])

/** 地块编码在配置与控制两处弹窗都要选，第一次打开时按全量边界取一次 */
async function ensurePlotOptions() {
  if (plotOptions.value.length) return
  try {
    plotOptions.value = await plotApi.getBounds()
  } catch (error) {
    console.error('地块边界加载失败', error)
  }
}

/* ---------------- 台账配置 ---------------- */

const configVisible = ref(false)
const configSaving = ref(false)
const configFormRef = ref<FormInstance | null>(null)

const configForm = reactive({
  id: '',
  deviceNo: '',
  name: '',
  type: '',
  plotCode: '' as string | undefined,
  status: 'OFFLINE' as 'ONLINE' | 'OFFLINE'
})

const configRules: FormRules = {
  name: [{ required: true, message: '请输入设备名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择设备类型', trigger: 'change' }],
  status: [{ required: true, message: '请选择在线状态', trigger: 'change' }]
}

async function openConfig(row: any) {
  Object.assign(configForm, {
    id: row.id,
    deviceNo: row.deviceNo,
    name: row.name,
    type: row.type,
    plotCode: row.plotCode || '',
    status: row.status === 'ONLINE' ? 'ONLINE' : 'OFFLINE'
  })
  configFormRef.value?.clearValidate()
  configVisible.value = true
  void ensurePlotOptions()
}

async function submitConfig() {
  const valid = await configFormRef.value?.validate().catch(() => false)
  if (!valid) return
  configSaving.value = true
  try {
    const updated = await iotApi.updateDevice(configForm.id, {
      name: configForm.name.trim(),
      type: configForm.type,
      status: configForm.status,
      // 空串是「解绑地块」的明确语义，必须原样发出去，不能转成 undefined
      plotCode: (configForm.plotCode ?? '').trim()
    })
    const index = tableData.value.findIndex((item) => item.id === configForm.id)
    if (index >= 0) tableData.value[index] = toRow(updated)
    ElMessage.success('设备配置已保存')
    configVisible.value = false
  } catch (error) {
    console.error('设备配置保存失败', error)
  } finally {
    configSaving.value = false
  }
}

/* ---------------- 控制指令 ---------------- */

const commandTypeOptions = ['IRRIGATION', 'FERTILIZATION', 'SEEDING', 'WEEDING'].map((value) => ({ value, label: getControlTypeText(value) }))

const commandVisible = ref(false)
const sending = ref(false)
const planning = ref(false)
const commandFormRef = ref<FormInstance | null>(null)
const plan = ref<IrrigationPlan | null>(null)

const commandForm = reactive({
  deviceId: '',
  deviceName: '',
  deviceNo: '',
  type: 'IRRIGATION',
  plotCode: '' as string | undefined,
  reason: '',
  flowM3h: 20,
  zones: [{ zoneCode: 'ZONE-01', areaMu: 0, targetMm: 10 }],
  recipe: { nitrogen: 1, phosphorus: 1, potassium: 1 },
  stir: { durationMin: 10, rpm: 60 }
})

const commandRules: FormRules = {
  type: [{ required: true, message: '请选择指令类型', trigger: 'change' }],
  reason: [{ required: true, message: '请填写指令缘由', trigger: 'blur' }]
}

/** 播种、除草只落地块与缘由；水肥类需要分区才能算出用水量与阀门时序 */
const isWaterFertilizer = computed(() => commandForm.type === 'IRRIGATION' || commandForm.type === 'FERTILIZATION')

async function openCommand(row: any) {
  Object.assign(commandForm, {
    deviceId: row.id,
    deviceName: row.name,
    deviceNo: row.deviceNo,
    type: 'IRRIGATION',
    plotCode: row.plotCode || '',
    reason: ''
  })
  plan.value = null
  resetParameters()
  commandFormRef.value?.clearValidate()
  commandVisible.value = true
  await ensurePlotOptions()
  fillZoneArea()
}

function resetParameters() {
  commandForm.flowM3h = 20
  commandForm.zones = [{ zoneCode: 'ZONE-01', areaMu: 0, targetMm: 10 }]
  commandForm.recipe = { nitrogen: 1, phosphorus: 1, potassium: 1 }
  commandForm.stir = { durationMin: 10, rpm: 60 }
  plan.value = null
  fillZoneArea()
}

/** 首个分区的面积按所选地块的实际亩数预填，人工只需核对定额 */
function fillZoneArea() {
  plan.value = null
  const areaMu = plotOptions.value.find((plot) => plot.parcelCode === commandForm.plotCode)?.areaMu
  const first = commandForm.zones[0]
  if (first && areaMu) first.areaMu = Number(areaMu.toFixed(2))
}

function addZone() {
  const last = commandForm.zones[commandForm.zones.length - 1]
  commandForm.zones.push({ zoneCode: `ZONE-${String(commandForm.zones.length + 1).padStart(2, '0')}`, areaMu: last?.areaMu ?? 0, targetMm: last?.targetMm ?? 10 })
}

function removeZone(index: number) {
  commandForm.zones.splice(index, 1)
  plan.value = null
}

/** 只算不执行的方案预演：确认用水量与阀门时序后再下发，避免凭感觉给定额 */
async function simulatePlan() {
  if (!commandForm.zones.length) {
    ElMessage.warning('至少需要一个灌溉分区')
    return
  }
  planning.value = true
  try {
    plan.value = await controlApi.buildIrrigationPlan({
      ...(commandForm.plotCode ? { plotCode: commandForm.plotCode } : {}),
      flowM3h: commandForm.flowM3h,
      zones: commandForm.zones.map((zone) => ({ ...zone })),
      ...(commandForm.type === 'FERTILIZATION' ? { recipe: { ...commandForm.recipe }, stir: { ...commandForm.stir } } : {})
    })
  } catch (error) {
    plan.value = null
    console.error('灌溉方案预演失败', error)
  } finally {
    planning.value = false
  }
}

function buildParameters(): Record<string, unknown> {
  if (!isWaterFertilizer.value) return {}
  return {
    zones: commandForm.zones.map((zone) => ({ zoneCode: zone.zoneCode.trim() || undefined, areaMu: zone.areaMu, targetMm: zone.targetMm })),
    flowM3h: commandForm.flowM3h,
    ...(commandForm.type === 'FERTILIZATION' ? { recipe: { ...commandForm.recipe }, stir: { ...commandForm.stir } } : {})
  }
}

async function submitCommand() {
  const valid = await commandFormRef.value?.validate().catch(() => false)
  if (!valid) return
  if (isWaterFertilizer.value && commandForm.zones.some((zone) => !(zone.areaMu > 0))) {
    ElMessage.warning('分区面积必须大于 0 亩，否则算不出用水量')
    return
  }
  const summary = `${commandForm.deviceName}：${getControlTypeText(commandForm.type)}${isWaterFertilizer.value ? `，${commandForm.zones.length} 个分区` : ''}`
  try {
    await ElMessageBox.confirm(`确认下发指令？${summary}。指令入队后即进入执行队列。`, '二次确认', {
      type: 'warning',
      confirmButtonText: '确认下发',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  sending.value = true
  try {
    await controlApi.sendCommand({
      deviceId: commandForm.deviceId,
      ...(commandForm.plotCode ? { plotCode: commandForm.plotCode } : {}),
      type: commandForm.type,
      reason: commandForm.reason.trim(),
      parameters: buildParameters()
    })
    ElMessage.success('指令已入队，可在「控制指令」页按人工来源查看')
    commandVisible.value = false
  } catch (error) {
    // 参数越界等业务原因由请求拦截器直接提示，这里只留日志
    console.error('控制指令下发失败', error)
  } finally {
    sending.value = false
  }
}

onMounted(() => {
  // 一张图设备点位「设备台账」跳转带 plotCode 查询参数，进入即按该地块过滤
  const fromQuery = route.query.plotCode
  if (typeof fromQuery === 'string' && fromQuery) queryForm.plotCode = fromQuery
  fetchList()
})
</script>

<style scoped>
.form-hint {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.zone-table {
  margin-bottom: 6px;
}

.plan-line {
  color: #303133;
  font-size: 13px;
}

.plan-warning {
  margin-top: 6px;
}

.el-input-number + .form-hint {
  margin-left: 6px;
}
</style>
