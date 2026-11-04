import type { DomainEvent, EventTopicValue } from "@agri/contracts";
import { sleep } from "@agri/shared";

import { backoffDelay, DEFAULT_RETRY_POLICY } from "./config.js";
import type { DeadLetterHandler, RetryPolicy } from "./config.js";
import type { IdempotencyGuard } from "./idempotency.js";
import type { EventHandler, EventSubscriber } from "./types.js";

/**
 * 消费者编排。
 *
 * 业务侧只看到「处理一个事件」这一个动作，反序列化、幂等、重试与死信
 * 全部在本层完成，因此消费者代码里不应再出现任何重复判断。
 */

/** 编排依赖 */
export interface EventDispatcherOptions {
  idempotency: IdempotencyGuard;
  retry?: RetryPolicy;
  deadLetter?: DeadLetterHandler;
  /** 日志输出，缺省不输出 */
  onError?: (topic: string, eventId: string, error: Error, attempt: number) => void;
}

/** 事件分发器 */
export class EventDispatcher implements EventSubscriber {
  private readonly handlers = new Map<string, EventHandler<unknown>[]>();

  private readonly idempotency: IdempotencyGuard;

  private readonly retry: RetryPolicy;

  private readonly deadLetter: DeadLetterHandler | undefined;

  private readonly onError: ((topic: string, eventId: string, error: Error, attempt: number) => void) | undefined;

  private running = false;

  constructor(options: EventDispatcherOptions) {
    this.idempotency = options.idempotency;
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.deadLetter = options.deadLetter;
    this.onError = options.onError;
  }

  /** 是否处于消费中 */
  get isRunning(): boolean {
    return this.running;
  }

  subscribe<T>(topic: EventTopicValue, handler: EventHandler<T>): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler as EventHandler<unknown>);
    this.handlers.set(topic, list);
  }

  /** 读取某主题已注册的处理器，供启动自检 */
  handlerCount(topic: EventTopicValue): number {
    return this.handlers.get(topic)?.length ?? 0;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /**
   * 处理单个事件：先幂等判断，再按顺序执行处理器，失败按策略重试，超限转死信。
   * @param event 领域事件
   */
  async dispatch<T>(event: DomainEvent<T>): Promise<void> {
    if (await this.idempotency.isDuplicate(event.eventId)) {
      return;
    }

    const list = this.handlers.get(event.topic) ?? [];
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        for (const handler of list) {
          await handler(event as DomainEvent<unknown>);
        }
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.onError?.(event.topic, event.eventId, err, attempt);
        if (attempt >= this.retry.maxAttempts) {
          if (this.retry.deadLetterAfterMaxAttempts && this.deadLetter) {
            await this.deadLetter(event, err);
          }
          // 转入死信后不再抛出，避免阻塞后续事件
          return;
        }
        await sleep(backoffDelay(attempt, this.retry));
      }
    }
  }
}
