import type { GeoPolygon } from "../dto/geo.dto.js";
import type { AiEventTypeValue } from "../enums/domain.enum.js";

/**
 * 八个领域事件的载荷结构。
 *
 * 载荷以地块标识为关联主键，附带发生时间与业务明细；
 * 只做追加式演进：新增字段必须可选，删除字段或修改类型属破坏性变更。
 */

/** plot.plot.created —— 新建地块完成建档 */
export interface PlotCreatedPayload {
  parcelId: string;
  parcelCode: string;
  parcelName: string;
  tenantId: string;
  farmId: string;
  /** 面积，单位：亩 */
  areaMu: number;
  /** 边界几何，采用 CGCS2000（EPSG:4490）坐标系 */
  geom: GeoPolygon;
  /** 土壤类型编码，取自数据字典 */
  soilType?: string;
}

/** iot.device.offline —— 设备离线 */
export interface DeviceOfflinePayload {
  deviceId: string;
  deviceCode: string;
  /** 最近一次通信时间，ISO 8601 UTC */
  lastSeenAt: string;
  /** 离线原因：timeout 心跳超时、unbind 主动解绑、fault 设备故障 */
  reason: "timeout" | "unbind" | "fault";
}

/** telemetry.threshold.breached —— 遥测指标越过阈值 */
export interface ThresholdBreachedPayload {
  parcelId: string;
  /** 越限指标，取值来自 TelemetryMetric */
  metric: string;
  value: number;
  threshold: number;
  /** 方向：above 高于上限、below 低于下限 */
  direction: "above" | "below";
  /** 网格编码，空表示尚未细分到网格 */
  gridCode?: string;
  /**
   * 地块台账面积（亩），发布越限事件时由遥测侧从地块台账带出；
   * 控制侧据此现算越限补灌的执行包络，取不到则补灌仍需人工确认作业量。
   */
  areaMu?: number;
  occurredAt: string;
}

/** telemetry.pest.detected —— 虫情识别确认达到防治指标 */
export interface PestDetectedPayload {
  parcelId: string;
  /** 发生位置定位到网格；空表示尚未细分到网格 */
  gridCode?: string;
  /** 虫害类型编码，取自虫情字典 */
  pestType: string;
  /** 发生等级：1 轻微、2 中等、3 严重 */
  level: 1 | 2 | 3;
  /** 识别置信度，取值 0 到 1 */
  confidence: number;
  /** 现场影像文件标识，访问地址由文件服务解析 */
  imageFileId?: string;
  /** 识别时间，ISO 8601 UTC */
  detectedAt: string;
}

/** telemetry.ai.detected —— 非虫情类视频 AI 识别确认（人员闯入/农机状态/涝情/倒伏/火情/烟雾） */
export interface AiDetectedPayload {
  parcelId: string;
  /** 识别摄像头标识，去重与现场定位用 */
  cameraId: string;
  /** 事件类型，取值来自 AiEventType；PEST 不走本载荷，沿用 PestDetectedPayload */
  eventType: AiEventTypeValue;
  /** 发生等级：1 轻微、2 中等、3 严重 */
  level: 1 | 2 | 3;
  /** 识别置信度，取值 0 到 1 */
  confidence: number;
  /** 现场影像文件标识，访问地址由文件服务解析 */
  imageFileId?: string;
  /** 识别时间，ISO 8601 UTC */
  detectedAt: string;
}

/** 处方明细项 */
export interface PrescriptionItem {
  gridCode?: string;
  /**
   * 分区台账面积，单位：亩。按「明细 gridCode → 网格台账面积」口径，
   * 每条明细自带其网格的台账面积；缺省时控制侧在 gridCode 即地块时回落用事件带出的地块台账面积，
   * 两者都没有就不执行——不猜面积。
   */
  areaMu?: number;
  /**
   * 水肥一体时的灌水定额，单位：毫米（D1 口径：水肥一体随水施肥，灌水定额与灌溉处方同源）。
   * 施肥处方带出该值时控制侧可按灌溉口径现算阀门开启时长；缺省则施肥处方仍需人工确认作业量。
   */
  targetMm?: number;
  /** 投入品编码，关联农资字典 */
  materialCode: string;
  /** 用量，单位随 materialCode 对应的计量单位 */
  dosage: number;
  /** 建议作业时间窗起点，ISO 8601 UTC */
  windowStart: string;
  /** 建议作业时间窗终点，ISO 8601 UTC */
  windowEnd: string;
}

