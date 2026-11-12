import "reflect-metadata";

import { buildMessageDraft, EventTopic, MESSAGE_LEVEL_RANK } from "@agri/contracts";
import type { DomainEvent } from "@agri/contracts";
import {
  buildHandlers,
  EventDispatcher,
  EventLogConsumer,
  IdempotencyGuard,
  InMemoryIdempotencyStore,
  registerHandler,
} from "@agri/mq";
import type { EventLogStore } from "@agri/mq";
import { ulid } from "@agri/shared";

import type { MessageRecord, MessageRepository } from "./message.repository.js";
import { defaultPreference, InMemoryMessagePreferenceRepository } from "./preference.repository.js";
import type { MessagePreferenceRepository } from "./preference.repository.js";

/**
 * 消息中心的事件消费。
 *
 * 消费侧只做三件事：把事件交给契约包的消息模板渲染、按订阅偏好决定是否落库、
 * 写入仓储。去重与重试交给分发器，落库的唯一约束再兜一层，因此处理器本身
 * 不再判断是否处理过。
 */

/** 事件消费处理器：一个方法对应一个主题 */
export class MessageEventConsumer {
  constructor(
    private readonly messages: MessageRepository,
    private readonly preferences: MessagePreferenceRepository,
  ) {}

  /** 遥测越限：生成告警消息，提示处置 */
  @registerHandler(EventTopic.TelemetryThresholdBreached)
  async onThresholdBreached(event: DomainEvent<unknown>): Promise<void> {
    await this.deliver(event);
  }

  /** 处方生成：生成通知消息，提示执行建议 */
  @registerHandler(EventTopic.DecisionPrescriptionIssued)
  async onPrescriptionIssued(event: DomainEvent<unknown>): Promise<void> {
    await this.deliver(event);
  }

  /** 虫情识别：视频 AI 与田间上报共用，按发生等级生成告警或提醒 */
  @registerHandler(EventTopic.TelemetryPestDetected)
  async onPestDetected(event: DomainEvent<unknown>): Promise<void> {
    await this.deliver(event);
  }

  /** 地块建档：生成通知消息，提示新地块已进入平台 */
  @registerHandler(EventTopic.PlotCreated)
  async onPlotCreated(event: DomainEvent<unknown>): Promise<void> {
    await this.deliver(event);
  }

  /** 指令超时收口：生成告警消息，提示人工核查设备到底做没做 */
  @registerHandler(EventTopic.ControlCommandTimeout)
  async onCommandTimeout(event: DomainEvent<unknown>): Promise<void> {
    await this.deliver(event);
  }

  /** 灌溉执行完成：生成通知消息，把设备实测的用水量为地块结一笔账 */
  @registerHandler(EventTopic.ControlIrrigationFinished)
  async onIrrigationFinished(event: DomainEvent<unknown>): Promise<void> {
    await this.deliver(event);
  }

  /**
   * 通用投递：模板渲染 → 偏好过滤 → 落库。
   * 未登记模板的主题直接跳过，便于后续扩展主题时先加模板再加订阅。
   */
  private async deliver(event: DomainEvent<unknown>): Promise<void> {
    const draft = buildMessageDraft(event.topic, event.payload, {
      eventId: event.eventId,
      occurredAt: event.occurredAt,
    });
    if (!draft) return;

    const preference =
      (await this.preferences.find(event.tenantId, event.topic)) ?? defaultPreference(event.tenantId, event.topic);
    if (!preference.enabled) return;
    // 最低级别过滤：消息级别低于订阅门槛时不落库
    if (MESSAGE_LEVEL_RANK[draft.level] < MESSAGE_LEVEL_RANK[preference.minLevel]) return;

    const record: MessageRecord = {
      id: ulid(),
      tenantId: event.tenantId,
      type: draft.type,
      title: draft.title,
      content: draft.content,
      level: draft.level,
      read: false,
      createdAt: draft.occurredAt,
      plotCode: draft.plotCode,
      sourceEventId: event.eventId,
      dedupeKey: draft.dedupeKey,
    };
    await this.messages.create(record);
  }
}

/** 消费者装配参数 */
export interface MessageConsumerOptions {
  /** 消费者组，缺省 message-service；多副本共用一组即可共享位点 */
  group?: string;
  pollIntervalMs?: number;
  /** 订阅偏好仓储，缺省全部启用 */
  preferences?: MessagePreferenceRepository;
  /** 处理失败回调，缺省静默由下一轮重试 */
  onError?: (topic: string, eventId: string, error: Error, attempt: number) => void;
}

/**
 * 组装消息中心的消费者：登记处理器、绑定分发器、构造日志消费者。
 * @param messages 消息仓储
 * @param store 事件日志存储
 * @param options 消费者配置
 */
export function createMessageEventConsumer(
  messages: MessageRepository,
  store: EventLogStore,
  options: MessageConsumerOptions = {},
): { handler: MessageEventConsumer; dispatcher: EventDispatcher; consumer: EventLogConsumer } {
  const dispatcher = new EventDispatcher({
    idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore(), { prefix: "message-service:idem:" }),
    retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500, deadLetterAfterMaxAttempts: false },
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const handler = new MessageEventConsumer(messages, options.preferences ?? new InMemoryMessagePreferenceRepository());
  const registrations = buildHandlers(handler);
  for (const registration of registrations) {
    dispatcher.subscribe(registration.topic, registration.handler);
  }
  const consumer = new EventLogConsumer({
    group: options.group ?? "message-service",
    store,
    dispatcher,
    topics: registrations.map((registration) => registration.topic),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  return { handler, dispatcher, consumer };
}
