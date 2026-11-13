import { get, post, put, del } from '@/utils/request'
import type {
  Plot, PlotQuery, PlotForm, PlotType, InfraLineType,
  CropSeason, CropSeasonStatus,
  PlotChangeLog,
  Device, DeviceRealtimeData,
  DeviceFieldAccess, DeviceModbusBinding,
  FarmTask, FarmTaskQuery,
  DashboardStats,
  PageResult, LoginParams, LoginResult,
  Camera, PlotStats, Recording, PtzAction, PtzCommand, VideoAiEvent,
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
  /**
   * 一张图建档：只给名称/类型/面积/边界，编码分段走默认行政区，状态由后端置为种植中。
   * 与表单建档分开，避免地图入口被迫编造行政区划与编码。
   */
  createFromMap(data: { name: string; type: PlotType; areaMu: number; coordinates: [number, number][]; zoneCode?: string }): Promise<Plot> {
    const form: PlotForm = { name: data.name, regionCode: '', villageCode: '', type: data.type, areaMu: data.areaMu, coordinates: data.coordinates }
    return post<Plot>('/plots', { ...toPlotServiceInput(form), ...(data.zoneCode ? { zoneCode: data.zoneCode } : {}) }).then(normalizePlot)
  },
  /** 局部更新：只发传入的字段。update() 会把未填的档案字段发成空串从而清空，地图改边界不能用它。 */
  patch(id: string, fields: { parcelName?: string; areaMu?: number; plotType?: PlotType; zoneCode?: string | null; geom?: GeoPolygon }): Promise<Plot> {
    return put<Plot>(`/plots/${encodeURIComponent(id)}`, fields).then(normalizePlot)
  },
  delete(id: string): Promise<void> {
    return del<void>(`/plots/${encodeURIComponent(id)}`)
  },
  async batchDelete(parcelCodes: string[]): Promise<{ succeededCodes: string[]; failedCodes: string[] }> {
    // 等待全部请求结束再刷新；单个失败不能掩盖已删除的地块或提前结束整批。
    const results = await Promise.allSettled(parcelCodes.map((parcelCode) => plotApi.delete(parcelCode)))
    const succeededCodes: string[] = []
    const failedCodes: string[] = []
    results.forEach((result, index) => {
      const parcelCode = parcelCodes[index]!
      if (result.status === 'fulfilled') succeededCodes.push(parcelCode)
      else failedCodes.push(parcelCode)
    })
    return { succeededCodes, failedCodes }
  },
  /**
   * 合并预演：与真实合并同一套相邻判定与凸包面积，只算不写。
   * deltaMu 是凸包比源地块台账面积之和多出的亩数，即被圈进来的中间空地。
   */
  mergePreview(parcelCodes: string[]): Promise<{
    parcelCodes: string[]
    sources: Array<{ parcelCode: string; parcelName: string; areaMu: number }>
    sourceAreaMu: number
    hullAreaMu: number
    deltaMu: number
    adjacent: boolean
    groups: string[][]
    toleranceM: number
    geom: GeoPolygon | null
  }> {
    return post('/plots/merge-preview', { parcelCodes })
  },
  /**
   * 合并地块：服务端要求所选地块边界相邻，不相邻时返回 409 并列出分成几组。
   * 通过后边界取源地块顶点凸包，面积由后端按合并边界现算；源地块整批归档。
   */
  merge(data: { parcelCodes: string[]; parcelName?: string; plotType?: PlotType; remark?: string }): Promise<{ plot: Plot; sourceCodes: string[] }> {
    return post<{ plot: any; sourceCodes: string[] }>('/plots/merge', data)
      .then((result) => ({ plot: normalizePlot(result.plot), sourceCodes: result.sourceCodes }))
  },
  /** 拆分地块：子块边界由页面绘制提交，面积各按子块几何现算；默认归档原地块 */
  split(data: { parcelCode: string; pieces: Array<{ parcelName: string; geom: GeoPolygon }>; keepSource?: boolean }): Promise<{ plots: Plot[]; sourceCode: string; sourceRemoved: boolean; pieceAreaSum: number }> {
    return post<{ plots: any[]; sourceCode: string; sourceRemoved: boolean; pieceAreaSum: number }>('/plots/split', data)
      .then((result) => ({ ...result, plots: result.plots.map(normalizePlot) }))
  },
  /** 一张图用：全量地块边界，不分页 */
  getBounds(): Promise<Array<{ parcelCode: string; parcelName: string; areaMu: number; geom: unknown }>> {
    return get('/plots/bounds')
  },
  /** 看板用：地块总量、总面积与土壤类型分布（当前作物业未入库，暂按土壤类型汇总） */
  getStats(): Promise<PlotStats> {
    return get('/plots/stats')
  },
  /** 一张图用：田间线路/管线（灌水管、施肥管、电力线、机耕道）。可按类型或归属地块过滤 */
  getInfraLines(params?: { lineType?: InfraLineType | undefined; plotCode?: string | undefined }): Promise<InfraLine[]> {
    return get<InfraLine[]>('/plots/infra-lines', params)
  },
  createInfraLine(data: { lineName: string; lineType: InfraLineType; geom: { type: 'LineString'; coordinates: number[][]; srid: number }; lineCode?: string; plotCode?: string }): Promise<InfraLine> {
    return post<InfraLine>('/plots/infra-lines', data)
  },
  /** 局部更新：只发传入字段；改了 geom 时服务端按新折点重算 lengthM */
  updateInfraLine(lineCode: string, data: { lineName?: string; lineType?: InfraLineType; geom?: { type: 'LineString'; coordinates: number[][]; srid: number }; plotCode?: string }): Promise<InfraLine> {
    return put<InfraLine>(`/plots/infra-lines/${encodeURIComponent(lineCode)}`, data)
  },
  deleteInfraLine(lineCode: string): Promise<void> {
    return del<void>(`/plots/infra-lines/${encodeURIComponent(lineCode)}`)
  },
  /** 种植季/茬口：按地块返回轮作正序（不传 plotCode 则跨地块列最近茬口），可按作物/年份/状态过滤 */
  getSeasons(params?: { plotCode?: string | undefined; crop?: string | undefined; year?: string | undefined; status?: CropSeasonStatus | undefined }): Promise<CropSeason[]> {
    return get<CropSeason[]>('/plots/seasons', cleanParams(params))
  },
  createSeason(data: { plotCode: string; crop: string; seasonYear: number; variety?: string; seasonIndex?: number; plantDate?: string; harvestDate?: string; status?: CropSeasonStatus; yieldKg?: number | null; note?: string }): Promise<CropSeason> {
    return post<CropSeason>('/plots/seasons', data)
  },
  /** 局部更新：只发传入字段 */
  updateSeason(seasonCode: string, data: { plotCode?: string; crop?: string; variety?: string; seasonYear?: number; seasonIndex?: number; plantDate?: string; harvestDate?: string; status?: CropSeasonStatus; yieldKg?: number | null; note?: string }): Promise<CropSeason> {
    return put<CropSeason>(`/plots/seasons/${encodeURIComponent(seasonCode)}`, data)
  },
  deleteSeason(seasonCode: string): Promise<void> {
    return del<void>(`/plots/seasons/${encodeURIComponent(seasonCode)}`)
  },
  /** 地块变更历史：追加式留痕，倒序返回（最近在前） */
  getHistory(parcelCode: string): Promise<PlotChangeLog[]> {
    return get<PlotChangeLog[]>(`/plots/${encodeURIComponent(parcelCode)}/history`)
  }
}
/** 管线类型定义在 @/types，这里转出保持既有引用路径 */
export type { InfraLineType }

