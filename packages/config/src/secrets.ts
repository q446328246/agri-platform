import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";

import { ConfigError } from "./loader.js";

/** 密钥读取契约 */
export interface SecretsProvider {
  /** 读取密钥，不存在时返回 undefined */
  get(key: string): string | undefined;
  /** 读取密钥，不存在时抛出 ConfigError */
  require(key: string): string;
}

/** 密钥提供者注入令牌 */
export const SECRETS_PROVIDER = "SECRETS_PROVIDER";

/**
 * 从环境变量读取密钥。
 *
 * 密钥一律从环境注入或密钥服务读取，禁止在代码与镜像中留存，
 * 也禁止写入日志与事件。
 */
export class EnvSecretsProvider implements SecretsProvider {
  private readonly source: Record<string, string | undefined>;

  constructor(source: Record<string, string | undefined> = process.env) {
    this.source = source;
  }

  get(key: string): string | undefined {
    const value = this.source[key];
    return value === undefined || value.length === 0 ? undefined : value;
  }

  require(key: string): string {
    const value = this.get(key);
    if (value === undefined) {
      throw new ConfigError([`SECRET.${key}: 密钥缺失`]);
    }
    return value;
  }
}

/** 密钥提供者注册模块 */
@Module({})
export class SecretsModule {
  static register(provider?: SecretsProvider): DynamicModule {
    return {
      module: SecretsModule,
      global: true,
      providers: [
        {
          provide: SECRETS_PROVIDER,
          useFactory: (): SecretsProvider => provider ?? new EnvSecretsProvider(),
        },
      ],
      exports: [SECRETS_PROVIDER],
    };
  }
}
