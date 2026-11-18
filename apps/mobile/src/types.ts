/** 移动端只声明用到的字段子集，与后端返回同口径；完整契约见 apps/web/src/types */

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}

export interface MobileUser {
  id: string
  username: string
  name: string
  roles: string[]
  permissions: string[]
}

export interface LoginResult {
  token: string
  expiresIn: number
  user: MobileUser
}

export interface PlotItem {
  parcelCode: string
  parcelName: string
  areaMu: number
}

export interface PlotStats {
  totalPlots: number
  totalAreaMu: number
  soilTypes: Array<{ name: string; areaMu: number }>
}

export interface DeviceItem {
  id: string
  name: string
  status: string
}

export interface TelemetryAlert {
  id: string
  deviceId: string
  plotCode: string
  level: string
  metric: string
  message: string
  createdAt: string
  handled: boolean
}

export interface OverviewResult {
  latest: Array<{ deviceId: string; plotCode: string; metric: string; value: number; recordedAt: string }>
  alerts: TelemetryAlert[]
  pests: Array<{ id: string }>
  rules: Array<{ id: string }>
}

export type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED'
export type TaskType = 'TILLAGE' | 'SEEDING' | 'IRRIGATION' | 'WEEDING' | 'SPRAYING' | 'FERTILIZATION'

export interface TaskResult {
  outcome: 'success' | 'partial' | 'failed'
  finishedAreaMu: number
  notes: string
}

export interface FarmTask {
  id: string
  plotCode: string
  type: TaskType
  name: string
  status: TaskStatus
  priority?: 'HIGH' | 'NORMAL' | 'LOW'
  scheduledAt?: string
  scheduledEndAt?: string
  assigneeName?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  cancelledAt?: string
  result?: TaskResult
  version: number
}

export interface TraceRecord {
  id: string
  traceCode: string
  batchCode: string
  plotCode: string
  event: string
  detail: string
  operator: string
  createdAt: string
}