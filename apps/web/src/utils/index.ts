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
