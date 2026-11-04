import type { PrismaClientLike, Tx } from "@agri/db";

/**
 * 测试数据库。
 *
 * 单元测试不应依赖真实数据库，但完全打桩又会漏掉事务边界与 SQL 相关的问题。
 * 折中做法是提供一个行为收敛的假客户端：连接、事务、原始 SQL 调用都可被观察，
 * 需要贴近真实行为的场景再由集成测试接入容器化数据库。
 */

/** 测试数据库选项 */
export interface TestDatabaseOptions {
  /** 连接串，缺省指向本地测试库 */
  url?: string;
  /** 模式名，每个测试文件使用独立模式以隔离数据 */
  schema?: string;
  /** 连接池上限 */
  poolSize?: number;
  /** 复位时清空的表，缺省清空全部业务表 */
  tables?: string[];
}

/** 测试数据库句柄 */
export interface TestDatabase {
  url: string;
  schema: string;
  /** 客户端实例，可直接注入服务 */
  client: PrismaClientLike;
  /** 已执行的原始 SQL，供断言 */
  executedSql: string[];
  /** 是否已释放 */
  readonly stopped: boolean;
  /** 复位数据 */
  reset(): Promise<void>;
  /** 释放连接 */
  stop(): Promise<void>;
}

/** 默认清空的业务表，顺序按外键依赖从子到父 */
export const DEFAULT_TEST_TABLES = [
  "telemetry_record",
  "device",
  "operation_record",
  "prescription",
  "crop_season",
  "plot_grid",
  "plot",
];

/** 构造假客户端：事务回调直接使用同一上下文，便于断言 SQL */
function createFakeClient(executedSql: string[]): PrismaClientLike {
  const tx: Tx = {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      executedSql.push(query);
      return values as unknown as T;
    },
    async $executeRawUnsafe(query: string): Promise<number> {
      executedSql.push(query);
      return 1;
    },
  };
  return {
    async $connect(): Promise<void> {
      executedSql.push("CONNECT");
    },
    async $disconnect(): Promise<void> {
      executedSql.push("DISCONNECT");
    },
    async $transaction<R>(handler: (inner: Tx) => Promise<R>): Promise<R> {
      executedSql.push("BEGIN");
      try {
        const result = await handler(tx);
        executedSql.push("COMMIT");
        return result;
      } catch (error) {
        executedSql.push("ROLLBACK");
        throw error;
      }
    },
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      return tx.$queryRawUnsafe<T>(query, ...values);
    },
    async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
      return tx.$executeRawUnsafe(query, ...values);
    },
  };
}

/**
 * 创建测试数据库句柄。
 * @param options 选项
 * @returns 测试数据库句柄
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const url = options.url ?? "postgresql://agri:agri@localhost:5432/agri_test";
  const schema = options.schema ?? `test_${process.pid}`;
  const executedSql: string[] = [];
  const client = createFakeClient(executedSql);
  await client.$connect();

  let stopped = false;
  const handle: TestDatabase = {
    url,
    schema,
    client,
    executedSql,
    get stopped(): boolean {
      return stopped;
    },
    async reset(): Promise<void> {
      await resetDatabase(handle, options.tables);
    },
    async stop(): Promise<void> {
      await stopTestDatabase(handle);
      stopped = true;
    },
  };
  return handle;
}

/**
 * 清空测试数据并重置自增序列。
 * @param db 测试数据库句柄
 * @param tables 要清空的表，缺省使用默认业务表
 */
export async function resetDatabase(db: TestDatabase, tables: string[] = DEFAULT_TEST_TABLES): Promise<void> {
  const list = tables.join(", ");
  await db.client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * 释放测试数据库连接。
 * @param db 测试数据库句柄
 */
export async function stopTestDatabase(db: TestDatabase): Promise<void> {
  await db.client.$disconnect();
}
