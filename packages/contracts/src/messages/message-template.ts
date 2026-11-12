import type {
  CommandTimeoutPayload,
  IrrigationFinishedPayload,
  PestDetectedPayload,
  PlotCreatedPayload,
  PrescriptionIssuedPayload,
  ThresholdBreachedPayload,
} from "../events/payload.js";
import { EventTopic } from "../events/topic.js";

/**
 * 消息模板与去重键。
 *
 * 事件消费生成的消息，文案与去重规则属于平台级契约而不是某个服务的实现细节：
 * 前端展示、运维告警、测试断言都依赖同一套标题与级别。因此模板放在契约包里，
 * 只做纯函数渲染，不依赖任何能力包，也不负责落库。
 *
 * 去重键分三类：
 * - 越限告警按「地块 + 指标 + 方向 + 小时」聚合，抑制同一场灾害的一小时内刷屏；
 * - 处方通知按来源事件唯一，每份处方都要分别通知；
 * - 指令相关消息（超时收口、灌溉完成）按指令唯一——事件重放或中继重试会换 eventId，
 *   但同一条指令只该提醒一次。
 */

/** 消息类型：ALERT 告警待处置，NOTICE 通知仅提醒 */
export type MessageType = "ALERT" | "NOTICE";

/** 消息级别 */
export type MessageLevel = "INFO" | "WARNING" | "CRITICAL";

/** 级别权重，用于订阅偏好的最低级别过滤 */
export const MESSAGE_LEVEL_RANK: Record<MessageLevel, number> = {
  INFO: 1,
  WARNING: 2,
  CRITICAL: 3,
};

/** 指标中文名，缺省回落到指标编码 */
const METRIC_LABELS: Record<string, string> = {
  soilMoisture: "土壤含水率",
  airTemperature: "空气温度",
  airHumidity: "空气湿度",
  windSpeed: "风速",
  rainfall: "降雨量",
  canopyCoverage: "苗情覆盖度",
  pestCount: "虫口密度",
  diseaseIndex: "病情指数",
};

/** 虫情等级中文名 */
const PEST_LEVEL_LABELS: Record<PestDetectedPayload["level"], string> = {
  1: "轻微",
  2: "中等",
  3: "严重",
};

/** 处方类型中文名 */
const PLAN_LABELS: Record<PrescriptionIssuedPayload["planType"], string> = {
  irrigation: "灌溉",
  fertilization: "施肥",
  pesticide: "植保",
};

/** 渲染上下文：事件信封中与消息相关的字段 */
export interface MessageTemplateContext {
  eventId: string;
  /** 事件发生时间，缺省用载荷内时间 */
  occurredAt: string;
}

/** 渲染结果，消费侧直接落库 */
export interface MessageDraft {
  type: MessageType;
  level: MessageLevel;
  title: string;
  content: string;
  plotCode: string;
  occurredAt: string;
  /** 去重键，同租户内唯一 */
  dedupeKey: string;
}

/** 单条消息模板 */
export interface MessageTemplate<T> {
  topic: string;
  /** 订阅偏好里的展示名 */
  label: string;
  type: MessageType;
  render(payload: T, context: MessageTemplateContext): MessageDraft;
}

/** 取 ISO 时间的小时前缀，用于告警聚合；不可解析时退回原值 */
function hourOf(value: string): string {
  return value.length >= 13 ? value.slice(0, 13) : value;
}

/** 越限事件：告警消息，涉及作业安全的风速按严重处理 */
const thresholdTemplate: MessageTemplate<ThresholdBreachedPayload> = {
  topic: EventTopic.TelemetryThresholdBreached,
  label: "遥测越限告警",
  type: "ALERT",
  render(payload, _context) {
    const label = METRIC_LABELS[payload.metric] ?? payload.metric;
    const direction = payload.direction === "below" ? "低于下限" : "高于上限";
    const plotCode = payload.parcelId || "未绑定地块";
    return {
      type: "ALERT",
      level: payload.metric === "windSpeed" ? "CRITICAL" : "WARNING",
      title: `${label}越限：${plotCode}`,
      content: `${label}实测 ${payload.value}，${direction}阈值 ${payload.threshold}，发生时间 ${payload.occurredAt}。请核查设备与地块处置措施。`,
      plotCode: payload.parcelId,
      occurredAt: payload.occurredAt,
      dedupeKey: `${EventTopic.TelemetryThresholdBreached}:${payload.parcelId}:${payload.metric}:${payload.direction}:${hourOf(payload.occurredAt)}`,
    };
  },
};

