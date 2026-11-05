import { get, post, put, del } from '@/utils/request'
import type {
  Plot, PlotQuery, PlotForm,
  Device, DeviceRealtimeData,
  FarmTask, FarmTaskQuery,
  DashboardStats,
  PageResult, LoginParams, LoginResult,
  Camera, PlotStats, Recording,
  TelemetryHistoryPoint, TelemetryAlert,
  MessagePreference, MessageLevel,
  SystemUser, PlatformRole, PermissionGroup,
} from '@/types'

// 认证相关API
export const authApi = {
  login(data: LoginParams): Promise<LoginResult> {
    return post<LoginResult>('/auth/login', data)
  },
  logout(): Promise<void> {
    return post<void>('/auth/logout')
  },
  getUserInfo(): Promise<any> {
    return get<any>('/auth/userinfo')
  },
  refreshToken(): Promise<LoginResult> {
    return post<LoginResult>('/auth/refresh')
  },
  /** 平台用户分页查询（与登录账号同一份数据） */
  getUsers(params?: { page?: number; size?: number; keyword?: string; status?: 'ACTIVE' | 'DISABLED' }): Promise<PageResult<SystemUser>> {
    return get<PageResult<SystemUser>>('/auth/users', params)
  },
  createUser(data: { username: string; name: string; phone?: string; password?: string; roles: string[]; status?: 'ACTIVE' | 'DISABLED' }): Promise<SystemUser> {
    return post<SystemUser>('/auth/users', data)
  },
  updateUser(id: string, data: { name?: string; phone?: string; roles?: string[]; status?: 'ACTIVE' | 'DISABLED' }): Promise<SystemUser> {
    return put<SystemUser>(`/auth/users/${encodeURIComponent(id)}`, data)
  },
  resetPassword(id: string, password: string): Promise<void> {
    return post<void>(`/auth/users/${encodeURIComponent(id)}/password`, { password })
  },
  deleteUser(id: string): Promise<void> {
    return del<void>(`/auth/users/${encodeURIComponent(id)}`)
  }
}

// 地块相关API
export const plotApi = {
  getList(params: PlotQuery): Promise<PageResult<Plot>> {
    const { pageSize, ...query } = params
    return get<PageResult<Plot>>('/plots', { ...query, size: pageSize }).then((result) => ({
      ...result,
      items: result.items.map(normalizePlot),
    }))
  },
  getById(id: string): Promise<Plot> {
    return get<Plot>(`/plots/${encodeURIComponent(id)}`).then(normalizePlot)
  },
  create(data: PlotForm): Promise<Plot> {
    return post<Plot>('/plots', toPlotServiceInput(data)).then(normalizePlot)
  },
  update(id: string, data: PlotForm): Promise<Plot> {
    return put<Plot>(`/plots/${encodeURIComponent(id)}`, toPlotServicePatch(data)).then(normalizePlot)
  },
  delete(id: string): Promise<void> {
    return del<void>(`/plots/${encodeURIComponent(id)}`)
  },
  batchDelete(ids: string[]): Promise<void> {
    return Promise.all(ids.map((id) => plotApi.delete(id))).then(() => undefined)
  },
  /** 一张图用：全量地块边界，不分页 */
  getBounds(): Promise<Array<{ parcelCode: string; parcelName: string; areaMu: number; geom: unknown }>> {
    return get('/plots/bounds')
  },
  /** 看板用：地块总量、总面积与土壤类型分布（当前作物业未入库，暂按土壤类型汇总） */
  getStats(): Promise<PlotStats> {
    return get('/plots/stats')
  }
}

function normalizePlot(value: any): Plot {
  const parcelCode = String(value.parcelCode ?? '')
  return {
    ...value,
    id: String(value.id ?? value.parcelId ?? parcelCode),
    parcelCode,
    name: String(value.name ?? value.parcelName ?? parcelCode),
    areaMu: Number(value.areaMu ?? 0),
    type: value.type ?? 'FIELD',
    status: value.status ?? 'DRAFT',
    createdAt: String(value.createdAt ?? ''),
    updatedAt: String(value.updatedAt ?? value.createdAt ?? ''),
  } as Plot
}

function toPlotServiceInput(data: PlotForm): Record<string, unknown> {
  const region = /^\d{6}$/.test(data.regionCode) ? data.regionCode : '511723'
  const farm = (data.villageCode.match(/(\d{6})$/)?.[1] ?? '000001').padStart(6, '0')
  const parcel = String(Date.now() % 100000).padStart(5, '0')
  return {
    ...data,
    region,
    farm,
    area: '01',
    parcel,
    parcelName: data.name,
    farmId: data.villageCode || 'farm-kaijiang-01',
    geom: coordinatesToGeom(data.coordinates),
  }
}

