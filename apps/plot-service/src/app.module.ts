import { Module } from "@nestjs/common";
import type { DynamicModule, Provider } from "@nestjs/common";

import type { AppConfig } from "@agri/config";
import { ConfigModule } from "@agri/config";
import type { DbConfig, PrismaClientFactory } from "@agri/db";
import { PrismaModule, PrismaService, PRISMA_SERVICE } from "@agri/db";
import type { EventPublisher, EventSubscriber, OutboxStore } from "@agri/mq";
import {
  DEFAULT_RETRY_POLICY,
  EventDispatcher,
  IdempotencyGuard,
  InMemoryOutboxStore,
  MqModule,
  MQ_PUBLISHER,
  OutboxService,
} from "@agri/mq";
import type { IdempotencyStore } from "@agri/mq";
import {
  EventLoopLagCollector,
  HandleCollector,
  LoggerService,
  MetricsService,
  TraceService,
} from "@agri/observability";

import { PlotCodeService } from "./plot-code.service.js";
import { PlotEventConsumer } from "./plot.consumer.js";
import { InMemoryPlotRepository } from "./plot.repository.js";
import type { PlotRepository } from "./plot.repository.js";
import { PlotService } from "./plot.service.js";
import { createExamplePrismaFactory } from "./prisma.factory.js";

/**
 * 示例服务的模块装配。
 *
 * 装配顺序体现依赖方向：配置与数据库为基础设施，消息与可观测性为横切能力，
 * 业务服务只依赖这些能力的对外契约，不反向被它们引用。
 * 这样业务代码在测试中可以只替换仓储与发布器，无需启动真实中间件。
 */

/** 仓储注入令牌 */
export const PLOT_REPOSITORY = "PLOT_REPOSITORY";

/** 本地消息表注入令牌 */
export const OUTBOX_STORE = "OUTBOX_STORE";

/** 幂等存储注入令牌 */
export const IDEMPOTENCY_STORE = "IDEMPOTENCY_STORE";

/** 装配选项 */
export interface AppModuleOptions {
  /** 应用配置，通常来自配置包 */
  appConfig: AppConfig;
  /** 事件发布器，由服务注入具体中间件客户端 */
  publisher: EventPublisher;
  /** 事件订阅器，可选 */
  subscriber?: EventSubscriber;
  /** 地块仓储，缺省使用内存实现 */
  repository?: PlotRepository;
  /** 数据库客户端工厂，缺省使用示例工厂 */
  prismaFactory?: PrismaClientFactory;
  /** 本地消息表，缺省使用内存实现 */
  outboxStore?: OutboxStore;
  /** 幂等存储，缺省使用内存实现 */
  idempotencyStore?: IdempotencyStore;
}

/** 把应用配置转换为数据库配置 */
function toDbConfig(appConfig: AppConfig): DbConfig {
  return {
    url: appConfig.db.url,
    shardMode: appConfig.db.shardMode,
    poolSize: appConfig.db.poolSize,
    slowQueryMs: appConfig.db.slowQueryMs,
  };
}

/** 地块服务示例模块 */
@Module({})
export class AppModule {
  /** 按选项装配模块 */
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { appConfig, publisher, subscriber } = options;

    const infraProviders: Provider[] = [
      ...ConfigModule.forRoot({ load: () => appConfig }).providers ?? [],
      ...PrismaModule.forRoot(toDbConfig(appConfig), options.prismaFactory ?? createExamplePrismaFactory()).providers ?? [],
    ];

    const observabilityProviders: Provider[] = [
      {
        provide: LoggerService,
        useFactory: (): LoggerService =>
          new LoggerService({ serviceName: appConfig.serviceName, level: appConfig.logLevel }),
      },
      { provide: MetricsService, useFactory: (): MetricsService => new MetricsService() },
      { provide: TraceService, useFactory: (): TraceService => new TraceService() },
      {
        provide: EventLoopLagCollector,
        useFactory: (metrics: MetricsService, logger: LoggerService): EventLoopLagCollector =>
          new EventLoopLagCollector({ metrics, logger }),
        inject: [MetricsService, LoggerService],
      },
      {
        provide: HandleCollector,
        useFactory: (metrics: MetricsService): HandleCollector => new HandleCollector({ metrics }),
        inject: [MetricsService],
      },
    ];

    const businessProviders: Provider[] = [
      { provide: PLOT_REPOSITORY, useValue: options.repository ?? new InMemoryPlotRepository() },
      { provide: OUTBOX_STORE, useValue: options.outboxStore ?? new InMemoryOutboxStore() },
      {
        provide: IDEMPOTENCY_STORE,
        useFactory: (): IdempotencyStore => options.idempotencyStore ?? new IdempotencyGuardStore(),
      },
      {
        provide: OutboxService,
        useFactory: (store: OutboxStore, pub: EventPublisher): OutboxService =>
          new OutboxService(store, pub, {
            tenantId: "default",
            traceId: "boot",
            producer: appConfig.serviceName,
          }),
        inject: [OUTBOX_STORE, MQ_PUBLISHER],
      },
      {
        provide: EventDispatcher,
        useFactory: (store: IdempotencyStore): EventDispatcher =>
          new EventDispatcher({ idempotency: new IdempotencyGuard(store), retry: DEFAULT_RETRY_POLICY }),
        inject: [IDEMPOTENCY_STORE],
      },
      {
        provide: PlotEventConsumer,
        useFactory: (dispatcher: EventDispatcher): PlotEventConsumer => {
          const consumer = new PlotEventConsumer();
          consumer.bind(dispatcher);
          return consumer;
        },
        inject: [EventDispatcher],
      },
      { provide: PrismaService, useExisting: PRISMA_SERVICE },
      PlotCodeService,
      {
        provide: PlotService,
        useFactory: (
          repository: PlotRepository,
          outbox: OutboxService,
          codeService: PlotCodeService,
          prisma: PrismaService,
        ): PlotService => new PlotService(repository, outbox, codeService, prisma),
        inject: [PLOT_REPOSITORY, OutboxService, PlotCodeService, PrismaService],
      },
    ];

    return {
      module: AppModule,
      imports: [MqModule.forRoot({ config: toMqConfig(appConfig), publisher, ...(subscriber ? { subscriber } : {}) })],
      providers: [...infraProviders, ...observabilityProviders, ...businessProviders],
      exports: [PlotService, PlotCodeService, PlotEventConsumer, EventDispatcher, OutboxService, LoggerService, MetricsService],
    };
  }
}

/** 幂等存储的空实现占位：真实工程由缓存中间件实现 */
class IdempotencyGuardStore implements IdempotencyStore {
  private readonly keys = new Set<string>();

  async has(key: string): Promise<boolean> {
    return this.keys.has(key);
  }

  async set(key: string): Promise<void> {
    this.keys.add(key);
  }
}

/** 把应用配置转换为消息配置 */
function toMqConfig(appConfig: AppConfig): {
  brokers: string[];
  clientId: string;
  groupId: string;
  autoCommitIntervalMs: number;
  retry: typeof DEFAULT_RETRY_POLICY;
} {
  return {
    brokers: appConfig.mq.brokers,
    clientId: appConfig.mq.clientId,
    groupId: appConfig.mq.groupId,
    autoCommitIntervalMs: appConfig.mq.autoCommitIntervalMs,
    retry: DEFAULT_RETRY_POLICY,
  };
}
