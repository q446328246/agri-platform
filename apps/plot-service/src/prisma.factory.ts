import { randomBytes } from "node:crypto";

import type { PrismaClientFactory, PrismaClientLike, Tx } from "@agri/db";

/**
 * 示例用客户端工厂。
 *
 * 真实工程中此处应返回 ORM 生成的客户端实例；示例工程不引入具体 ORM，
 * 因此在内存中实现最小可用的客户端契约，用于演示装配关系与调用链。
 */

/** 内存表：以模型名为主键的数组存储 */
type Table = Record<string, unknown>[];

/** 内存客户端 */
export interface ExampleClient extends PrismaClientLike {
  /** 便于演示观察：所有原始 SQL 原样记录 */
  readonly executed: string[];
}

function createTx(tables: Map<string, Table>, executed: string[]): Tx {
  return {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      executed.push(query);
      const table = tables.get("plot") ?? [];
      const [parcelCode] = values as [string | undefined];
      const hit = table.find((row) => (row as { parcelCode?: string }).parcelCode === parcelCode);
      return (hit ?? null) as unknown as T;
    },
    async $executeRawUnsafe(query: string): Promise<number> {
      executed.push(query);
      return 1;
    },
  };
}

/**
 * 构造示例客户端工厂。
 * @returns 客户端工厂
 */
export function createExamplePrismaFactory(): PrismaClientFactory {
  const executed: string[] = [];
  return (): PrismaClientLike => {
    const tables = new Map<string, Table>([["plot", []]]);
    const tx = createTx(tables, executed);
    return {
      async $connect(): Promise<void> {
        executed.push("CONNECT");
      },
      async $disconnect(): Promise<void> {
        executed.push("DISCONNECT");
      },
      async $transaction<R>(handler: (inner: Tx) => Promise<R>): Promise<R> {
        executed.push("BEGIN");
        try {
          const result = await handler(tx);
          executed.push("COMMIT");
          return result;
        } catch (error) {
          executed.push("ROLLBACK");
          throw error;
        }
      },
      async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
        return tx.$queryRawUnsafe<T>(query, ...values);
      },
      async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
        return tx.$executeRawUnsafe(query, ...values);
      },
      get executed(): string[] {
        return executed;
      },
    };
  };
}

/** 生成带前缀的示例标识，便于肉眼区分数据来源 */
export function exampleId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}