/** decision.prescription.issued —— 地块级处方生成完成 */
export interface PrescriptionIssuedPayload {
  /** 处方留痕标识；同一处方按动作类型分组发布时共用，兼容旧事件 */
  prescriptionId?: string;
  parcelId: string;
  seasonId: string;
  /** 处方类型：irrigation 灌溉、fertilization 施肥、pesticide 植保 */
  planType: "irrigation" | "fertilization" | "pesticide";
  /**
   * 地块台账面积（亩），生成处方时从地块服务取到的权威值。
   * 控制侧据此把单条灌溉明细翻译成执行分区，现算阀门该开多久；
   * 取不到就不带这个字段，下游宁可不执行也不猜面积。
   */
  areaMu?: number;
  /** 处方明细，按网格或按地块整体给出 */
  items: PrescriptionItem[];
}

/** 预测指标：墒情趋势、虫害风险、产量估算 */
export type PredictionMetric = "SOIL_MOISTURE" | "PEST_RISK" | "YIELD";

/** 预测等级：正常、预警、严重、数据不足（无依据时不编预测值） */
export type PredictionLevel = "NORMAL" | "WARNING" | "CRITICAL" | "INSUFFICIENT_DATA";

/** decision.prediction.alert —— 预测结果达到预警/严重级别，提示提前处置 */
export interface PredictionAlertPayload {
  parcelId: string;
  seasonId: string;
  metric: PredictionMetric;
  /** 只发布预警与严重级，正常与数据不足不扰人 */
  level: "WARNING" | "CRITICAL";
  /** 预测值：墒情为百分数、虫害风险为分值、产量为千克/亩 */
  predictedValue: number;
  unit: string;
  /** 判定所用阈值，无阈值指标（如产量）缺省 */
  threshold?: number;
  /** 方向：below 低于下限、above 高于上限 */
  direction?: "above" | "below";
  /** 预测时点，ISO 8601 UTC */
  predictedAt: string;
  /** 预测时距预测起点的小时数 */
  horizonHours: number;
  /** 推算依据说明，保证可追溯、不编数 */
  basis: string;
}

/** tractor.safety.event —— 拖拉机作业安全验证事件（围栏越界/RTK 质量/失联/急停/轨迹偏离等） */
export interface TractorSafetyEventPayload {
  parcelId: string;
  deviceId: string;
  /** 安全事件类型：作业前预检失败、作业中围栏越界、RTK 质量劣化、通信失联、急停、轨迹跟随偏离 */
  kind: "PRECHECK_FAIL" | "GEOFENCE_BREACH" | "RTK_QUALITY" | "COMM_LOSS" | "ESTOP" | "TRAJECTORY_DEVIATION";
  /** 事件级别：CRITICAL 需立即处置，WARNING 需关注 */
  level: "WARNING" | "CRITICAL";
  message: string;
  /** 触发位置（发生越界/急停时），缺省无定位 */
  lng?: number;
  lat?: number;
  occurredAt: string;
}

/** operation.task.completed —— 作业任务完成 */
export interface TaskCompletedPayload {
  taskId: string;
  parcelId: string;
  /** 作业类型：tillage 整地、sowing 播种、spraying 植保、weeding 除草 */
  taskType: "tillage" | "sowing" | "spraying" | "weeding" | "irrigation" | "fertilization";
  /** 执行结果：success 成功、partial 部分完成、failed 失败 */
  result: "success" | "partial" | "failed";
  /** 实际作业面积，单位：亩 */
  finishedAreaMu: number;
  finishedAt: string;
}

/** control.irrigation.finished —— 灌溉执行完成（DONE 回执回流） */
export interface IrrigationFinishedPayload {
  /** 结单的指令标识，重复投递按它去重 */
  commandId: string;
  /** 指令归属地块，未绑定地块的指令为空串 */
  parcelId: string;
  deviceId: string;
  /**
   * 用水量，单位：立方米。来源见 waterVolumeSource；
   * 设备没报、指令参数又推不出方案总量时缺省，不编一个数。
   */
  waterVolume?: number;
  /** 用水量来源：DEVICE 为设备回执实测，PLAN 为按分区参数现算的方案总量 */
  waterVolumeSource?: "DEVICE" | "PLAN";
  /** 作业持续时长，单位：分钟。来源见 durationSource */
  durationMin: number;
  /** 时长来源：DEVICE 为设备回执实测，RUNTIME 为「设备接收/下发 → 结单」现算 */
  durationSource: "DEVICE" | "RUNTIME";
  finishedAt: string;
  /** 来源处方标识；人工下发的指令没有处方，缺省即不参与处方效果回流 */
  prescriptionId?: string;
}