/** 处方事件：通知消息，提示执行建议 */
const prescriptionTemplate: MessageTemplate<PrescriptionIssuedPayload> = {
  topic: EventTopic.DecisionPrescriptionIssued,
  label: "处方生成通知",
  type: "NOTICE",
  render(payload, context) {
    const plan = PLAN_LABELS[payload.planType];
    const plotCode = payload.parcelId || "未绑定地块";
    const first = payload.items[0];
    const detail = first
      ? `首项建议：${first.materialCode} 用量 ${first.dosage}，时间窗 ${first.windowStart} 至 ${first.windowEnd}。`
      : "本次评估未产生需要执行的作业建议。";
    return {
      type: "NOTICE",
      level: "INFO",
      title: `${plan}处方已生成：${plotCode}`,
      content: `共 ${payload.items.length} 项作业建议。${detail}`,
      plotCode: payload.parcelId,
      occurredAt: context.occurredAt,
      dedupeKey: `${EventTopic.DecisionPrescriptionIssued}:${context.eventId}`,
    };
  },
};

/** 虫情识别事件：严重级按告警处理，轻微级仅通知 */
const pestDetectedTemplate: MessageTemplate<PestDetectedPayload> = {
  topic: EventTopic.TelemetryPestDetected,
  label: "虫情识别告警",
  type: "ALERT",
  render(payload, context) {
    const plotCode = payload.parcelId || "未绑定地块";
    const levelLabel = PEST_LEVEL_LABELS[payload.level] ?? `${payload.level} 级`;
    const occurredAt = payload.detectedAt || context.occurredAt;
    const image = payload.imageFileId ? `，现场影像 ${payload.imageFileId}` : "";
    return {
      type: payload.level >= 2 ? "ALERT" : "NOTICE",
      level: payload.level >= 3 ? "CRITICAL" : payload.level === 2 ? "WARNING" : "INFO",
      title: `虫情识别：${plotCode} ${levelLabel}`,
      content: `识别到 ${payload.pestType}，发生等级 ${levelLabel}，置信度 ${(payload.confidence * 100).toFixed(1)}%，识别时间 ${occurredAt}${image}。请安排田间核查与防治。`,
      plotCode: payload.parcelId,
      occurredAt,
      dedupeKey: `${EventTopic.TelemetryPestDetected}:${payload.parcelId}:${payload.pestType}:${payload.level}:${hourOf(occurredAt)}`,
    };
  },
};

/** 土壤类型编码中文名，未登记的回落到原编码 */
const SOIL_LABELS: Record<string, string> = {
  PADDY_SOIL: "水稻土",
  FLUVO_AQUIC_SOIL: "潮土",
  RED_SOIL: "红壤",
  YELLOW_SOIL: "黄壤",
  PURPLE_SOIL: "紫色土",
};

/** 地块建档事件：通知消息，提示新地块已进入平台 */
const plotCreatedTemplate: MessageTemplate<PlotCreatedPayload> = {
  topic: EventTopic.PlotCreated,
  label: "地块建档通知",
  type: "NOTICE",
  render(payload, context) {
    const soil = payload.soilType ? (SOIL_LABELS[payload.soilType] ?? payload.soilType) : "未登记";
    return {
      type: "NOTICE",
      level: "INFO",
      title: `新地块已建档：${payload.parcelCode}`,
      content: `${payload.parcelName}（${payload.parcelCode}）已完成建档，面积 ${payload.areaMu} 亩，土壤类型 ${soil}，归属农场 ${payload.farmId}。可前往地块详情完善边界与档案。`,
      plotCode: payload.parcelCode,
      occurredAt: context.occurredAt,
      dedupeKey: `${EventTopic.PlotCreated}:${context.eventId}`,
    };
  },
};

/** 指令类型中文名，缺省回落到类型编码 */
const COMMAND_TYPE_LABELS: Record<CommandTimeoutPayload["commandType"], string> = {
  SEEDING: "播种",
  IRRIGATION: "灌溉",
  WEEDING: "除草",
  FERTILIZATION: "施肥",
  ESTOP: "急停",
};

/**
 * 指令超时未回执：系统将指令收口为失败，提示人工核查。
 * 去重按指令唯一——FAILED 是终态，同一指令不会被收口两次。
 */
