import { Global, Module } from "@nestjs/common";
import type { DynamicModule, Provider } from "@nestjs/common";

import type { AppConfig } from "./env-schema.js";
import { loadConfig } from "./loader.js";

/** 应用配置注入令牌 */
export const APP_CONFIG = "APP_CONFIG";

/** 配置模块选项 */
export interface ConfigModuleOptions {
  /** 自定义加载函数，用于测试注入固定配置 */
  load?: () => AppConfig;
  /** 环境变量来源，默认取进程环境 */
  env?: Record<string, string | undefined>;
}

/**
 * 全局配置模块。
 *
 * 服务只需在根模块导入一次，业务层即可直接注入配置，
 * 无需在每个业务模块里重复声明。
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(options: ConfigModuleOptions = {}): DynamicModule {
    const provider: Provider = {
      provide: APP_CONFIG,
      useFactory: (): AppConfig =>
        options.load ? options.load() : loadConfig(options.env ?? process.env),
    };
    return {
      module: ConfigModule,
      global: true,
      providers: [provider],
      exports: [provider],
    };
  }
}
