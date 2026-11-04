// 通用分页响应
export interface PageResult<T = unknown> {
  items: T[];
  total: number;
  page: number;
  size: number;
  /** 兼容旧版服务的字段，新增接口统一使用 items/size。 */
  list?: T[];
  pageSize?: number;
}

// 通用API响应
export interface ApiResponse<T = unknown> {
  code: number | string;
  message: string;
  data: T;
  success?: boolean;
  requestId?: string;
  timestamp: number;
}

// 地块状态枚举
export enum PlotStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  FALLOW = 'FALLOW',
  ARCHIVED = 'ARCHIVED'
}

// 地块类型枚举
export enum PlotType {
  FIELD = 'FIELD',
  GREENHOUSE = 'GREENHOUSE',
  ORCHARD = 'ORCHARD',
  AQUACULTURE = 'AQUACULTURE'
}

// 土壤类型
export enum SoilType {
  LOAM = 'LOAM',
  CLAY = 'CLAY',
  SAND = 'SAND',
  SILT = 'SILT',
  PEAT = 'PEAT'
}

// 设备状态
export enum DeviceStatus {
  OFFLINE = 'OFFLINE',
  ONLINE = 'ONLINE',
  FAULT = 'FAULT',
  MAINTENANCE = 'MAINTENANCE'
}

// 农事任务状态
export enum FarmTaskStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

// 事件主题
export enum EventTopic {
  PLOT_CREATED = 'plot.created',
  PLOT_UPDATED = 'plot.updated',
  DEVICE_DATA_REPORTED = 'device.data.reported',
  FARM_TASK_CREATED = 'farm.task.created'
}

// 地块信息
export interface Plot {
  id: string;
  parcelCode: string;
  name: string;
  regionCode: string;
  regionName: string;
  villageCode: string;
  villageName: string;
  type: PlotType;
  status: PlotStatus;
  areaMu: number;
  gridCode: string;
  soilType?: SoilType;
  ownerName?: string;
  ownerPhone?: string;
  coordinates?: [number, number][];
  boundary?: unknown;
  currentCrop?: string;
  currentSeasonId?: string;
  remark?: string;
  createdAt: string;
  updatedAt: string;
  /** 地块边界几何，CGCS2000 GeoJSON Polygon */
  geom?: unknown;
}

// 地块查询参数
export interface PlotQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  regionCode?: string;
  villageCode?: string;
  type?: PlotType | undefined;
  status?: PlotStatus | undefined;
  soilType?: SoilType | undefined;
}

// 创建/编辑地块参数
export interface PlotForm {
  name: string;
  regionCode: string;
  villageCode: string;
  type: PlotType;
  areaMu: number;
  soilType?: SoilType | undefined;
  ownerName?: string;
  ownerPhone?: string;
  coordinates?: [number, number][];
  currentCrop?: string;
  remark?: string;
}

// 设备信息
export interface Device {
  id: string;
  deviceCode: string;
  name: string;
  type: string;
  model: string;
  manufacturer: string;
  status: DeviceStatus;
  parcelCode?: string;
  parcelName?: string;
  installLocation?: string;
  lastOnlineTime?: string;
  firmwareVersion?: string;
  createdAt: string;
}

// 设备查询参数
export interface DeviceQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: DeviceStatus | undefined;
}
export interface DeviceRealtimeData {
  deviceId: string;
  deviceCode: string;
  deviceName: string;
  timestamp: string;
  metrics: {
    airTemperature?: number;
    airHumidity?: number;
    soilTemperature?: number;
    soilHumidity?: number;
    lightIntensity?: number;
    co2Concentration?: number;
    windSpeed?: number;
    windDirection?: number;
    rainfall?: number;
    soilPh?: number;
  };
  batteryLevel?: number;
  signalStrength?: number;
}

// 农事任务
export interface FarmTask {
  id: string;
  taskName: string;
  taskType: string;
  parcelCode: string;
  parcelName: string;
  status: FarmTaskStatus;
  assigneeId?: string;
  assigneeName?: string;
  planStartDate: string;
  planEndDate: string;
  actualStartDate?: string;
  actualEndDate?: string;
  description?: string;
  operatorName?: string;
  operatorPhone?: string;
  materials?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
  /** 地块边界几何，CGCS2000 GeoJSON Polygon */
  geom?: unknown;
}

// 农事任务查询参数
export interface FarmTaskQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  parcelCode?: string;
  status?: FarmTaskStatus | undefined;
  taskType?: string;
  startDate?: string;
  endDate?: string;
}

// 看板统计数据
export interface DashboardStats {
  totalPlots: number;
  totalAreaMu: number;
  onlineDeviceRate: number;
  pendingAlerts: number;
  areaTrend: { date: string; plantingArea: number }[];
  plotTypeDistribution: { type: PlotType; count: number; area: number }[];
  cropDistribution: { crop: string; count: number; area: number }[];
  latestAlerts: {
    id: string;
    level: 'HIGH' | 'MEDIUM' | 'LOW';
    type: string;
    content: string;
    parcelName?: string;
    deviceName?: string;
    occurredAt: string;
    handled: boolean;
  }[];
}

// 用户信息
export interface UserInfo {
  id: string;
  username: string;
  name: string;
  avatar?: string;
  phone?: string;
  email?: string;
  roles: string[];
  permissions: string[];
}

// 登录参数
export interface LoginParams {
  username: string;
  password: string;
  captcha?: string;
}

// 登录响应
export interface LoginResult {
  token: string;
  expiresIn: number;
  user: UserInfo;
}

/** 看板地块统计 */
export interface PlotStats {
  totalPlots: number;
  totalAreaMu: number;
  soilTypes: Array<{ name: string; areaMu: number }>;
}

/** 遥测历史读数点（时间升序） */
export interface TelemetryHistoryPoint {
  recordedAt: string
  value: number
}

/** 遥测告警（与 telemetry-service 返回一致） */
export interface TelemetryAlert {
  id: string
  deviceId: string
  plotCode: string
  level: string
  metric: string
  message: string
  createdAt: string
  handled: boolean
  handledAt?: string
}
// 视频监控
export type CameraStatus = 'ONLINE' | 'OFFLINE'

export interface Camera {
  id: string
  name: string
  plotCode?: string
  status: CameraStatus
  streamUrl: string
}

export interface Recording {
  id: string
  cameraId: string
  startedAt: string
  endedAt: string
  playbackUrl: string
}
// 菜单项
export interface MenuItem {
  path: string;
  name: string;
  title: string;
  icon?: string;
  children?: MenuItem[];
  meta?: {
    title?: string;
    icon?: string;
    hidden?: boolean;
    requiresAuth?: boolean;
    roles?: string[];
  };
}

