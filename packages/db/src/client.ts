import { Global, Module } from "@nestjs/common";
import type { DynamicModule, OnModuleDestroy, OnModuleInit, Provider } from "@nestjs/common";

import type { DbConfig } from "./config.js";
import type { PrismaClientFactory, PrismaClientLike, Tx } from "./transaction.js";
import type { TransactionOptions } from "./with-transaction.js";
import { withTransaction } from "./with-transaction.js";

/** 客户端服务注入令牌 */
export const PRISMA_SERVICE = "PRISMA_SERVICE";

/**
 * 按配置创建客户端，供脚本与测试使用。
 * 客户端工厂由各服务注入，本包不绑定具体 ORM 实现，
 * 这样更换 ORM 或升级大版本时不影响业务代码。
 * @param config 数据库连接与分片配置
 * @param factory 客户端工厂
 * @returns 客户端实例
 */
export function createPrismaClient(config: DbConfig, factory?: PrismaClientFactory): PrismaClientLike {
  if (!factory) {
    throw new Error("必须注入客户端工厂：createPrismaClient(config, factory)");
  }
  return factory({ url: config.url, poolSize: config.poolSize });
}

/**
 * 客户端实例管理与连接生命周期。
 * 连接在模块初始化时建立、在销毁时释放，避免连接泄漏。
 */
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaClientLike;

  private readonly config: DbConfig;

  constructor(config: DbConfig, factory?: PrismaClientFactory) {
    this.config = config;
    this.client = createPrismaClient(config, factory);
  }

  /** 模块初始化：建立连接 */
  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  /** 模块销毁：释放连接 */
  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** 底层客户端实例，供特殊场景直接使用 */
  get clientInstance(): PrismaClientLike {
    return this.client;
  }

  /** 当前配置 */
  get dbConfig(): DbConfig {
    return this.config;
  }

  /** 事务便捷方法，自动重试可重试错误 */
  async withTransaction<R>(handler: (tx: Tx) => Promise<R>, options?: TransactionOptions): Promise<R> {
    return withTransaction(this.client, handler, options);
  }
}

/**
 * 数据库全局模块。
 * 服务只需在根模块导入一次，业务层即可直接注入客户端服务，
 * 无需在每个业务模块里重复声明。
 */
@Global()
@Module({})
export class PrismaModule {
  static forRoot(config: DbConfig, factory?: PrismaClientFactory): DynamicModule {
    const provider: Provider = {
      provide: PRISMA_SERVICE,
      useFactory: (): PrismaService => new PrismaService(config, factory),
    };
    return {
      module: PrismaModule,
      global: true,
      providers: [provider],
      exports: [provider],
    };
  }
}
