import { z } from "zod";

import type { EventTopicValue } from "./topic.js";

/**
 * 领域事件信封。
 *
 * 信封承载路由与追踪所需字段，业务数据统一放在载荷中，两者分离便于平台侧
 * 统一处理序列化、幂等与重试。
 */
export interface DomainEvent<T = unknown> {
  /** 事件唯一标识，ULID 生成，消费侧据此做幂等去重 */
  eventId: string;
  /** 事件主题，取值来自 EventTopic */
  topic: EventTopicValue;
  /** 事件结构版本，载荷发生不兼容变更时递增 */
  version: number;
  /** 事件发生时间，ISO 8601 UTC 格式 */
  occurredAt: string;
  /** 生产事件的业务服务名，如 plot、telemetry */
  producer: string;
  /** 所属租户，消费侧据此做数据隔离与路由 */
  tenantId: string;
  /** 链路标识，与触发本次事件的请求链路一致 */
  traceId: string;
  /** 业务载荷，结构由具体事件定义 */
  payload: T;
}

/** 事件信封校验结构 */
export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  topic: z.string().min(1),
  version: z.number().int().min(1),
  occurredAt: z.string().datetime(),
  producer: z.string().min(1),
  tenantId: z.string().min(1),
  traceId: z.string().min(1),
  payload: z.unknown(),
});
