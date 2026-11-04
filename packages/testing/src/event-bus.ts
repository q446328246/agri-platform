import { ulid } from "@agri/shared";

import type { MockClock } from "./clock.js";

/**
 * 内存事件总线。
 *
 * 结构与真实消息中间件的发布订阅契约保持一致，因此服务代码无需为测试改写；
 * 需要真实中间件的场景（如跨进程顺序保证）不在本工具覆盖范围，
 * 那类行为应放到集成测试中验证。
 */

/** 投递回执 */
export interface BusPublishReceipt {
  topic: string;
  partition: number;
  offset: string;
  eventId: string;
}

/** 事件信封（与契约包结构一致，此处放宽类型便于测试构造） */
export interface BusEvent {
  eventId: string;
  topic: string;
  version: number;
  occurredAt: string;
  producer: string;
  tenantId: string;
  traceId: string;
  payload: unknown;
}

/** 事件处理器 */
export type BusHandler = (event: BusEvent) => Promise<void> | void;

/** 内存事件总线 */
export class InMemoryEventBus {
  private readonly handlers = new Map<string, BusHandler[]>();

  private readonly history = new Map<string, BusEvent[]>();

  private partitionSeq = 0;

  private offsetSeq = 0;

  private readonly clock: MockClock | undefined;

  /** 是否模拟投递失败，失败后自动复位 */
  failNext = false;

  /** 事件发生时间来源，缺省取系统时间 */
  constructor(clock?: MockClock) {
    this.clock = clock;
  }

  /** 已发布事件，按主题保存，供断言 */
  published(topic?: string): BusEvent[] {
    if (topic === undefined) {
      return [...this.history.values()].flat();
    }
    return [...(this.history.get(topic) ?? [])];
  }

  /** 订阅某主题的事件 */
  on(topic: string, handler: BusHandler): this {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
    return this;
  }

  /** 取消某主题的全部订阅 */
  off(topic: string): void {
    this.handlers.delete(topic);
  }

  /**
   * 发布事件，自动补齐信封字段。
   * @param topic 事件主题
   * @param payload 业务载荷
   * @param options 租户与追踪信息
   */
  async publish(
    topic: string,
    payload: unknown,
    options: { tenantId?: string; traceId?: string; producer?: string } = {},
  ): Promise<BusPublishReceipt> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("模拟投递失败");
    }
    const event: BusEvent = {
      eventId: ulid(),
      topic,
      version: 1,
      occurredAt: this.clock ? this.clock.nowIso() : new Date().toISOString(),
      producer: options.producer ?? "test",
      tenantId: options.tenantId ?? "tenant-test",
      traceId: options.traceId ?? "trace-test",
      payload,
    };
    const list = this.history.get(topic) ?? [];
    list.push(event);
    this.history.set(topic, list);

    this.partitionSeq = (this.partitionSeq + 1) % 3;
    this.offsetSeq += 1;
    for (const handler of this.handlers.get(topic) ?? []) {
      await handler(event);
    }
    return { topic, partition: this.partitionSeq, offset: String(this.offsetSeq), eventId: event.eventId };
  }

  /** 批量发布 */
  async publishBatch(events: Array<{ topic: string; payload: unknown }>): Promise<void> {
    for (const event of events) {
      await this.publish(event.topic, event.payload);
    }
  }

  /**
   * 直接投递一个已构造好的事件，用于模拟重复投递。
   * @param event 事件信封
   */
  async deliver(event: BusEvent): Promise<void> {
    for (const handler of this.handlers.get(event.topic) ?? []) {
      await handler(event);
    }
  }

  /** 等待某主题出现满足条件的事件，超时抛出 */
  async waitFor(topic: string, predicate: (event: BusEvent) => boolean = () => true, timeoutMs = 1000): Promise<BusEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.published(topic).find((event) => predicate(event));
      if (hit) {
        return hit;
      }
      if (Date.now() > deadline) {
        throw new Error(`等待事件超时：${topic}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** 清空订阅与历史 */
  reset(): void {
    this.handlers.clear();
    this.history.clear();
    this.failNext = false;
  }

  async close(): Promise<void> {
    this.reset();
  }
}
