import type { DomainEvent, EventTopicValue } from "@agri/contracts";
import { ulid } from "@agri/shared";

import type { EventDispatcher } from "./subscriber.js";
import type { EventHandler, EventPublisher, EventSubscriber, PublishResult } from "./types.js";

/**
 * 事件日志传输层。
 *
 * 本地消息表只保证「事件写进了本服务的表」，跨进程送达还需要一层传输。
 * 这里用一张共享事件日志表承担主题日志的角色：生产侧中继按主题追加写入，
 * 消费侧按「消费者组 + 主题」游标顺序读取，位点提交后不再重复拉取；
 * 读取与提交之间仍可能出现重复（进程崩溃、位点未提交），因此消费侧继续
 * 由 EventDispatcher 承担幂等、重试与死信处理。
 */

/** 事件日志中的一条记录 */
export interface EventLogEntry {
  /** 全局递增位点，跨主题唯一 */
  seq: number;
  event: DomainEvent;
}

/** 事件日志存储契约，由具体中间件或数据库实现 */
export interface EventLogStore {
  /** 追加事件并返回位点；同一 eventId 重复写入返回原位置 */
  append(event: DomainEvent): Promise<number>;
  /** 读取某主题在位点之后的记录 */
  readAfter(topic: EventTopicValue, afterSeq: number, limit: number): Promise<EventLogEntry[]>;
  /** 读取消费者组在某主题上已提交的位点 */
  readOffset(group: string, topic: EventTopicValue): Promise<number>;
  /** 提交消费者组位点 */
  writeOffset(group: string, topic: EventTopicValue, seq: number): Promise<void>;
}

/** 事件日志使用的 SQL 执行器契约，与仓储层共用同一份客户端形态 */
export interface EventLogSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** 判断载荷是否已经是完整事件信封，已构造信封时保留其追踪字段 */
function isEnvelope(value: unknown): value is DomainEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.eventId === "string" && typeof event.topic === "string" && typeof event.tenantId === "string";
}

/** 发布器缺省信封字段，用于消费中继这类只有主题与载荷的调用 */
export interface EventLogPublisherDefaults {
  tenantId: string;
  traceId: string;
  producer: string;
}

/** 内存事件日志，用于测试与未接入数据库的本地模式 */
export class InMemoryEventLogStore implements EventLogStore {
  private seq = 0;

  private readonly entries: EventLogEntry[] = [];

  private readonly positions = new Map<string, number>();

  private readonly offsets = new Map<string, number>();

  async append(event: DomainEvent): Promise<number> {
    const existing = this.positions.get(event.eventId);
    if (existing !== undefined) return existing;
    this.seq += 1;
    this.entries.push({ seq: this.seq, event });
    this.positions.set(event.eventId, this.seq);
    return this.seq;
  }

  async readAfter(topic: EventTopicValue, afterSeq: number, limit: number): Promise<EventLogEntry[]> {
    return this.entries.filter((entry) => entry.event.topic === topic && entry.seq > afterSeq).slice(0, limit);
  }

  async readOffset(group: string, topic: EventTopicValue): Promise<number> {
    return this.offsets.get(`${group}:${topic}`) ?? 0;
  }

  async writeOffset(group: string, topic: EventTopicValue, seq: number): Promise<void> {
    this.offsets.set(`${group}:${topic}`, seq);
  }

  /** 全部记录，供测试断言 */
  all(): EventLogEntry[] {
    return [...this.entries];
  }
}

/** PostgreSQL 事件日志：多进程共享同一主题日志，表结构由迁移 003 管理 */
export class PgEventLogStore implements EventLogStore {
  constructor(private readonly client: EventLogSqlClient) {}

  async append(event: DomainEvent): Promise<number> {
    // event_id 唯一：中继重复投递时命中冲突分支，返回原位置而不新增记录
    const rows = await this.client.$queryRawUnsafe<Array<{ seq: string }>>(
      `INSERT INTO event_log (event_id, topic, version, occurred_at, producer, tenant_id, trace_id, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
       RETURNING seq`,
      event.eventId,
      event.topic,
      event.version,
      event.occurredAt,
      event.producer,
      event.tenantId,
      event.traceId,
      JSON.stringify(event.payload),
    );
    return Number(rows[0]?.seq ?? 0);
  }

  async readAfter(topic: EventTopicValue, afterSeq: number, limit: number): Promise<EventLogEntry[]> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT seq, event_id, topic, version, occurred_at, producer, tenant_id, trace_id, payload_json
       FROM event_log WHERE topic = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      topic,
      afterSeq,
      limit,
    );
    return rows.map((row) => {
      const occurredAt = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(String(row.occurred_at)).toISOString();
      return {
        seq: Number(row.seq),
        event: {
          eventId: String(row.event_id),
          topic: String(row.topic) as EventTopicValue,
          version: Number(row.version),
          occurredAt,
          producer: String(row.producer),
          tenantId: String(row.tenant_id),
          traceId: String(row.trace_id),
          payload: row.payload_json,
        },
      };
    });
  }

  async readOffset(group: string, topic: EventTopicValue): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ last_seq: string }>>(
      `SELECT last_seq FROM event_log_offsets WHERE consumer_group = $1 AND topic = $2 LIMIT 1`,
      group,
      topic,
    );
    return Number(rows[0]?.last_seq ?? 0);
  }

  async writeOffset(group: string, topic: EventTopicValue, seq: number): Promise<void> {
    await this.client.$executeRawUnsafe(
      `INSERT INTO event_log_offsets (consumer_group, topic, last_seq, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (consumer_group, topic) DO UPDATE SET last_seq = EXCLUDED.last_seq, updated_at = now()`,
      group,
      topic,
      seq,
    );
  }
}

