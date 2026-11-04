import type { DbConfig, ShardMode } from "./config.js";

/**
 * 按租户解析数据源。
 *
 * 三种分片模式共用同一套代码，差异只体现在数据源解析结果上：
 * 单库模式全部租户共用一个库；共享库独立模式共库但按租户隔离表空间或模式；
 * 独立库模式每个租户一个连接串。这样规模变化不需要改动业务代码。
 */
export class ShardRouter {
  private readonly mode: ShardMode;

  private readonly defaultUrl: string;

  private readonly resolveTenantUrl: ((tenantId: string) => string | undefined) | undefined;

  constructor(config: DbConfig) {
    this.mode = config.shardMode;
    this.defaultUrl = config.url;
    this.resolveTenantUrl = config.resolveTenantUrl;
  }

  /** 当前分片模式 */
  get shardMode(): ShardMode {
    return this.mode;
  }

  /**
   * 解析租户对应的数据源连接串。
   * @param tenantId 租户标识
   * @returns 连接串；单库模式下恒为主数据源
   */
  resolve(tenantId: string): string {
    if (this.mode === "single") {
      return this.defaultUrl;
    }
    const resolved = this.resolveTenantUrl?.(tenantId);
    return resolved ?? this.defaultUrl;
  }

  /**
   * 数据源标识，用于连接池复用与观测打点。
   * 单库模式固定返回 primary，避免上游把租户标识误当作连接池分片键。
   * @param tenantId 租户标识
   */
  shardKey(tenantId: string): string {
    if (this.mode === "single") {
      return "primary";
    }
    return `${this.mode}:${tenantId}`;
  }
}
