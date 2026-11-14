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
  /** 所属片区编码（plot_zones.zone_code），未划分时为空 */
  zoneCode?: string;
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
  /** 当前作物模糊匹配 */
  currentCrop?: string;
  /** 按片区过滤 */
  zoneCode?: string;
}

// 创建/编辑地块参数
export interface PlotForm {
  name: string;
  regionCode: string;
  villageCode: string;
  type: PlotType;
  /** 地块状态，迁移 011 后可在编辑页维护 */
  status?: PlotStatus;
  areaMu: number;
  soilType?: SoilType | undefined;
  ownerName?: string;
  ownerPhone?: string;
  coordinates?: [number, number][];
  currentCrop?: string;
  remark?: string;
}

// 一张图形状编辑：管线、地块与片区都支持新建和改边界
export type MapShapeKind = 'line' | 'plot' | 'zone';
export type MapShapeMode = 'create' | 'edit';

/** 管线类型：灌水管、施肥管、电力线、机耕道、通信网线 */
export type InfraLineType = 'IRRIGATION_PIPE' | 'FERTILIZATION_PIPE' | 'ELECTRIC_LINE' | 'ROAD' | 'TELECOM';

/** 种植季状态：计划中 / 种植中 / 已采收 */
export type CropSeasonStatus = 'planned' | 'growing' | 'harvested';

/** 地块变更动作：建档 / 更新 / 删除 / 合并生成 / 拆分生成 */
export type PlotChangeAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SPLIT';

/** 地块变更历史条目（追加式留痕） */
export interface PlotChangeLog {
  id: string;
  parcelCode: string;
  action: PlotChangeAction;
  summary: string;
  actor: string;
  createdAt: string;
}

/** 种植季/茬口档案：某地块某季种了什么，用于还原轮作序列 */
export interface CropSeason {
  seasonCode: string;
  plotCode: string;
  crop: string;
  variety: string;
  seasonYear: number;
  seasonIndex: number;
  /** YYYY-MM-DD，空串表示未定 */
  plantDate: string;
  harvestDate: string;
  status: CropSeasonStatus;
  yieldKg: number | null;
  note: string;
  createdAt: string;
}

export interface MapShapeActive {
  kind: MapShapeKind;
  mode: MapShapeMode;
  /** 管线所属图层分类，用于高亮对应菜单项 */
  cat?: 'WATER' | 'ELECTRIC' | 'NET';
}

/** 进入编辑态的既有图形，points 为 [经度, 纬度] 开环 */
export interface MapShapeTarget {
  code: string;
  name: string;
  points: [number, number][];
  plotType?: PlotType | undefined;
  zoneCode?: string | null | undefined;
  color?: string | undefined;
  lineType?: InfraLineType | undefined;
  /** 管线归属地块编码（plots.parcelCode），空/缺省表示未绑定 */
  plotCode?: string | undefined;
}

export interface MapShapeSaved {
  kind: MapShapeKind;
  mode: MapShapeMode;
  code: string;
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
  /** 设备类型，与 iot-service 台账 type 字段同源（WEATHER_STATION / SOIL_SENSOR 等） */
  type?: string | undefined;
  /** 所属地块编码，精确匹配 */
  plotCode?: string | undefined;
  /** 接入协议：HTTP 为设备回调，MODBUS_TCP 由平台侧现场网关主动轮询 */
  protocol?: string | undefined;
}

/**
 * 现场接入绑定（Modbus TCP）。
 *
 * 端口、单元标识、超时都可以省略，服务端按 `DeviceFieldAccess.defaults` 补齐——
 * 前端不写这些数，才不会和网关各按一份口径连设备。
 */
export interface DeviceModbusBinding {
  host: string;
  port?: number;
  unitId?: number;
  /** 寄存器剖面 key，取值见 DeviceFieldAccess.profiles */
  profile: string;
  timeoutMs?: number;
}

