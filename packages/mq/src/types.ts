import type { DomainEvent, EventTopicValue } from "@agri/contracts";

/** 投递回执，含分区与位点 */
export interface PublishResult {
  topic: EventTopicValue;
  /** 分区号 */
  partition: number;
  /** 位点，用于问题定位 */
  offset: string;
  /** 事件标识，与信封中的标识一致 */
  eventId: string;
}

/** 事件发布契约 */
export interface EventPublisher {
  publish<T>(topic: EventTopicValue, payload: T, key?: string): Promise<PublishResult>;
  publishBatch(events: Array<{ topic: EventTopicValue; payload: unknown }>): Promise<void>;
  close(): Promise<void>;
  /** 可选：直接投递完整信封，保留 eventId、occurredAt、producer 等追踪字段 */
  publishEnvelope?(event: DomainEvent): Promise<PublishResult>;
}

/** 事件处理器 */
export type EventHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void>;

/** 事件订阅契约 */
export interface EventSubscriber {
  /** 注册处理器；同一主题可注册多个处理器，按声明顺序串行执行 */
  subscribe<T>(topic: EventTopicValue, handler: EventHandler<T>): void;
  /** 启动消费 */
  start(): Promise<void>;
  /** 停止消费并等待在途事件处理完成 */
  stop(): Promise<void>;
}

/** 内存实现：用于测试与本地开发，无需真实中间件 */
export class InMemoryEventPublisher implements EventPublisher {
  private partitionSeq = 0;

  private offsetSeq = 0;

  /** 已发布事件，供断言投递行为 */
  readonly published: Array<{ topic: EventTopicValue; payload: unknown; key?: string }> = [];

  /** 是否模拟投递失败 */
  failNext = false;

  async publish<T>(topic: EventTopicValue, payload: T, key?: string): Promise<PublishResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("模拟投递失败");
    }
    this.published.push(key === undefined ? { topic, payload } : { topic, payload, key });
    this.partitionSeq = (this.partitionSeq + 1) % 3;
    this.offsetSeq += 1;
    return {
      topic,
      partition: this.partitionSeq,
      offset: String(this.offsetSeq),
      eventId: "",
    };
  }

  async publishBatch(events: Array<{ topic: EventTopicValue; payload: unknown }>): Promise<void> {
    for (const event of events) {
      await this.publish(event.topic, event.payload);
    }
  }

  async close(): Promise<void> {
    this.published.length = 0;
  }
}