export interface InfraLine {
  id: string
  lineCode: string
  lineName: string
  lineType: InfraLineType
  geom: { type: 'LineString'; coordinates: number[][]; srid: number }
  lengthM: number
  /** 归属地块编码（plots.parcelCode），空串表示未绑定地块 */
  plotCode: string
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

/** [经度, 纬度] 顶点 → 闭合 Polygon；库内统一 CGCS2000（EPSG:4490） */
export function toPolygonGeom(points: Array<[number, number]>): GeoPolygon {
  const first = points[0]!
  const last = points[points.length - 1]!
  const ring = first[0] === last[0] && first[1] === last[1] ? points : [...points, first]
  return { type: 'Polygon', coordinates: [ring.map(([lng, lat]) => [lng, lat])], srid: 4490 }
}

function coordinatesToGeom(coordinates?: [number, number][]): Record<string, unknown> {
  const points = coordinates && coordinates.length >= 3 ? coordinates : [[107.8421, 30.9942], [107.8433, 30.9942], [107.8433, 30.9951], [107.8421, 30.9951], [107.8421, 30.9942]] as [number, number][]
  return toPolygonGeom(points)
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
  /** 设备台账：关键词命中名称/编号，类型、状态、地块、接入协议精确筛选，分页真实生效 */
  getDevices(params?: { page?: number | undefined; size?: number | undefined; keyword?: string | undefined; type?: string | undefined; status?: string | undefined; plotCode?: string | undefined; protocol?: string | undefined }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/devices', cleanParams(params))
  },
  getDevice(id: string): Promise<any> {
    return get<any>(`/devices/${encodeURIComponent(id)}`)
  },
  /** 现场接入目录：协议、剖面与端口/单元标识/超时缺省值由服务端给出，前端不复制这些常量 */
  getFieldAccess(): Promise<DeviceFieldAccess> {
    return get<DeviceFieldAccess>('/devices/field-access')
  },
  /** 登记新设备：deviceNo 台账内唯一，type/status 取值见 utils/device.ts；返回的 lastSeenAt 为 null 表示尚未上报 */
  createDevice(data: { deviceNo: string; name: string; type: string; status: 'ONLINE' | 'OFFLINE'; plotCode?: string | undefined; protocol?: string | undefined; binding?: DeviceModbusBinding | undefined }): Promise<any> {
    return post<any>('/devices', data)
  },
  /** 台账配置编辑：字段省略即不改，plotCode 传空串表示解绑地块；设备编号不可改 */
  updateDevice(id: string, data: { name?: string; type?: string; status?: 'ONLINE' | 'OFFLINE'; plotCode?: string; protocol?: string; binding?: DeviceModbusBinding | null }): Promise<any> {
    return put<any>(`/devices/${encodeURIComponent(id)}`, data)
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
  /** 最新读数：兼容旧的 deviceId 字符串写法，也支持地块/指标/分层深度筛选 */
  getLatest(params?: string | { deviceId?: string; plotCode?: string; metric?: string; depthCm?: number }): Promise<any[]> {
    const query = typeof params === 'string' ? { deviceId: params } : params
    return get<any[]>('/telemetry/latest', cleanParams(query))
  },
  /** 历史读数原始序列 */
  getHistory(params?: { deviceId?: string; plotCode?: string; metric?: string; depthCm?: number; from?: string; to?: string; size?: number }): Promise<any[]> {
    return get<any[]>('/telemetry/history', cleanParams(params))
  },
  /** 历史曲线：按时间升序返回 (时间, 数值)，供趋势图直接绑定；extra 支持按地块/深度/时间窗筛选 */
  getHistorySeries(deviceId: string, metric: string, extra?: { plotCode?: string; depthCm?: number; from?: string; to?: string; size?: number }): Promise<TelemetryHistoryPoint[]> {
    return get<TelemetryHistoryPoint[]>('/telemetry/history/series', cleanParams({ deviceId, metric, ...extra }))
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
  /** 阈值规则维护：按 (指标, 地块, 级别) 唯一；传 plotCode 时返回该地块专属 + 全局兜底 */
  getRules(plotCode?: string): Promise<TelemetryRule[]> {
    return get<TelemetryRule[]>('/telemetry/rules', cleanParams(plotCode ? { plotCode } : undefined))
  },
  saveRule(data: TelemetryRuleInput): Promise<TelemetryRule> {
    return post<TelemetryRule>('/telemetry/rules', data)
  },
  deleteRule(metric: string, plotCode?: string, level?: RuleLevel): Promise<void> {
    return del<void>(`/telemetry/rules/${encodeURIComponent(metric)}`, cleanParams({ plotCode, level }))
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
  },
  /** 虫情区域统计：按等级/类型/地块聚合，可按地块与时间窗筛选 */
  getPestStats(params?: { plotCode?: string; pestType?: string; from?: string; to?: string }): Promise<PestStats> {
    return get<PestStats>('/telemetry/pests/stats', cleanParams(params))
  },
  /** 虫情趋势：最近 days 天的逐日识别计数（农场东八区日历日） */
  getPestTrend(params?: { days?: number; plotCode?: string; pestType?: string }): Promise<PestTrendPoint[]> {
    return get<PestTrendPoint[]>('/telemetry/pests/trend', cleanParams(params))
  },
  /** 虫情治理：记录药剂方案与派单信息并推进治理状态，taskId 为派单生成的植保任务 */
  governPest(id: string, data: GovernPestInput): Promise<PestEvent> {
    return post<PestEvent>(`/telemetry/pests/${encodeURIComponent(id)}/govern`, data)
  },
  /** 苗情生育期档案：按地块回看计划节点与实际节点，登记即幂等更新 */
  getGrowthStages(plotCode?: string): Promise<GrowthStage[]> {
    return get<GrowthStage[]>('/telemetry/growth-stages', cleanParams(plotCode ? { plotCode } : undefined))
  },
  saveGrowthStage(data: GrowthStageInput): Promise<GrowthStage> {
    return post<GrowthStage>('/telemetry/growth-stages', data)
  },
  deleteGrowthStage(id: string): Promise<void> {
    return del<void>(`/telemetry/growth-stages/${encodeURIComponent(id)}`)
  },
  /** 灾情档案（开发方案 6.4）：上报落库即 REPORTED，处置沿状态单向推进 */
  getDisasters(params?: { plotCode?: string; disasterType?: string; status?: string; size?: number }): Promise<DisasterRecord[]> {
    return get<DisasterRecord[]>('/telemetry/disasters', cleanParams(params))
  },
  getDisasterStats(params?: { plotCode?: string }): Promise<DisasterStats> {
    return get<DisasterStats>('/telemetry/disasters/stats', cleanParams(params))
  },
  createDisaster(data: CreateDisasterInput): Promise<DisasterRecord> {
    return post<DisasterRecord>('/telemetry/disasters', data)
  },
  supplementDisaster(id: string, data: SupplementDisasterInput): Promise<DisasterRecord> {
    return post<DisasterRecord>(`/telemetry/disasters/${encodeURIComponent(id)}/supplement`, data)
  }
}

/** 阈值方向：above 高于上限、below 低于下限 */
export type RuleDirection = 'above' | 'below'
export type RuleLevel = 'INFO' | 'WARNING' | 'CRITICAL'

export interface TelemetryRule {
  id: string
  metric: string
  /** 适用地块编码；空串表示全局默认规则 */
  plotCode: string
  direction: RuleDirection
  threshold: number
  level: RuleLevel
  message: string
  enabled: boolean
  updatedAt: string
}

export interface TelemetryRuleInput {
  metric: string
  plotCode?: string
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
  /** 治理状态：待处置/已定方案/已派单/已归档 */
  governanceStatus: GovernanceStatus
  measure: string
  pesticide: string
  dosage: string
  dispatchNote: string
  governedBy: string
  governedAt?: string
  /** 一键派单生成的植保农事任务 id */
  taskId?: string
}

/** 虫情治理状态 */
export type GovernanceStatus = 'pending' | 'planned' | 'dispatched' | 'archived'

/** 虫情区域统计（按等级/类型/地块聚合） */
export interface PestStats {
  total: number
  pending: number
  byLevel: Array<{ level: 1 | 2 | 3; count: number }>
  byType: Array<{ pestType: string; count: number }>
  byPlot: Array<{ plotCode: string; count: number }>
}

/** 虫情趋势逐日点 */
export interface PestTrendPoint {
  date: string
  count: number
}

/** 治理入参：状态向前推进，药剂方案与派单信息选填 */
export interface GovernPestInput {
  status: Exclude<GovernanceStatus, 'pending'>
  measure?: string
  pesticide?: string
  dosage?: string
  dispatchNote?: string
  governedBy?: string
  taskId?: string
}

export interface TelemetryOverview {
  latest: Array<{ deviceId: string; plotCode: string; metric: string; value: number; unit: string; recordedAt: string; depthCm?: number }>
  alerts: TelemetryAlert[]
  pests: PestEvent[]
  rules: TelemetryRule[]
}

/** 苗情生育期档案：stage 为生育期编码，planned_* 计划节点、actual_* 田间实测节点 */
export interface GrowthStage {
  id: string
  plotCode: string
  stage: string
  plannedStartAt?: string
  plannedEndAt?: string
  actualStartAt?: string
  actualEndAt?: string
  note: string
  updatedAt: string
}

export interface GrowthStageInput {
  plotCode: string
  stage: string
  plannedStartAt?: string
  plannedEndAt?: string
  actualStartAt?: string
  actualEndAt?: string
  note?: string
}

/** 灾种编码（开发方案 6.4）：干旱/洪涝/低温冻害/大风倒伏/冰雹/病虫害 */
export type DisasterType = 'drought' | 'flood' | 'frost' | 'wind' | 'hail' | 'pest'
/** 处置状态：已上报 / 已核查 / 已处置 / 已归档 */
export type DisasterStatus = 'REPORTED' | 'ASSESSED' | 'HANDLED' | 'ARCHIVED'
/** 灾害分级 1 轻度、2 中度、3 重度、4 特别重大 */
export type DisasterSeverity = 1 | 2 | 3 | 4

export interface DisasterRecord {
  id: string
  disasterType: DisasterType
  plotCode: string
  affectedAreaMu: number
  severity: DisasterSeverity
  occurredAt: string
  suggestion: string
  status: DisasterStatus
  lossAssessment: string
  imageFileIds: string[]
  reportedBy: string
  handledBy: string
  handledAt?: string
  createdAt: string
  updatedAt: string
}

export interface CreateDisasterInput {
  disasterType: DisasterType
  plotCode: string
  affectedAreaMu: number
  severity: DisasterSeverity
  occurredAt: string
  suggestion?: string
  imageFileIds?: string[]
  reportedBy?: string
}

export interface SupplementDisasterInput {
  status?: DisasterStatus
  suggestion?: string
  lossAssessment?: string
  affectedAreaMu?: number
  imageFileIds?: string[]
  handledBy?: string
}

export interface DisasterStats {
  total: number
  open: number
  affectedAreaMu: number
  byType: Array<{ disasterType: DisasterType; count: number; affectedAreaMu: number }>
  bySeverity: Array<{ severity: DisasterSeverity; count: number }>
}

export const weatherApi = {
  getForecast(params?: { days?: number | undefined; hours?: number | undefined }): Promise<any> {
    return get('/weather/forecast', cleanParams(params))
  },
  getRealtime(params?: { plotCode?: string | undefined; deviceId?: string | undefined }): Promise<any> {
    return get('/weather/realtime', cleanParams(params))
  },
  getHourly(params?: { hours?: number | undefined }): Promise<any> {
    return get('/weather/forecast/hourly', cleanParams(params))
  },
  getAlerts(params?: { level?: string | undefined; alertType?: string | undefined; plotCode?: string | undefined; active?: string | undefined; page?: number | undefined; size?: number | undefined }): Promise<any> {
    return get('/weather/alerts', cleanParams(params))
  },
  getHistory(params?: { metric?: string | undefined; plotCode?: string | undefined; from?: string | undefined; to?: string | undefined; size?: number | undefined }): Promise<any> {
    return get('/weather/history', cleanParams(params))
  },
  getAdvice(): Promise<any> {
    return get('/weather/advice')
  },
  getMetrics(): Promise<any[]> {
    return get('/weather/metrics')
  },
  /** 同步器状态：管理员观测 todayCalls / dailyCallLimit / forceSyncCount */
  getSyncStatus(): Promise<any> {
    return get('/weather/sync-status')
  },
  /** 管理员强制同步：bypass dailyCallLimit，需 weather:sync 权限 */
  syncNow(): Promise<any> {
    return post('/weather/sync-now', {})
  }
}

export const operationApi = {
  getTasks(params?: { page?: number | undefined; size?: number | undefined; keyword?: string | undefined; status?: string | undefined; type?: string | undefined; plotCode?: string | undefined; from?: string | undefined; to?: string | undefined; archived?: 'NONE' | 'ONLY' | 'ALL' | undefined }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/farm-tasks', cleanParams(params))
  },
  createTask(data: { plotCode: string; type: string; name: string; scheduledAt?: string; scheduledEndAt?: string; assigneeName?: string }): Promise<any> {
    return post<any>('/farm-tasks', data)
  },
  /** 单条任务详情：含 startedAt/completedAt 实际作业时间，不存在时服务端返回 404；
   *  includeArchived 只放行归档行的回查，状态流转与删除仍按在册口径 */
  getTask(id: string, includeArchived = false): Promise<any> {
    return get<any>(`/farm-tasks/${encodeURIComponent(id)}`, includeArchived ? { includeArchived: 'true' } : undefined)
  },
  /** 状态流转必须带当前 version 防并发覆盖；完成时必须附实际作业结果 */
  updateStatus(id: string, status: string, options?: { version?: number; result?: { outcome: 'success' | 'partial' | 'failed'; finishedAreaMu: number; notes?: string } }): Promise<any> {
    return post<any>(`/farm-tasks/${encodeURIComponent(id)}/status`, { status, ...options })
  },
  /** 删除是软删归档（与地块/片区同一口径）：列表与详情此后读不到，行留在库里 */
  deleteTask(id: string): Promise<any> {
    return del<any>(`/farm-tasks/${encodeURIComponent(id)}`)
  },
  /** 田间导航规划：最近邻排站 + 2-opt 优化，提供机耕道时按沿路里程计算 */
  planNavigation(data: NavigationRequest): Promise<NavPlan> {
    return post<NavPlan>('/operations/path-plan', data)
  },
  /** 最近的导航方案（进程内保留最近 20 条） */
  getPathPlans(): Promise<NavPlan[]> {
    return get<NavPlan[]>('/operations/path-plans')
  },
  /** 全地块覆盖式作业规划：按幅宽铺牛耕式作业带，返回连续路径与作业/转移里程 */
  planCoverage(data: CoverageRequest): Promise<CoveragePlan> {
    return post<CoveragePlan>('/operations/coverage-plan', data)
  },
  /** 最近的覆盖方案（进程内保留最近 20 条） */
  getCoveragePlans(): Promise<CoveragePlan[]> {
    return get<CoveragePlan[]>('/operations/coverage-plans')
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

/** 覆盖式作业规划入参：幅宽与重叠决定作业带间距，方向不填则由服务端自动挑 */
export interface CoverageRequest {
  plotCode: string
  boundary: GeoPolygon
  implementWidthM: number
  overlapM?: number
  headingDeg?: number
  speedKmh?: number
  turnSpeedKmh?: number
  start?: { lng: number; lat: number }
  /** 地块台账面积（亩），服务端用于算覆盖倍数；不传则按几何现算 */
  areaMu?: number
}

export interface CoverageLane {
  /** 作业顺序，从 1 开始 */
  index: number
  /** 同一条扫描线上的第几段，>1 说明地块含凹部或内环 */
  pass: number
  /** 作业带两端，按行进顺序 [lng, lat] */
  coordinates: number[][]
  lengthM: number
}

export interface CoveragePlan {
  planId: string
  plotCode: string
  headingDeg: number
  headingAuto: boolean
  implementWidthM: number
  overlapM: number
  laneSpacingM: number
  laneCount: number
  turnCount: number
  lanes: CoverageLane[]
  workDistanceM: number
  transferDistanceM: number
  totalDistanceM: number
  durationMin: number
  areaMu: number
  /** 按幅宽铺出的面积 / 地块面积：>1 有重复覆盖，<1 有漏作业 */
  coverageRatio: number
  path: GeoLineString
  warnings: string[]
}

export const controlApi = {
  getCommands(params?: { plotCode?: string; origin?: 'EVENT' | 'MANUAL'; type?: string; status?: string; deviceId?: string; from?: string; to?: string; pending?: boolean; overdue?: boolean; page?: number; size?: number }): Promise<PageResult<any>> {
    return get<PageResult<any>>('/control/commands', cleanParams(params))
  },
  /** 人工下发控制指令：需二次确认头，reason 写明处置依据供指令列表与生产档案复盘 */
  sendCommand(data: { deviceId: string; plotCode?: string; type: string; parameters?: Record<string, unknown>; reason?: string }): Promise<any> {
    return post<any>('/control/commands', data, { headers: { 'X-Confirm-Action': 'CONFIRM' } })
  },
  /** 标记指令已下发到设备（QUEUED→SENT）；设备网关接入前由人工确认这一步真实发生 */
  dispatchCommand(commandId: string): Promise<any> {
    return post<any>('/control/device/dispatch', { commandId })
  },
  /** 登记设备回执：ACKED 已接收、DONE 执行到位、FAILED 失败（急停的 DONE 必须带到位确认） */
  reportReceipt(data: { commandId: string; status: 'ACKED' | 'DONE' | 'FAILED'; message?: string; result?: Record<string, unknown> }): Promise<any> {
    return post<any>('/control/device/receipt', data)
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

/** 核算报表：按月（东八区）、按类别、按地块三维聚合 */
export interface FinanceReport {
  months: Array<{ month: string; input: number; output: number; profit: number }>
  categories: Array<{ kind: 'INPUT' | 'OUTPUT'; category: string; amount: number }>
  plots: Array<{ plotCode: string; input: number; output: number; profit: number }>
}

export const financeApi = {
  getEntries(params?: FinanceQuery): Promise<any[]> {
    return get<any[]>('/finance/entries', cleanParams(params))
  },
  /** 汇总与列表同一套筛选条件，卡片数字随查询条联动 */
  getSummary(params?: FinanceQuery): Promise<{ input: number; output: number; profit: number; currency: string }> {
    return get<{ input: number; output: number; profit: number; currency: string }>('/finance/summary', cleanParams(params))
  },
  /** 报表与列表/汇总共用同一套筛选条件，图表随查询条联动 */
  getReport(params?: FinanceQuery): Promise<FinanceReport> {
    return get<FinanceReport>('/finance/report', cleanParams(params))
  },
  createEntry(data: { plotCode: string; season: string; kind: 'INPUT' | 'OUTPUT'; category: string; amount: number; unit: string; note: string }): Promise<any> {
    return post<any>('/finance/entries', data)
  }
}

/** 溯源档案记录：batchCode 为溯源码，同一溯源码下多条事件串成一条链 */
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

export const traceApi = {
  getRecords(params?: { plotCode?: string; event?: string; batchCode?: string; keyword?: string; from?: string; to?: string; page?: number; size?: number }): Promise<PageResult<TraceRecord>> {
    return get<PageResult<TraceRecord>>('/trace/records', cleanParams(params))
  },
  createRecord(data: { plotCode: string; event: string; detail: string; operator: string; batchCode?: string }): Promise<TraceRecord> {
    return post<TraceRecord>('/trace/records', data)
  },
  getByCode(traceCode: string): Promise<TraceRecord | null> {
    return get<TraceRecord | null>(`/trace/${encodeURIComponent(traceCode)}`)
  },
  /** 按溯源码取完整生产链条，时间正序 */
  getChain(batchCode: string): Promise<TraceRecord[]> {
    return get<TraceRecord[]>(`/trace/chain/${encodeURIComponent(batchCode)}`)
  }
}

export const videoApi = {
  getCameras(params?: { page?: number; size?: number; keyword?: string; plotCode?: string; status?: string }): Promise<PageResult<Camera>> {
    return get<PageResult<Camera>>('/video/cameras', cleanParams(params))
  },
  getCamera(cameraId: string): Promise<Camera | null> {
    return get<Camera | null>(`/video/cameras/${encodeURIComponent(cameraId)}`)
  },
  sendPtz(cameraId: string, command: { action: PtzAction; speed?: number }): Promise<PtzCommand> {
    return post<PtzCommand>(`/video/cameras/${encodeURIComponent(cameraId)}/ptz`, command)
  },
  getPtzCommands(params?: { page?: number; size?: number; cameraId?: string }): Promise<PageResult<PtzCommand>> {
    return get<PageResult<PtzCommand>>('/video/ptz-commands', cleanParams(params))
  },
  retryPtz(commandId: string): Promise<PtzCommand> {
    return post<PtzCommand>(`/video/ptz-commands/${encodeURIComponent(commandId)}/retry`, {})
  },
  getRecordings(params?: { page?: number; size?: number; cameraId?: string; plotCode?: string; from?: string; to?: string }): Promise<PageResult<Recording>> {
    return get<PageResult<Recording>>('/video/recordings', cleanParams(params))
  },
  getAiEvents(params?: { page?: number; size?: number; plotCode?: string; forwarded?: boolean }): Promise<PageResult<VideoAiEvent>> {
    return get<PageResult<VideoAiEvent>>('/video/ai-events', cleanParams(params))
  },
  retryAiEvent(eventId: string): Promise<VideoAiEvent> {
    return post<VideoAiEvent>(`/video/ai-events/${encodeURIComponent(eventId)}/retry`, {})
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
