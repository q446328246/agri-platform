import type { DomainEvent, EventTopicValue } from "@agri/contracts";
import { ulid } from "@agri/shared";

import type { EventPublisher } from "./types.js";

/**
 * 本地消息表与最终一致。
 *
 * 事务内只写本地消息表，事务提交后由中继任务把事件投递出去，
 * 从而在不引入分布式事务的前提下保证「业务数据与事件同时成功」。
 * 代价是重复投递不可避免，因此消费侧必须做幂等。
 */

/** 本地消息表记录 */
export interface OutboxRecord {
  id: string;
  topic: EventTopicValue;
  payload: unknown;
  tenantId: string;
  traceId: string;
  producer: string;
  createdAt: string;
  /** 已投递时间，为空表示待投递 */
  publishedAt?: string;
  /** 已尝试次数 */
  retryCount: number;
  /** 最近一次失败原因 */
  lastError?: string;
}

/** 本地消息表存储契约，由各服务按自身数据表实现 */
export interface OutboxStore {
  /** 与业务数据同事务写入消息记录 */
  enqueue(tx: unknown, record: OutboxRecord): Promise<void>;
  /** 读取待投递记录 */
  listPending(limit: number): Promise<OutboxRecord[]>;
  /** 标记已投递 */
  markPublished(id: string): Promise<void>;
  /** 标记投递失败并累计次数 */
  markFailed(id: string, error: string): Promise<void>;
}

/** 入队上下文 */
export interface OutboxContext {
  tenantId: string;
  traceId: string;
  producer: string;
}

/** 本地消息表服务 */
export class OutboxService {
  private readonly store: OutboxStore;

  private readonly context: OutboxContext;

  private readonly publisherRef: EventPublisher;

  private timer: NodeJS.Timeout | undefined;

  constructor(store: OutboxStore, publisher: EventPublisher, context: OutboxContext) {
    this.store = store;
    this.publisherRef = publisher;
    this.context = context;
  }

  /**
   * 在事务中写入待投递事件。
   * @param tx 事务客户端
   * @param topic 事件主题
   * @param payload 事件载荷
   * @param context 覆盖默认上下文
   * @returns 写入的消息记录
   */
  async enqueue<T>(
    tx: unknown,
    topic: EventTopicValue,
    payload: T,
    context?: Partial<OutboxContext>,
  ): Promise<OutboxRecord> {
    const record: OutboxRecord = {
      id: ulid(),
      topic,
      payload,
      tenantId: context?.tenantId ?? this.context.tenantId,
      traceId: context?.traceId ?? this.context.traceId,
      producer: context?.producer ?? this.context.producer,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };
    await this.store.enqueue(tx, record);
    return record;
  }

  /**
   * 执行一轮中继：把待投递记录发送到消息中间件。
   * @param limit 单轮最大处理条数
   * @returns 成功投递条数
   */
  async relayOnce(limit = 100): Promise<number> {
    const pending = await this.store.listPending(limit);
    let published = 0;
    for (const record of pending) {
      try {
        // 事件日志类传输层需要完整信封，直接按记录还原，避免中继丢失追踪字段
        const event: DomainEvent = {
          eventId: record.id,
          topic: record.topic,
          version: 1,
          occurredAt: record.createdAt,
          producer: record.producer,
          tenantId: record.tenantId,
          traceId: record.traceId,
          payload: record.payload,
        };
        if (this.publisherRef.publishEnvelope) {
          await this.publisherRef.publishEnvelope(event);
        } else {
          await this.publisherRef.publish(record.topic, record.payload, record.tenantId);
        }
        await this.store.markPublished(record.id);
        published += 1;
      } catch (error) {
        await this.store.markFailed(record.id, error instanceof Error ? error.message : String(error));
      }
    }
    return published;
  }

  /** 启动周期性中继 */
  start(intervalMs = 1000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.relayOnce();
    }, intervalMs);
    this.timer.unref();
  }

  /** 消息发布器，供服务在未启用本地消息表时直接进程内发布 */
  get publisher(): EventPublisher {
    return this.publisherRef;
  }

  /** 停止中继 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** 内存消息表，用于测试与本地开发 */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, OutboxRecord>();

  async enqueue(_tx: unknown, record: OutboxRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async listPending(limit: number): Promise<OutboxRecord[]> {
    return [...this.records.values()].filter((item) => item.publishedAt === undefined).slice(0, limit);
  }

  async markPublished(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.publishedAt = new Date().toISOString();
    }
  }

  async markFailed(id: string, error: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.retryCount += 1;
      record.lastError = error;
    }
  }

  /** 全部记录，供测试断言 */
  all(): OutboxRecord[] {
    return [...this.records.values()];
  }
}
