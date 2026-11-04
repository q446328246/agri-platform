import type { DomainEvent } from "@agri/contracts";

/**
 * 消息总线配置。
 *
 * 配置项集中体现三类可靠性参数：连接与消费组决定消息归属，
 * 自动提交间隔决定重复窗口的宽度，重试策略决定故障时的行为。
 * 三者相互影响，因此放在同一处配置便于整体权衡。
 */

/** 重试策略配置 */
export interface RetryPolicy {
  /** 最大尝试次数，含首次 */
  maxAttempts: number;
  /** 基础退避时长（毫秒），按尝试次数指数增长 */
  baseDelayMs: number;
  /** 退避上限（毫秒） */
  maxDelayMs: number;
  /** 达到最大尝试次数后是否转入死信 */
  deadLetterAfterMaxAttempts: boolean;
}

/** 默认重试策略：五次尝试，退避从 200 毫秒增长到 30 秒 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 30000,
  deadLetterAfterMaxAttempts: true,
};

/** 死信处理契约：由消费者实现业务补偿 */
export type DeadLetterHandler = (event: DomainEvent<unknown>, error: Error) => Promise<void>;

/** 消息总线配置 */
export interface MqConfig {
  /** 接入地址，逗号分隔多节点 */
  brokers: string[];
  /** 客户端标识，建议使用服务名加副本序号 */
  clientId: string;
  /** 消费者组；同组内消息只被一个副本消费 */
  groupId: string;
  /** 自动提交位点间隔（毫秒），越大吞吐越高但重复窗口越宽 */
  autoCommitIntervalMs: number;
  /** 重试策略 */
  retry: RetryPolicy;
}

/** 按尝试次数计算下一次退避时长 */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const raw = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}