function toPlotServicePatch(data: PlotForm): Record<string, unknown> {
  return { parcelName: data.name, areaMu: data.areaMu, soilType: data.soilType, geom: coordinatesToGeom(data.coordinates) }
}

function coordinatesToGeom(coordinates?: [number, number][]): Record<string, unknown> {
  const points = coordinates && coordinates.length >= 3 ? coordinates : [[107.8421, 30.9942], [107.8433, 30.9942], [107.8433, 30.9951], [107.8421, 30.9951], [107.8421, 30.9942]]
  const closed = points[0] === points[points.length - 1] ? points : [...points, points[0]!]
  return { type: 'Polygon', coordinates: [closed], srid: 4490 }
}

// 设备相关API
export const deviceApi = {
  getList(params?: any): Promise<PageResult<Device>> {
    return get<PageResult<Device>>('/devices', params)
  },
  getById(id: string): Promise<Device> {
    return get<Device>(`/devices/${id}`)
  },
  create(data: any): Promise<Device> {
    return post<Device>('/devices', data)
  },
  update(id: string, data: any): Promise<Device> {
    return put<Device>(`/devices/${id}`, data)
  },
  delete(id: string): Promise<void> {
    return del<void>(`/devices/${id}`)
  },
  getLatestData(id: string): Promise<DeviceRealtimeData> {
    return get<DeviceRealtimeData>(`/devices/${id}/latest-data`)
  }
}

// 农事任务API
export const farmTaskApi = {
  getList(params: FarmTaskQuery): Promise<PageResult<FarmTask>> {
    return get<PageResult<FarmTask>>('/farm-tasks', params)
  },
  getById(id: string): Promise<FarmTask> {
    return get<FarmTask>(`/farm-tasks/${id}`)
  },
  create(data: any): Promise<FarmTask> {
    return post<FarmTask>('/farm-tasks', data)
  },
  update(id: string, data: any): Promise<FarmTask> {
    return put<FarmTask>(`/farm-tasks/${id}`, data)
  },
  delete(id: string): Promise<void> {
    return del<void>(`/farm-tasks/${id}`)
  }
}

// 数据看板API
export const dashboardApi = {
  getStats(): Promise<DashboardStats> {
    return get<DashboardStats>('/dashboard/stats')
  },
  getTrend(days: number = 30): Promise<any[]> {
    return get<any[]>('/dashboard/trend', { days })
  },
  getAlerts(limit: number = 10): Promise<any[]> {
    return get<any[]>('/dashboard/alerts', { limit })
  }
}

export const iotApi = {
  getDevices(): Promise<{ items: any[]; total: number }> {
    return get<{ items: any[]; total: number }>('/devices')
  },
  getDevice(id: string): Promise<any> {
    return get<any>(`/devices/${encodeURIComponent(id)}`)
  },
  sendCommand(id: string, command: Record<string, unknown>): Promise<any> {
    return post<any>(`/devices/${encodeURIComponent(id)}/commands`, command)
  }
}

export const platformApi = {
  getRoles(params?: { page?: number; size?: number; keyword?: string }): Promise<PageResult<PlatformRole>> {
    return get<PageResult<PlatformRole>>('/platform/roles', params)
  },
  createRole(data: { name: string; code: string; description?: string; permissions: string[] }): Promise<PlatformRole> {
    return post<PlatformRole>('/platform/roles', data)
  },
  updateRole(id: string, data: { name?: string; description?: string; permissions?: string[]; status?: 'ACTIVE' | 'DISABLED' }): Promise<PlatformRole> {
    return put<PlatformRole>(`/platform/roles/${encodeURIComponent(id)}`, data)
  },
  deleteRole(id: string): Promise<void> {
    return del<void>(`/platform/roles/${encodeURIComponent(id)}`)
  },
  /** 权限目录：角色弹窗按分组渲染勾选项 */
  getPermissions(): Promise<PermissionGroup[]> {
    return get<PermissionGroup[]>('/platform/permissions')
  }
}

export const telemetryApi = {
  getLatest(deviceId?: string): Promise<any[]> {
    return get<any[]>('/telemetry/latest', deviceId ? { deviceId } : undefined)
  },
  /** 历史读数原始序列 */
  getHistory(params?: { deviceId?: string; metric?: string; from?: string; to?: string; size?: number }): Promise<any[]> {
    return get<any[]>('/telemetry/history', params)
  },
  /** 历史曲线：按时间升序返回 (时间, 数值)，供趋势图直接绑定 */
  getHistorySeries(deviceId: string, metric: string): Promise<TelemetryHistoryPoint[]> {
    return get<TelemetryHistoryPoint[]>('/telemetry/history/series', { deviceId, metric })
  },
  getAlerts(): Promise<any[]> {
    return get<any[]>('/telemetry/alerts')
  },
  /** 处理（关闭）一条遥测告警 */
  handleAlert(id: string): Promise<void> {
    return post<void>(`/telemetry/alerts/${encodeURIComponent(id)}/handle`)
  }
}

