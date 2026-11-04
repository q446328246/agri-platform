import { Injectable, Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";

import type { EventTopicValue } from "@agri/contracts";
import type { MqConfig } from "./config.js";
import { publishEvent } from "./publisher.js";
import type { PublishResult } from "./types.js";
import type { EventPublisher, EventSubscriber } from "./types.js";

/**
 * 消息模块。
 * 事件结构由契约包维护，本包依赖契约包以约束主题与载荷类型，
 * 使拼错主题名在编译期即被发现。
 */

/** 消息服务：对发布器与订阅器的统一封装 */
@Injectable()
export class MqService implements EventPublisher {
  private readonly publisher: EventPublisher;

  private readonly subscriber: EventSubscriber | undefined;

  private readonly config: MqConfig;

  constructor(config: MqConfig, publisher: EventPublisher, subscriber?: EventSubscriber) {
    this.config = config;
    this.publisher = publisher;
    this.subscriber = subscriber;
  }

  /** 当前配置，供健康检查与运维接口读取 */
  get mqConfig(): MqConfig {
    return this.config;
  }

  /** 事件订阅器，未配置时返回 undefined */
  get subscriberInstance(): EventSubscriber | undefined {
    return this.subscriber;
  }

  publish<T>(topic: EventTopicValue, payload: T, key?: string): Promise<PublishResult> {
    return this.publisher.publish(topic, payload, key);
  }

  publishBatch(events: Array<{ topic: EventTopicValue; payload: unknown }>): Promise<void> {
    return this.publisher.publishBatch(events);
  }

  close(): Promise<void> {
    return this.publisher.close();
  }

  /** 便捷发布：自动补齐信封字段 */
  publishWithEnvelope<T>(input: {
    topic: EventTopicValue;
    payload: T;
    tenantId: string;
    traceId: string;
    producer: string;
  }): Promise<PublishResult> {
    return publishEvent(input, this.publisher);
  }
}

/** 消息服务与配置的注入令牌 */
export const MQ_CONFIG = "MQ_CONFIG";

export const MQ_PUBLISHER = "MQ_PUBLISHER";

export const MQ_SUBSCRIBER = "MQ_SUBSCRIBER";

/** 消息模块装配选项 */
export interface MqModuleOptions {
  config: MqConfig;
  /** 发布器实现，由服务注入具体的中间件客户端 */
  publisher: EventPublisher;
  /** 订阅器实现，可选 */
  subscriber?: EventSubscriber;
}

/** 消息模块 */
@Module({})
export class MqModule {
  /** 提供发布器与订阅器 */
  static forRoot(options: MqModuleOptions): DynamicModule {
    return {
      module: MqModule,
      global: true,
      providers: [
        { provide: MQ_CONFIG, useValue: options.config },
        { provide: MQ_PUBLISHER, useValue: options.publisher },
        ...(options.subscriber ? [{ provide: MQ_SUBSCRIBER, useValue: options.subscriber }] : []),
        {
          provide: MqService,
          useFactory: (): MqService => new MqService(options.config, options.publisher, options.subscriber),
        },
      ],
      exports: [MQ_CONFIG, MQ_PUBLISHER, MqService],
    };
  }

  /**
   * 注册消费者。
   * 内部完成反序列化、幂等与重试编排，业务侧只看到「处理一个事件」。
   */
  static forConsumer(topics: EventTopicValue[]): DynamicModule {
    return {
      module: MqModule,
      providers: [{ provide: "MQ_CONSUMED_TOPICS", useValue: topics }],
      exports: ["MQ_CONSUMED_TOPICS"],
    };
  }
}
