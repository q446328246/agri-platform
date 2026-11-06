import type { PestDetectedPayload, PrescriptionIssuedPayload, ThresholdBreachedPayload } from "../events/payload.js";
import { EventTopic } from "../events/topic.js";

/**
 * 消息模板与去重键。
 *
 * 事件消费生成的消息，文案与去重规则属于平台级契约而不是某个服务的实现细节：
 * 前端展示、运维告警、测试断言都依赖同一套标题与级别。因此模板放在契约包里，
 * 只做纯函数渲染，不依赖任何能力包，也不负责落库。
 *
 * 去重键分两类：
 * - 越限告警按「地块 + 指标 + 方向 + 小时」聚合，抑制同一场灾害的一小时内刷屏；
 * - 处方通知按来源事件唯一，每份处方都要分别通知。
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

/** 主题到模板的映射，新增消费主题时在这里登记 */
export const MESSAGE_TEMPLATES = {
  [EventTopic.TelemetryThresholdBreached]: thresholdTemplate,
  [EventTopic.TelemetryPestDetected]: pestDetectedTemplate,
  [EventTopic.DecisionPrescriptionIssued]: prescriptionTemplate,
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
  switch (topic) {
    case EventTopic.TelemetryThresholdBreached:
      return thresholdTemplate.render(payload as ThresholdBreachedPayload, context);
    case EventTopic.TelemetryPestDetected:
      return pestDetectedTemplate.render(payload as PestDetectedPayload, context);
    case EventTopic.DecisionPrescriptionIssued:
      return prescriptionTemplate.render(payload as PrescriptionIssuedPayload, context);
    default:
      return null;
  }
}
