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

/** 剥掉查询参数里的 undefined/null/空串，避免发 ?keyword=&type= 这种无意义空条件 */
function cleanParams(params?: Record<string, unknown> | object): Record<string, unknown> | undefined {
  if (!params) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

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
    // 前端查询用 type/status，后端字段叫 plotType/plotStatus，在这里完成一次映射
    const { pageSize, type, status, ...rest } = params
    return get<PageResult<Plot>>('/plots', cleanParams({
      ...rest,
      plotType: type,
      plotStatus: status,
      size: pageSize,
    })).then((result) => ({
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
  },
  /** 一张图用：田间线路/管线（灌水管、施肥管、电力线、机耕道） */
  getInfraLines(lineType?: InfraLineType): Promise<InfraLine[]> {
    return get<InfraLine[]>('/plots/infra-lines', lineType ? { lineType } : undefined)
  },
  createInfraLine(data: { lineName: string; lineType: InfraLineType; geom: { type: 'LineString'; coordinates: number[][]; srid: number }; lineCode?: string }): Promise<InfraLine> {
    return post<InfraLine>('/plots/infra-lines', data)
  },
  deleteInfraLine(lineCode: string): Promise<void> {
    return del<void>(`/plots/infra-lines/${encodeURIComponent(lineCode)}`)
  }
}

/** 管线类型：灌水管、施肥管、电力线、机耕道 */
export type InfraLineType = 'IRRIGATION_PIPE' | 'FERTILIZATION_PIPE' | 'ELECTRIC_LINE' | 'ROAD'

export interface InfraLine {
  id: string
  lineCode: string
  lineName: string
  lineType: InfraLineType
  geom: { type: 'LineString'; coordinates: number[][]; srid: number }
  lengthM: number
  createdAt: string
}

/** GeoJSON 面（经纬度顺序为 [lng, lat]） */
export type GeoPolygon = { type: 'Polygon'; coordinates: number[][][]; srid: number }
/** GeoJSON 线（经纬度顺序为 [lng, lat]） */
export type GeoLineString = { type: 'LineString'; coordinates: number[][]; srid: number }

/** 片区台账：地块编码中的 area 段对应的业务实体 */
export interface PlotZone {
  id: string
  zoneCode: string
  zoneName: string
  tenantId: string
  farmId: string
  color: string
  description?: string
  geom?: GeoPolygon
  createdAt: string
  updatedAt: string
}

/** 片区 + 成员地块统计；map 视图额外带由地块外轮廓算出的凸包与中心点 */
export interface ZoneSummary extends PlotZone {
  plotCount: number
  areaMu: number
  hull: GeoPolygon | null
  centroid: { lng: number; lat: number } | null
  plots?: Plot[]
}

// 片区相关API
export const zoneApi = {
  /** 台账列表：带地块数与面积汇总，不含几何 */
  getList(): Promise<ZoneSummary[]> {
    return get<ZoneSummary[]>('/zones')
  },
  /** 一张图用：额外返回成员地块凸包与中心点 */
  getMap(): Promise<ZoneSummary[]> {
    return get<ZoneSummary[]>('/zones/map')
  },
  getDetail(zoneCode: string): Promise<ZoneSummary> {
    // 成员地块是服务端原始记录（parcelName），与列表一致地归一化后再给页面
    return get<ZoneSummary>(`/zones/${encodeURIComponent(zoneCode)}`).then((zone) => ({
      ...zone,
      ...(zone.plots ? { plots: zone.plots.map(normalizePlot) } : {}),
    }))
  },
  create(data: { zoneCode?: string; zoneName: string; color?: string; description?: string; geom?: GeoPolygon }): Promise<PlotZone> {
    return post<PlotZone>('/zones', data)
  },
  update(zoneCode: string, data: { zoneName?: string; color?: string; description?: string; geom?: GeoPolygon }): Promise<PlotZone> {
    return put<PlotZone>(`/zones/${encodeURIComponent(zoneCode)}`, data)
  },
  remove(zoneCode: string): Promise<void> {
    return del<void>(`/zones/${encodeURIComponent(zoneCode)}`)
  },
  /** 地块划入片区：直接改地块归属，不建关联表 */
  assignPlot(zoneCode: string, parcelCode: string): Promise<Plot> {
    return post<Plot>(`/zones/${encodeURIComponent(zoneCode)}/plots`, { parcelCode }).then(normalizePlot)
  },
  removePlot(zoneCode: string, parcelCode: string): Promise<Plot> {
    return del<Plot>(`/zones/${encodeURIComponent(zoneCode)}/plots/${encodeURIComponent(parcelCode)}`).then(normalizePlot)
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
    // 迁移 011 后后端直接返回 plotType/plotStatus，旧的 type/status 写法作为兼容回退
    type: value.plotType ?? value.type ?? 'FIELD',
    status: value.plotStatus ?? value.status ?? 'DRAFT',
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
    // 档案字段用后端列名发送：类型/状态/作物/负责人/备注
    plotType: data.type,
    ...(data.status ? { plotStatus: data.status } : {}),
    farmId: data.villageCode || 'farm-kaijiang-01',
    geom: coordinatesToGeom(data.coordinates),
  }
}

function toPlotServicePatch(data: PlotForm): Record<string, unknown> {
  // 空串也要发：后端把空串解释为「清空该字段」，剥掉会退化成「不改动」
  const patch: Record<string, unknown> = {
    parcelName: data.name,
    areaMu: data.areaMu,
    soilType: data.soilType ?? '',
    plotType: data.type,
    currentCrop: data.currentCrop ?? '',
    ownerName: data.ownerName ?? '',
    ownerPhone: data.ownerPhone ?? '',
    remark: data.remark ?? '',
  }
  if (data.status) patch.plotStatus = data.status
  // 老地块可能暂无边界，未重新绘制时不能用默认矩形覆盖原 geom
  if (data.coordinates && data.coordinates.length >= 3) patch.geom = coordinatesToGeom(data.coordinates)
  return patch
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
  /** 设备台账：关键词命中名称/编号，类型、状态、地块精确筛选，分页真实生效 */
  getDevices(params?: { page?: number | undefined; size?: number | undefined; keyword?: string | undefined; type?: string | undefined; status?: string | undefined; plotCode?: string | undefined }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/devices', cleanParams(params))
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
  /** 最新读数：兼容旧的 deviceId 字符串写法，也支持地块/指标筛选 */
  getLatest(params?: string | { deviceId?: string; plotCode?: string; metric?: string }): Promise<any[]> {
    const query = typeof params === 'string' ? { deviceId: params } : params
    return get<any[]>('/telemetry/latest', cleanParams(query))
  },
  /** 历史读数原始序列 */
  getHistory(params?: { deviceId?: string; metric?: string; from?: string; to?: string; size?: number }): Promise<any[]> {
    return get<any[]>('/telemetry/history', params)
  },
  /** 历史曲线：按时间升序返回 (时间, 数值)，供趋势图直接绑定 */
  getHistorySeries(deviceId: string, metric: string): Promise<TelemetryHistoryPoint[]> {
    return get<TelemetryHistoryPoint[]>('/telemetry/history/series', { deviceId, metric })
  },
  /** 待处置告警：可按级别/指标/地块筛选 */
  getAlerts(params?: { level?: MessageLevel; metric?: string; plotCode?: string }): Promise<any[]> {
    return get<any[]>('/telemetry/alerts', cleanParams(params))
  },
  /** 处理（关闭）一条遥测告警 */
  handleAlert(id: string): Promise<void> {
    return post<void>(`/telemetry/alerts/${encodeURIComponent(id)}/handle`)
  },
  /** 四情总览：一次拉齐最新读数、待处置告警、虫情记录与阈值规则；筛选参数缺省时返回全量 */
  getOverview(params?: { plotCode?: string; metric?: string; level?: MessageLevel; pestType?: string }): Promise<TelemetryOverview> {
    return get<TelemetryOverview>('/telemetry/overview', cleanParams(params))
  },
  /** 阈值规则维护：同一指标只保留一条规则 */
  getRules(): Promise<TelemetryRule[]> {
    return get<TelemetryRule[]>('/telemetry/rules')
  },
  saveRule(data: TelemetryRuleInput): Promise<TelemetryRule> {
    return post<TelemetryRule>('/telemetry/rules', data)
  },
  deleteRule(metric: string): Promise<void> {
    return del<void>(`/telemetry/rules/${encodeURIComponent(metric)}`)
  },
  /** 虫情识别记录，pendingOnly 只看未处置，可按虫害类型与程度筛选 */
  getPests(params?: { plotCode?: string; pendingOnly?: boolean; size?: number; pestType?: string; level?: 1 | 2 | 3 }): Promise<PestEvent[]> {
    return get<PestEvent[]>('/telemetry/pests', cleanParams(params))
  },
  /** 上报虫情识别结果：落库后自动生成告警与消息 */
  reportPest(data: { plotCode: string; deviceId: string; pestType: string; level: 1 | 2 | 3; confidence: number; imageFileId?: string; detectedAt?: string }): Promise<{ event: PestEvent; alert: TelemetryAlert }> {
    return post<{ event: PestEvent; alert: TelemetryAlert }>('/telemetry/pest-events', data)
  },
  /** 处置（关闭）一条虫情记录 */
  handlePest(id: string): Promise<void> {
    return post<void>(`/telemetry/pests/${encodeURIComponent(id)}/handle`)
  }
}

/** 阈值方向：above 高于上限、below 低于下限 */
export type RuleDirection = 'above' | 'below'
export type RuleLevel = 'INFO' | 'WARNING' | 'CRITICAL'

export interface TelemetryRule {
  id: string
  metric: string
  direction: RuleDirection
  threshold: number
  level: RuleLevel
  message: string
  enabled: boolean
  updatedAt: string
}

export interface TelemetryRuleInput {
  metric: string
  direction: RuleDirection
  threshold: number
  level: RuleLevel
  message: string
  enabled?: boolean
}

/** 虫情记录，level 1 轻微、2 中等、3 严重 */
export interface PestEvent {
  id: string
  plotCode: string
  deviceId: string
  pestType: string
  level: 1 | 2 | 3
  confidence: number
  imageFileId?: string
  detectedAt: string
  handled: boolean
}

export interface TelemetryOverview {
  latest: Array<{ deviceId: string; plotCode: string; metric: string; value: number; unit: string; recordedAt: string }>
  alerts: TelemetryAlert[]
  pests: PestEvent[]
  rules: TelemetryRule[]
}

export const weatherApi = {
  getForecast(): Promise<{ location: string; forecast: any[] }> {
    return get<{ location: string; forecast: any[] }>('/weather/forecast')
  }
}

export const operationApi = {
  getTasks(params?: { page?: number | undefined; size?: number | undefined; keyword?: string | undefined; status?: string | undefined; type?: string | undefined; plotCode?: string | undefined; from?: string | undefined; to?: string | undefined }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/farm-tasks', cleanParams(params))
  },
  createTask(data: { plotCode: string; type: string; name: string; scheduledAt?: string }): Promise<any> {
    return post<any>('/farm-tasks', data)
  },
  updateStatus(id: string, status: string): Promise<any> {
    return post<any>(`/farm-tasks/${id}/status`, { status })
  },
  /** 田间导航规划：最近邻排站 + 2-opt 优化，提供机耕道时按沿路里程计算 */
  planNavigation(data: NavigationRequest): Promise<NavPlan> {
    return post<NavPlan>('/operations/path-plan', data)
  },
  /** 最近的导航方案（进程内保留最近 20 条） */
  getPathPlans(): Promise<NavPlan[]> {
    return get<NavPlan[]>('/operations/path-plans')
  }
}

/** 导航站点：坐标同样为 [lng, lat] 拆分后的字段 */
export interface NavStop {
  code: string
  name?: string
  lng: number
  lat: number
}

export interface NavLeg {
  fromCode: string
  fromName: string
  toCode: string
  toName: string
  distanceM: number
  durationMin: number
  viaRoad: boolean
}

export interface NavPlan {
  planId: string
  order: string[]
  distanceM: number
  durationMin: number
  legs: NavLeg[]
  polyline: GeoLineString
  warnings: string[]
}

export interface NavigationRequest {
  start: NavStop
  stops: NavStop[]
  speedKmh?: number
  roadNetwork?: GeoLineString[]
  returnToStart?: boolean
}

export const controlApi = {
  getCommands(params?: { plotCode?: string; origin?: 'EVENT' | 'MANUAL'; type?: string; status?: string; deviceId?: string; from?: string; to?: string; page?: number; size?: number }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/control/commands', cleanParams(params))
  },
  sendCommand(data: { deviceId: string; plotCode?: string; type: string; parameters?: Record<string, unknown> }): Promise<any> {
    return post<any>('/control/commands', data, { headers: { 'X-Confirm-Action': 'CONFIRM' } })
  },
  /** 变量灌溉方案预演：只算不执行，返回分区时序与累计供水曲线 */
  buildIrrigationPlan(data: IrrigationPlanInput): Promise<IrrigationPlan> {
    return post<IrrigationPlan>('/control/irrigation-plans', data, { headers: { 'X-Confirm-Action': 'CONFIRM' } })
  }
}

/** 水肥方案入参：分区按亩与毫米给定额，可附带配比与搅拌 */
export interface IrrigationPlanInput {
  plotCode?: string
  zones: Array<{ zoneCode?: string; areaMu: number; targetMm: number }>
  flowM3h?: number
  recipe?: { nitrogen: number; phosphorus: number; potassium: number }
  stir?: { durationMin: number; rpm: number }
}

export interface IrrigationPlan {
  plotCode: string
  flowM3h: number
  totalAreaMu: number
  totalWaterVolume: number
  totalDurationMin: number
  zones: Array<{ zoneCode: string; areaMu: number; targetMm: number; waterVolume: number; durationMin: number; startMin: number; endMin: number }>
  curve: Array<{ minute: number; flowM3h: number; cumulativeM3: number }>
  recipe?: { nitrogen: number; phosphorus: number; potassium: number; totalKg: number }
  stir?: { durationMin: number; rpm: number }
  warnings: string[]
}

/** 投入产出查询：地块之外的 kind/category/season/关键词/时间区间筛选 */
export interface FinanceQuery {
  plotCode?: string
  kind?: 'INPUT' | 'OUTPUT'
  category?: string
  season?: string
  keyword?: string
  from?: string
  to?: string
}

export const financeApi = {
  getEntries(params?: FinanceQuery): Promise<any[]> {
    return get<any[]>('/finance/entries', cleanParams(params))
  },
  /** 汇总与列表同一套筛选条件，卡片数字随查询条联动 */
  getSummary(params?: FinanceQuery): Promise<{ input: number; output: number; profit: number; currency: string }> {
    return get<{ input: number; output: number; profit: number; currency: string }>('/finance/summary', cleanParams(params))
  },
  createEntry(data: { plotCode: string; season: string; kind: 'INPUT' | 'OUTPUT'; category: string; amount: number; unit: string; note: string }): Promise<any> {
    return post<any>('/finance/entries', data)
  }
}

export const traceApi = {
  getRecords(params?: { plotCode?: string; event?: string; keyword?: string; from?: string; to?: string; page?: number; size?: number }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/trace/records', cleanParams(params))
  },
  createRecord(data: { plotCode: string; event: string; detail: string; operator: string }): Promise<any> {
    return post<any>('/trace/records', data)
  },
  getByCode(traceCode: string): Promise<any> {
    return get<any>(`/trace/${traceCode}`)
  }
}

export const videoApi = {
  getCameras(params?: { page?: number; size?: number; keyword?: string; plotCode?: string; status?: string }): Promise<PageResult<Camera>> {
    return get<PageResult<Camera>>('/video/cameras', cleanParams(params))
  },
  getCamera(cameraId: string): Promise<Camera | null> {
    return get<Camera | null>(`/video/cameras/${encodeURIComponent(cameraId)}`)
  },
  sendPtz(cameraId: string, command: Record<string, unknown>): Promise<{ commandId: string; status: string }> {
    return post<{ commandId: string; status: string }>(`/video/cameras/${encodeURIComponent(cameraId)}/ptz`, command)
  },
  getRecordings(params?: { page?: number; size?: number; cameraId?: string; plotCode?: string; from?: string; to?: string }): Promise<PageResult<Recording>> {
    return get<PageResult<Recording>>('/video/recordings', cleanParams(params))
  }
}

export type { TelemetryHistoryPoint, TelemetryAlert, MessagePreference, MessageLevel }

export interface MessageQuery {
  page?: number
  size?: number
  type?: 'ALERT' | 'NOTICE'
  level?: MessageLevel
  read?: boolean
  plotCode?: string
  keyword?: string
  from?: string
  to?: string
}

/** 消息中心：页面通知与事件消费生成的告警共用同一份消息 */
export const messageApi = {
  getList(params?: MessageQuery): Promise<PageResult<any>> {
    return get<PageResult<any>>('/messages', cleanParams(params))
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
