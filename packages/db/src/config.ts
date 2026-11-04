/**
 * 数据库连接与分片配置。
 *
 * 本包只面向关系型数据库：只管怎么连、怎么事务、怎么分片，
 * 不含任何业务表模型；表模型由各服务自己的模式定义文件声明。
 * 时序数据不经本包，由物联感知服务直接对接时序数据库。
 */

/** 分片模式 */
export type ShardMode = "single" | "shared" | "isolated";

/** 数据库连接与分片配置 */
export interface DbConfig {
  /** 主数据源连接串，多租户共享库模式下的默认库 */
  url: string;
  /** 分片模式：single 单库、shared 共享库独立模式、isolated 独立库 */
  shardMode: ShardMode;
  /** 连接池上限，按容器副本数反推，避免总连接数超过数据库上限 */
  poolSize: number;
  /** 慢查询阈值（毫秒），超过时输出告警日志 */
  slowQueryMs: number;
  /** 租户到连接串的解析函数，shared 与 isolated 模式下使用 */
  resolveTenantUrl?: (tenantId: string) => string | undefined;
}

/** 默认连接池上限 */
export const DEFAULT_POOL_SIZE = 10;

/** 默认慢查询阈值（毫秒） */
export const DEFAULT_SLOW_QUERY_MS = 500;
