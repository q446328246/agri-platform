import dayjs from 'dayjs'
import { PlotStatus, PlotType, SoilType, DeviceStatus, FarmTaskStatus } from '@/types'

export function formatDateTime(date: string | Date | undefined | null, format = 'YYYY-MM-DD HH:mm:ss'): string {
  if (!date) return '-'
  return dayjs(date).format(format)
}

export function formatDate(date: string | Date | undefined | null, format = 'YYYY-MM-DD'): string {
  return formatDateTime(date, format)
}

export function getPlotStatusText(status: PlotStatus): string {
  const map: Record<PlotStatus, string> = {
    [PlotStatus.DRAFT]: '草稿',
    [PlotStatus.ACTIVE]: '种植中',
    [PlotStatus.FALLOW]: '休耕',
    [PlotStatus.ARCHIVED]: '已归档'
  }
  return map[status] || status
}

export function getPlotStatusType(status: PlotStatus): '' | 'success' | 'warning' | 'info' | 'danger' {
  const map: Record<PlotStatus, '' | 'success' | 'warning' | 'info' | 'danger'> = {
    [PlotStatus.DRAFT]: 'info',
    [PlotStatus.ACTIVE]: 'success',
    [PlotStatus.FALLOW]: 'warning',
    [PlotStatus.ARCHIVED]: 'danger'
  }
  return map[status] || ''
}

export function getPlotTypeText(type: PlotType): string {
  const map: Record<PlotType, string> = {
    [PlotType.FIELD]: '大田',
    [PlotType.GREENHOUSE]: '大棚',
    [PlotType.ORCHARD]: '果园',
    [PlotType.AQUACULTURE]: '水产养殖'
  }
  return map[type] || type
}

export function getSoilTypeText(type: SoilType): string {
  const map: Record<SoilType, string> = {
    [SoilType.LOAM]: '壤土',
    [SoilType.CLAY]: '黏土',
    [SoilType.SAND]: '沙土',
    [SoilType.SILT]: '淤土',
    [SoilType.PEAT]: '泥炭土'
  }
  return map[type] || type
}

export function getDeviceStatusText(status: DeviceStatus): string {
  const map: Record<DeviceStatus, string> = {
    [DeviceStatus.OFFLINE]: '离线',
    [DeviceStatus.ONLINE]: '在线',
    [DeviceStatus.FAULT]: '故障',
    [DeviceStatus.MAINTENANCE]: '维护中'
  }
  return map[status] || status
}

export function getDeviceStatusType(status: DeviceStatus): '' | 'success' | 'warning' | 'info' | 'danger' {
  const map: Record<DeviceStatus, '' | 'success' | 'warning' | 'info' | 'danger'> = {
    [DeviceStatus.OFFLINE]: 'info',
    [DeviceStatus.ONLINE]: 'success',
    [DeviceStatus.FAULT]: 'danger',
    [DeviceStatus.MAINTENANCE]: 'warning'
  }
  return map[status] || ''
}

export function getTaskStatusText(status: FarmTaskStatus): string {
  const map: Record<FarmTaskStatus, string> = {
    [FarmTaskStatus.PENDING]: '待执行',
    [FarmTaskStatus.IN_PROGRESS]: '进行中',
    [FarmTaskStatus.COMPLETED]: '已完成',
    [FarmTaskStatus.CANCELLED]: '已取消'
  }
  return map[status] || status
}

export function getTaskStatusType(status: FarmTaskStatus): '' | 'success' | 'warning' | 'info' | 'danger' {
  const map: Record<FarmTaskStatus, '' | 'success' | 'warning' | 'info' | 'danger'> = {
    [FarmTaskStatus.PENDING]: 'info',
    [FarmTaskStatus.IN_PROGRESS]: 'warning',
    [FarmTaskStatus.COMPLETED]: 'success',
    [FarmTaskStatus.CANCELLED]: 'danger'
  }
  return map[status] || ''
}

/** 控制指令来源：事件自动生成与人工确认下达 */
export function getControlOriginText(origin: string): string {
  return origin === 'EVENT' ? '自动' : '人工'
}

export function getControlOriginType(origin: string): 'success' | 'warning' {
  return origin === 'EVENT' ? 'success' : 'warning'
}

export function getControlTypeText(type: string): string {
  const map: Record<string, string> = {
    SEEDING: '播种',
    IRRIGATION: '灌溉',
    WEEDING: '除草',
    FERTILIZATION: '水肥',
    ESTOP: '急停'
  }
  return map[type] || type
}

/** 控制指令生命周期：入队 → 已下发 → 设备已接收 → 执行到位，任一在途状态都可能失败 */
export function getControlStatusText(status: string): string {
  const map: Record<string, string> = {
    QUEUED: '已入队',
    SENT: '已下发',
    ACKED: '设备已接收',
    DONE: '执行到位',
    FAILED: '失败'
  }
  return map[status] || status
}

export function getControlStatusType(status: string): 'primary' | 'success' | 'info' | 'warning' | 'danger' {
  const map: Record<string, 'primary' | 'success' | 'info' | 'warning' | 'danger'> = {
    QUEUED: 'info',
    SENT: 'warning',
    ACKED: 'primary',
    DONE: 'success',
    FAILED: 'danger'
  }
  return map[status] || 'info'
}

/** 生产档案事件类型：事件自动写入与人工录入并存，链条含投入品、农事、处方、灌溉、归档、采收 */
const TRACE_EVENT_LABELS: Record<string, string> = {
  PRESCRIPTION_ISSUED: '处方生成',
  IRRIGATION_FINISHED: '灌溉完成',
  FERTILIZATION_FINISHED: '施肥完成',
  FARM_OPERATION: '农事作业',
  OPERATION_COMPLETED: '作业完成',
  INPUT_MATERIAL: '投入品领用',
  SOWING: '播种',
  HARVEST: '采收'
}

/** 由设备结单事件写入的档案：人工补录不提供，免得手填一条设备没做过的作业 */
const DEVICE_ONLY_EVENTS = ['IRRIGATION_FINISHED', 'FERTILIZATION_FINISHED']

export function getTraceEventText(event: string): string {
  return TRACE_EVENT_LABELS[event] || event || '-'
}

/** 档案事件下拉选项：与表格标签同一份来源，新增事件只改这里 */
export const traceEventOptions = Object.entries(TRACE_EVENT_LABELS).map(([value, label]) => ({ value, label }))

/** 人工补录可选的事件 */
export const manualTraceEventOptions = traceEventOptions.filter((option) => !DEVICE_ONLY_EVENTS.includes(option.value))

export function getTraceEventType(event: string): 'success' | 'warning' | 'info' {
  if (event === 'PRESCRIPTION_ISSUED' || DEVICE_ONLY_EVENTS.includes(event) || event === 'HARVEST') return 'success'
  if (event === 'OPERATION_COMPLETED') return 'warning'
  return 'info'
}

export function formatArea(mu: number): string {
  return `${mu.toFixed(2)} 亩`
}

export function downloadFile(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

export function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: number | null = null
  return function (this: unknown, ...args: Parameters<T>) {
    if (timer) clearTimeout(timer)
    timer = window.setTimeout(() => fn.apply(this, args), delay)
  }
}
