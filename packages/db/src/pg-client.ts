import pg from "pg";

import type { PrismaClientLike, Tx } from "./transaction.js";

/**
 * pg 原生客户端适配器。
 *
 * 部分服务不引入 ORM，直接用 pg 原生驱动访问 PostgreSQL（例如空间运算下沉到
 * PostGIS、时序读数批量写入）。本适配器把 pg 客户端包装成平台统一的
 * PrismaClientLike 契约，让仓储层与事务工具复用同一套调用方式。
 *
 * 参数占位符约定：本平台 SQL 统一使用 $1、$2 … 形式，与 pg 原生语法一致，
 * 因此这里原样透传参数，不做占位符改写。
 */

/** 把应用层参数转成 pg 能接受的驱动参数：大整数转字符串，日期转 ISO 字符串 */
function toDriverValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

export interface PgClientOptions {
  /** PostgreSQL 连接串，例如 postgresql://user:pass@127.0.0.1:5432/db */
  url: string;
  /** 连接池最大连接数，默认 5；pg.Client 为单连接，这里保留字段以对齐配置面 */
  poolSize?: number;
}

/** 从连接串创建 pg 原生客户端（不自动连接） */
export function createPgClient(options: PgClientOptions): pg.Client {
  return new pg.Client({ connectionString: options.url });
}

export class PgClientAdapter implements PrismaClientLike {
  private readonly client: pg.Client;

  /** ORM 风格的模型访问在本示例不使用，显式标注为未知以对齐契约索引签名 */
  [key: string]: unknown;

  constructor(client: pg.Client) {
    this.client = client;
  }

  static fromUrl(url: string): PgClientAdapter {
    return new PgClientAdapter(createPgClient({ url }));
  }

  /** 暴露 pg 原生客户端，供需要流式查询、COPY 等高级特性的场景使用 */
  get native(): pg.Client {
    return this.client;
  }

  async $connect(): Promise<void> {
    await this.client.connect();
  }

  async $disconnect(): Promise<void> {
    await this.client.end();
  }

  /**
   * 在事务中执行回调；异常时回滚并抛出，避免部分写入。
   *
   * 回调拿到的是包装后的 Tx，而不是原生 pg.Client：仓储层在事务中同样使用
   * $queryRawUnsafe / $executeRawUnsafe，直接把原生客户端当 Tx 传出去会让
   * 这些方法缺失。
   */
  async $transaction<R>(handler: (tx: Tx) => Promise<R>): Promise<R> {
    await this.client.query("BEGIN");
    try {
      const tx: Tx = {
        $queryRawUnsafe: this.$queryRawUnsafe.bind(this),
        $executeRawUnsafe: this.$executeRawUnsafe.bind(this),
      };
      const result = await handler(tx);
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    const result = await this.client.query(query, values.map(toDriverValue));
    return result.rows as T;
  }

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    const result = await this.client.query(query, values.map(toDriverValue));
    return result.rowCount ?? 0;
  }
}

/** 读取数据库连接串：优先 DB_URL，其次 DATABASE_URL，缺省回落本地开发库 */
export function resolveDatabaseUrl(explicit?: string): string {
  return explicit ?? process.env.DB_URL ?? process.env.DATABASE_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
}