const commandTimeoutTemplate: MessageTemplate<CommandTimeoutPayload> = {
  topic: EventTopic.ControlCommandTimeout,
  label: "指令超时未回执",
  type: "ALERT",
  render(payload, context) {
    const plotCode = payload.parcelId || "未绑定地块";
    const type = COMMAND_TYPE_LABELS[payload.commandType] ?? payload.commandType;
    return {
      type: "ALERT",
      // 急停收口意味着「没人确认设备停下来」，级别高于普通作业指令
      level: payload.commandType === "ESTOP" ? "CRITICAL" : "WARNING",
      title: `指令超时未回执：${plotCode} ${type}`,
      content:
        `设备 ${payload.deviceId} 的${type}指令已等待 ${payload.pendingMin} 分钟，超过 ${payload.timeoutMin} 分钟未收到回执，系统已收口为失败。` +
        `请现场确认设备是否实际执行，必要时人工重新下发。`,
      plotCode: payload.parcelId,
      occurredAt: payload.failedAt || context.occurredAt,
      dedupeKey: `${EventTopic.ControlCommandTimeout}:${payload.commandId}`,
    };
  },
};

/**
 * 灌溉执行完成：DONE 回执回流的通知消息。
 * 用水量与时长都标注来源——设备实测与方案推算的置信度不同，混在一起会把估算当成计量。
 */
const irrigationFinishedTemplate: MessageTemplate<IrrigationFinishedPayload> = {
  topic: EventTopic.ControlIrrigationFinished,
  label: "灌溉执行完成",
  type: "NOTICE",
  render(payload, context) {
    const plotCode = payload.parcelId || "未绑定地块";
    const water =
      payload.waterVolume === undefined
        ? "用水量未上报"
        : `用水 ${payload.waterVolume} 立方米${payload.waterVolumeSource === "DEVICE" ? "（设备实测）" : "（按分区方案推算）"}`;
    const duration = `历时 ${payload.durationMin} 分钟${payload.durationSource === "DEVICE" ? "（设备实测）" : "（按回执时间推算）"}`;
    return {
      type: "NOTICE",
      level: "INFO",
      title: `灌溉执行完成：${plotCode}`,
      content: `设备 ${payload.deviceId} 已完成 ${plotCode} 的灌溉指令，${water}，${duration}。可在生产档案与指令台账中核对。`,
      plotCode: payload.parcelId,
      occurredAt: payload.finishedAt || context.occurredAt,
      dedupeKey: `${EventTopic.ControlIrrigationFinished}:${payload.commandId}`,
    };
  },
};

/** 主题到模板的映射，新增消费主题时在这里登记 */
export const MESSAGE_TEMPLATES = {
  [EventTopic.TelemetryThresholdBreached]: thresholdTemplate,
  [EventTopic.TelemetryPestDetected]: pestDetectedTemplate,
  [EventTopic.DecisionPrescriptionIssued]: prescriptionTemplate,
  [EventTopic.PlotCreated]: plotCreatedTemplate,
  [EventTopic.ControlCommandTimeout]: commandTimeoutTemplate,
  [EventTopic.ControlIrrigationFinished]: irrigationFinishedTemplate,
} as const;

/** 已登记模板的主题 */
export type MessageTemplateTopic = keyof typeof MESSAGE_TEMPLATES;

/** 已登记模板的主题列表，供偏好设置遍历 */
export const MESSAGE_TEMPLATE_TOPICS = Object.keys(MESSAGE_TEMPLATES) as MessageTemplateTopic[];

/** 判断主题是否有模板 */
export function isMessageTemplateTopic(topic: string): topic is MessageTemplateTopic {
  return Object.prototype.hasOwnProperty.call(MESSAGE_TEMPLATES, topic);
}

/**
 * 渲染某主题的消息草稿。
 * @param topic 事件主题
 * @param payload 事件载荷
 * @param context 事件标识与发生时间
 * @returns 未登记模板的主题返回 null，消费侧应跳过
 */
export function buildMessageDraft(
  topic: string,
  payload: unknown,
  context: MessageTemplateContext,
): MessageDraft | null {
  // 直接按主题从模板目录取渲染函数：漏登记只会是「模板没写」，不会出现
  // 模板已注册、渲染分支却忘了加主题，消息静默丢失的情况。
  if (!isMessageTemplateTopic(topic)) return null;
  const render = MESSAGE_TEMPLATES[topic].render as (payload: unknown, context: MessageTemplateContext) => MessageDraft;
  return render(payload, context);
}