/**
 * 事件日志发布器。
 *
 * 与 InMemoryEventPublisher 的差别是「投递到日志」而非「投递到本进程」，
 * 因此事件可被其他服务消费；信封字段保留中继写入时的租户与链路标识。
 */
export class EventLogPublisher implements EventPublisher {
  constructor(
    private readonly store: EventLogStore,
    private readonly defaults: EventLogPublisherDefaults,
  ) {}

  async publish<T>(topic: EventTopicValue, payload: T, _key?: string): Promise<PublishResult> {
    const event: DomainEvent = isEnvelope(payload)
      ? payload
      : {
          eventId: ulid(),
          topic,
          version: 1,
          occurredAt: new Date().toISOString(),
          producer: this.defaults.producer,
          tenantId: this.defaults.tenantId,
          traceId: this.defaults.traceId,
          payload,
        };
    return this.publishEnvelope(event);
  }

  async publishEnvelope(event: DomainEvent): Promise<PublishResult> {
    const seq = await this.store.append(event);
    return { topic: event.topic, partition: 0, offset: String(seq), eventId: event.eventId };
  }

  async publishBatch(events: Array<{ topic: EventTopicValue; payload: unknown }>): Promise<void> {
    for (const event of events) {
      await this.publish(event.topic, event.payload);
    }
  }

  async close(): Promise<void> {
    // 日志由数据库持有，无需释放连接；连接生命周期归调用方管理
  }
}

/** 事件日志消费者配置 */
export interface EventLogConsumerOptions {
  /** 消费者组，同组共享位点 */
  group: string;
  store: EventLogStore;
  /** 事件分发器，负责幂等、重试与死信 */
  dispatcher: EventDispatcher;
  /** 订阅的主题列表 */
  topics: EventTopicValue[];
  /** 拉取间隔，默认 1000 毫秒 */
  pollIntervalMs?: number;
  /** 单主题单轮拉取条数，默认 50 */
  batchSize?: number;
  /** 拉取异常回调，缺省静默由下一轮重试 */
  onError?: (topic: string, error: Error) => void;
}

/**
 * 事件日志消费者：按位点轮询主题并交给分发器处理。
 *
 * 位点采用「处理完成后逐条提交」而不是批量提交，牺牲部分吞吐换取
 * 崩溃时只重复处理最后一条事件，重复部分由消费侧幂等兜住。
 */
export class EventLogConsumer implements EventSubscriber {
  private readonly group: string;

  private readonly store: EventLogStore;

  private readonly dispatcher: EventDispatcher;

  private readonly topics: EventTopicValue[];

  private readonly pollIntervalMs: number;

  private readonly batchSize: number;

  private readonly onError: ((topic: string, error: Error) => void) | undefined;

  private readonly offsets = new Map<string, number>();

  private timer: NodeJS.Timeout | undefined;

  private running = false;

  private polling = false;

  constructor(options: EventLogConsumerOptions) {
    this.group = options.group;
    this.store = options.store;
    this.dispatcher = options.dispatcher;
    this.topics = [...options.topics];
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.batchSize = options.batchSize ?? 50;
    this.onError = options.onError;
  }

  /** 是否处于消费中 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 委托给分发器登记处理器，便于消费入口只依赖消费者 */
  subscribe<T>(topic: EventTopicValue, handler: EventHandler<T>): void {
    if (!this.topics.includes(topic)) {
      this.topics.push(topic);
    }
    this.dispatcher.subscribe(topic, handler);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.dispatcher.start();
    // 启动即拉一轮，缩短首次消费延迟；位点由 pollOnce 按需从存储加载
    await this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.dispatcher.stop();
  }

  /**
   * 执行一轮拉取：逐主题按位点读取并分发，每条处理成功后提交位点。
   * @returns 本轮处理的事件条数
   */
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    let handled = 0;
    try {
      for (const topic of this.topics) {
        // 首次使用某个主题时从已提交位点续读，重启后不会重复消费历史事件
        if (!this.offsets.has(topic)) {
          this.offsets.set(topic, await this.store.readOffset(this.group, topic));
        }
        for (;;) {
          const after = this.offsets.get(topic) ?? 0;
          const batch = await this.store.readAfter(topic, after, this.batchSize);
          if (batch.length === 0) break;
          for (const entry of batch) {
            await this.dispatcher.dispatch(entry.event);
            this.offsets.set(topic, entry.seq);
            await this.store.writeOffset(this.group, topic, entry.seq);
            handled += 1;
          }
          if (batch.length < this.batchSize) break;
        }
      }
    } catch (error) {
      this.onError?.("event-log", error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.polling = false;
    }
    return handled;
  }
}