/** control.fertilization.finished —— 施肥执行完成（DONE 回执回流） */
export interface FertilizationFinishedPayload {
  /** 结单的指令标识，重复投递按它去重 */
  commandId: string;
  /** 指令归属地块，未绑定地块的指令为空串 */
  parcelId: string;
  deviceId: string;
  /**
   * 实际施肥量，单位：千克（氮磷钾合计）。来源见 fertilizerSource；
   * 设备没报、指令参数又推不出配方总量时缺省，不编一个数。
   */
  fertilizerKg?: number;
  /** 施肥量来源：DEVICE 为设备回执实测，PLAN 为按分区面积与配比现算的方案总量 */
  fertilizerSource?: "DEVICE" | "PLAN";
  /** 作业持续时长，单位：分钟。来源见 durationSource */
  durationMin: number;
  /** 时长来源：DEVICE 为设备回执实测，RUNTIME 为「设备接收/下发 → 结单」现算 */
  durationSource: "DEVICE" | "RUNTIME";
  finishedAt: string;
  /** 来源处方标识；人工下发的指令没有处方，缺省即不参与处方效果回流 */
  prescriptionId?: string;
}

/** control.command.timeout —— 指令超时未回执，系统自动收口为失败 */
export interface CommandTimeoutPayload {
  commandId: string;
  /** 指令归属地块，未绑定地块的指令为空串 */
  parcelId: string;
  deviceId: string;
  /** 指令类型，与下发时的 ControlCommandType 同一口径（迁移 050 扩到十一码） */
  commandType:
    | "SEEDING" | "IRRIGATION" | "WEEDING" | "FERTILIZATION" | "ESTOP"
    | "PAUSE" | "RESUME" | "RETURN_HOME" | "POWER_OFF" | "TOOL_SWITCH" | "TILLAGE";
  /** 从最后一次状态推进到收口的等待时长，单位：分钟（现算，不写死） */
  pendingMin: number;
  /** 判定超时所用的阈值，单位：分钟 */
  timeoutMin: number;
  /** 收口时间 */
  failedAt: string;
}

/** finance.cost.accrued —— 成本归集 */
export interface CostAccruedPayload {
  parcelId: string;
  seasonId: string;
  /** 成本类型：material 农资、machine 农机、labor 人工 */
  costType: "material" | "machine" | "labor";
  /** 金额，单位：元 */
  amount: number;
  accruedAt: string;
}

/** 运维告警类型：服务不可用 / 服务响应过慢 / 基础设施不可用 */
export type MonitorAlertKind = "SERVICE_DOWN" | "SERVICE_SLOW" | "INFRA_DOWN";

/** platform.service.down —— 巡检发现服务或基础设施异常，达到告警规则阈值 */
export interface ServiceDownPayload {
  /** 监控目标标识：服务名（如 telemetry）或基础设施名（postgres / minio） */
  target: string;
  targetKind: "SERVICE" | "INFRA";
  /** 目标展示名 */
  label: string;
  alertKind: MonitorAlertKind;
  /** 异常原因：不可用为最近一次探测错误，过慢为响应时长超阈值说明 */
  reason: string;
  /** 最近一次探测耗时，单位：毫秒；不可用时缺省 */
  latencyMs?: number;
  /** 连续失败次数（过慢告警为连续过慢轮次） */
  consecutiveFailures: number;
  occurredAt: string;
}

/** platform.service.recovered —— 异常目标恢复，撤销对应告警 */
export interface ServiceRecoveredPayload {
  target: string;
  targetKind: "SERVICE" | "INFRA";
  label: string;
  /** 从首次判定 DOWN 到恢复的时长，单位：毫秒；无法推算时缺省 */
  downtimeMs?: number;
  occurredAt: string;
}
