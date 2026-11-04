import { envSchema } from "./env-schema.js";
import type { AppConfig, EnvRaw } from "./env-schema.js";

/**
 * 配置校验失败异常，携带问题清单。
 * 问题清单面向部署人员，直接列出缺失或非法的变量名与原因。
 */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`配置校验失败，共 ${issues.length} 项：${issues.join("；")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** 环境变量来源，默认取进程环境 */
export type EnvSource = Record<string, string | undefined>;

/**
 * 仅校验不读取，供部署前预检脚本使用。
 * @param env 环境变量来源
 * @returns 校验结果与问题清单
 */
export function validateEnv(env: EnvSource = process.env): { ok: boolean; issues: string[] } {
  const parsed = envSchema.safeParse(env);
  if (parsed.success) {
    return { ok: true, issues: [] };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

/** 把校验通过的环境变量归并为按域分组的配置结构 */
function toAppConfig(env: EnvRaw): AppConfig {
  return {
    env: env.NODE_ENV,
    serviceName: env.SERVICE_NAME,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    db: {
      url: env.DB_URL,
      shardMode: env.DB_SHARD_MODE,
      poolSize: env.DB_POOL_SIZE,
      slowQueryMs: env.DB_SLOW_QUERY_MS,
    },
    mq: {
      brokers: env.MQ_BROKERS.split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
      clientId: env.SERVICE_NAME,
      groupId: env.MQ_GROUP_ID,
      autoCommitIntervalMs: env.MQ_AUTO_COMMIT_INTERVAL_MS,
    },
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      db: env.REDIS_DB,
    },
  };
}

/**
 * 读取并校验配置，失败即抛出 ConfigError 终止启动。
 * @param env 环境变量来源
 * @returns 应用级配置
 */
export function loadConfig(env: EnvSource = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return toAppConfig(parsed.data);
}