export const weatherApi = {
  getForecast(): Promise<{ location: string; forecast: any[] }> {
    return get<{ location: string; forecast: any[] }>('/weather/forecast')
  }
}

export const operationApi = {
  getTasks(params?: { page?: number | undefined; size?: number | undefined; keyword?: string | undefined; status?: string | undefined }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/farm-tasks', params)
  },
  createTask(data: { plotCode: string; type: string; name: string; scheduledAt?: string }): Promise<any> {
    return post<any>('/farm-tasks', data)
  },
  updateStatus(id: string, status: string): Promise<any> {
    return post<any>(`/farm-tasks/${id}/status`, { status })
  }
}

export const controlApi = {
  getCommands(params?: { plotCode?: string; origin?: 'EVENT' | 'MANUAL'; page?: number; size?: number }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/control/commands', params)
  },
  sendCommand(data: { deviceId: string; plotCode?: string; type: string; parameters?: Record<string, unknown> }): Promise<any> {
    return post<any>('/control/commands', data, { headers: { 'X-Confirm-Action': 'CONFIRM' } })
  }
}

export const financeApi = {
  getEntries(plotCode?: string): Promise<any[]> {
    return get<any[]>('/finance/entries', plotCode ? { plotCode } : undefined)
  },
  getSummary(plotCode?: string): Promise<{ input: number; output: number; profit: number; currency: string }> {
    return get<{ input: number; output: number; profit: number; currency: string }>('/finance/summary', plotCode ? { plotCode } : undefined)
  },
  createEntry(data: { plotCode: string; season: string; kind: 'INPUT' | 'OUTPUT'; category: string; amount: number; unit: string; note: string }): Promise<any> {
    return post<any>('/finance/entries', data)
  }
}

export const traceApi = {
  getRecords(params?: { plotCode?: string; event?: string; page?: number; size?: number }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/trace/records', params)
  },
  createRecord(data: { plotCode: string; event: string; detail: string; operator: string }): Promise<any> {
    return post<any>('/trace/records', data)
  },
  getByCode(traceCode: string): Promise<any> {
    return get<any>(`/trace/${traceCode}`)
  }
}

export const videoApi = {
  getCameras(params?: { page?: number; size?: number }): Promise<PageResult<Camera>> {
    return get<PageResult<Camera>>('/video/cameras', params)
  },
  getCamera(cameraId: string): Promise<Camera | null> {
    return get<Camera | null>(`/video/cameras/${encodeURIComponent(cameraId)}`)
  },
  sendPtz(cameraId: string, command: Record<string, unknown>): Promise<{ commandId: string; status: string }> {
    return post<{ commandId: string; status: string }>(`/video/cameras/${encodeURIComponent(cameraId)}/ptz`, command)
  },
  getRecordings(params?: { page?: number; size?: number; cameraId?: string }): Promise<PageResult<Recording>> {
    return get<PageResult<Recording>>('/video/recordings', params)
  }
}

export type { TelemetryHistoryPoint, TelemetryAlert, MessagePreference, MessageLevel }

export interface MessageQuery {
  page?: number
  size?: number
  type?: 'ALERT' | 'NOTICE'
  read?: boolean
  plotCode?: string
  keyword?: string
}

/** 消息中心：页面通知与事件消费生成的告警共用同一份消息 */
export const messageApi = {
  getList(params?: MessageQuery): Promise<PageResult<any>> {
    return get<PageResult<any>>('/messages', params)
  },
  getUnreadCount(): Promise<{ unread: number }> {
    return get<{ unread: number }>('/messages/unread-count')
  },
  markRead(id: string): Promise<any> {
    return post<any>(`/messages/${encodeURIComponent(id)}/read`)
  },
  /** 订阅偏好：返回模板目录全量，未配置的主题按默认值展示 */
  getPreferences(): Promise<{ items: MessagePreference[] }> {
    return get<{ items: MessagePreference[] }>('/messages/preferences')
  },
  /** 更新单个主题的订阅偏好，事件消费按新配置过滤 */
  updatePreference(topic: string, data: { enabled?: boolean; minLevel?: MessageLevel }): Promise<MessagePreference> {
    return put<MessagePreference>(`/messages/preferences/${encodeURIComponent(topic)}`, data)
  },
  create(data: { title: string; content?: string; type?: 'ALERT' | 'NOTICE'; level?: 'INFO' | 'WARNING' | 'CRITICAL'; plotCode?: string }): Promise<any> {
    return post<any>('/messages', data)
  }
}
