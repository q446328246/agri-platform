import type { EventTopicValue } from "@agri/contracts";
import { ulid } from "@agri/shared";

import type { EventPublisher, PublishResult } from "./types.js";

/**
 * 便捷发布函数：自动补齐 eventId、version、occurredAt、producer、
 * tenantId、traceId 等信封字段，业务侧只需提供载荷。
 *
 * 分区键的选择影响同一业务对象的处理顺序。约定凡是与同一地块或同一设备
 * 相关的事件，一律以该对象标识作为分区键，保证同一对象的事件按发生顺序
 * 被处理；不相关的事件则以事件标识散列，避免热点分区。
 */

/** 发布入参 */
export interface PublishEventInput<T> {
  topic: EventTopicValue;
  payload: T;
  tenantId: string;
  traceId: string;
  /** 生产者服务名，缺省取 clientId 或 unknown */
  producer?: string;
  /** 分区键，约定为地块标识或设备标识 */
  key?: string;
}

let defaultPublisher: EventPublisher | undefined;

/** 注册默认发布器，供省略发布器参数的调用形式使用 */
export function setDefaultPublisher(publisher: EventPublisher): void {
  defaultPublisher = publisher;
}

/**
 * 发布单个事件，自动补齐信封字段。
 * @param input 发布入参
 * @param publisher 发布器，缺省使用已注册的默认发布器
 * @returns 投递回执
 */
export async function publishEvent<T>(input: PublishEventInput<T>, publisher?: EventPublisher): Promise<PublishResult> {
  const target = publisher ?? defaultPublisher;
  if (!target) {
    throw new Error("未提供发布器，且未注册默认发布器");
  }
  const event = {
    eventId: ulid(),
    topic: input.topic,
    version: 1,
    occurredAt: new Date().toISOString(),
    producer: input.producer ?? "unknown",
    tenantId: input.tenantId,
    traceId: input.traceId,
    payload: input.payload,
  };
  const result = await target.publish(input.topic, event, input.key);
  return { ...result, eventId: event.eventId };
}

/**
 * 批量发布：内部按分区聚合以提高吞吐。
 * @param events 事件列表
 * @param publisher 发布器
 */
export async function publishEvents(
  events: Array<{ topic: EventTopicValue; payload: unknown }>,
  publisher?: EventPublisher,
): Promise<void> {
  const target = publisher ?? defaultPublisher;
  if (!target) {
    throw new Error("未提供发布器，且未注册默认发布器");
  }
  await target.publishBatch(events);
}