/** 现场接入目录：由 iot-service 的接入绑定模块直接给出，配置弹窗按它渲染选项 */
export interface DeviceFieldAccess {
  /** requiresBinding 由服务端判定：界面按它决定显不显示地址与剖面，不在前端再认一次协议名 */
  protocols: Array<{ value: string; label: string; requiresBinding: boolean }>;
  defaultProtocol: string;
  profiles: Array<{
    key: string;
    label: string;
    /** 可配用的台账类型：只有执行类设备能被网关写线圈 */
    applicableTypes: string[];
    meter: { register: number; wordOrder: string; wordOrderLabel: string; scale: number; unit: string } | null;
  }>;
  defaults: { port: number; unitId: number; timeoutMs: number };
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
  /** 归档时刻。在册任务没有这一列，与地块/片区软删同一口径 */
  deletedAt?: string;
  /** 地块边界几何，CGCS2000 GeoJSON Polygon */
  geom?: unknown;
}

// 农事任务查询参数
export interface FarmTaskQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  parcelCode?: string | undefined;
  status?: FarmTaskStatus | undefined;
  taskType?: string | undefined;
  startDate?: string;
  endDate?: string;
  /** 归档筛选：NONE 只看在册（缺省）、ONLY 只看已归档、ALL 两者都看 */
  archived?: 'NONE' | 'ONLY' | 'ALL';
}

// 农事任务变更历史（追加式留痕）：建档、状态跃迁、归档各一行
export interface FarmTaskChangeLog {
  id: string;
  taskId: string;
  tenantId: string;
  action: 'CREATE' | 'TRANSITION' | 'ARCHIVE';
  summary: string;
  /** 操作人：网关注入的 x-user-id，系统内部触发时为 system */
  actor: string;
  traceId?: string;
  createdAt: string;
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

export type PtzAction = 'LEFT' | 'RIGHT' | 'UP' | 'DOWN' | 'ZOOM_IN' | 'ZOOM_OUT' | 'STOP'
export type PtzStatus = 'QUEUED' | 'SENT' | 'FAILED'

/** 云台指令台账：QUEUED 表示通道未接入或待下发，SENT/FAILED 为摄像机网关真实回执 */
export interface PtzCommand {
  id: string
  cameraId: string
  action: PtzAction
  speed?: number
  status: PtzStatus
  message: string
  createdAt: string
  deliveredAt?: string
}

/** 视频 AI 识别事件：转发失败保留记录，可人工重试 */
export interface VideoAiEvent {
  id: string
  cameraId: string
  plotCode: string
  pestType: string
  level: 1 | 2 | 3
  confidence: number
  imageFileId?: string
  detectedAt: string
  receivedAt: string
  forwarded: boolean
  forwardStatus: number
  forwardMessage: string
  retryCount: number
  lastError?: string
  forwardedAt?: string
}

/** 消息级别（与 @agri/contracts 一致） */
export type MessageLevel = 'INFO' | 'WARNING' | 'CRITICAL'

/** 消息订阅偏好：按来源主题控制是否接收与最低级别 */
export interface MessagePreference {
  topic: string
  label: string
  type: 'ALERT' | 'NOTICE'
  enabled: boolean
  minLevel: MessageLevel
  updatedAt: string
}
// 系统用户（auth-service 返回，不含密码）
export interface SystemUser {
  id: string
  username: string
  name: string
  phone: string
  roles: string[]
  permissions: string[]
  tenantId: string
  status: 'ACTIVE' | 'DISABLED'
  createdAt: string
  updatedAt: string
}

// 平台角色（platform-service 返回）
export interface PlatformRole {
  id: string
  name: string
  code: string
  description: string
  permissions: string[]
  status: 'ACTIVE' | 'DISABLED'
  createdAt: string
  updatedAt: string
}

// 系统备份（platform-service 备份接口，与 scripts/backup-system.mjs 的 manifest 对应）
export interface BackupPart {
  name: string
  path: string
  bytes: number
  sha256: string
  secrets?: boolean
}

export interface BackupRecord {
  id: string
  createdAt: string
  root: string
  host: string
  tag: string
  commit: string | null
  branch: string | null
  dirty: boolean | null
  codeMode: string | null
  includeSecrets: boolean
  parts: BackupPart[]
  database: { name: string; mode: string } | null
}

/** 备份/恢复脚本执行结果 */
export interface BackupRunResult {
  exitCode: number
  stdout: string
  stderr: string
  command: string
}

// 权限目录分组
export interface PermissionGroup {
  group: string
  items: Array<{ code: string; name: string }>
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

