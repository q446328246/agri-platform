import { z } from "zod";

/**
 * 环境变量校验结构。
 *
 * 本结构是环境变量的唯一说明来源：任何新增配置项必须先在此声明，
 * 再在业务代码中读取。配置缺失或类型不符时服务拒绝启动，
 * 把「配置错误」从运行期偶发故障变为启动期的确定性失败。
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_NAME: z.string().min(1).default("unknown-service"),

  /** 服务监听端口 */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** 日志级别 */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** 主数据源连接串 */
  DB_URL: z.string().min(1),
  /** 分片模式：single 单库、shared 共享库独立模式、isolated 独立库 */
  DB_SHARD_MODE: z.enum(["single", "shared", "isolated"]).default("single"),
  /** 连接池上限，按容器副本数反推，避免总连接数超过数据库上限 */
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
  /** 慢查询阈值（毫秒） */
  DB_SLOW_QUERY_MS: z.coerce.number().int().min(1).default(500),

  /** 消息总线接入地址，逗号分隔多节点 */
  MQ_BROKERS: z.string().min(1),
  /** 消费者组；同组内消息只被一个副本消费 */
  MQ_GROUP_ID: z.string().min(1),
  /** 自动提交位点间隔（毫秒），越大吞吐越高但重复窗口越宽 */
  MQ_AUTO_COMMIT_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),

  /** 缓存主机 */
  REDIS_HOST: z.string().min(1).default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
});

/** 环境变量原始结构类型 */
export type EnvRaw = z.infer<typeof envSchema>;

/** 应用级配置结构，按域分组 */
export interface AppConfig {
  env: EnvRaw["NODE_ENV"];
  serviceName: string;
  port: number;
  logLevel: EnvRaw["LOG_LEVEL"];
  db: DbEnvConfig;
  mq: MqEnvConfig;
  redis: RedisEnvConfig;
}

/** 数据库配置结构 */
export interface DbEnvConfig {
  url: string;
  shardMode: EnvRaw["DB_SHARD_MODE"];
  poolSize: number;
  slowQueryMs: number;
}

/** 消息总线配置结构 */
export interface MqEnvConfig {
  brokers: string[];
  clientId: string;
  groupId: string;
  autoCommitIntervalMs: number;
}

/** 缓存配置结构 */
export interface RedisEnvConfig {
  host: string;
  port: number;
  db: number;
}
