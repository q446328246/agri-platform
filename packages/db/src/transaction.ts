import { AsyncLocalStorage } from "node:async_hooks";

import { BizError } from "@agri/shared";

/**
 * 事务客户端与事务上下文。
 *
 * 事务上下文使用异步本地存储承载，使仓储层无需逐层透传事务对象即可取到当前事务，
 * 避免事务边界因参数漏传而静默扩大或失效。
 */

/** 模型代理的最小契约，与 ORM 生成类型的常用方法对齐 */
export interface ModelDelegate<T = unknown> {
  create(args: unknown): Promise<T>;
  createMany?(args: unknown): Promise<{ count: number }>;
  findUnique(args: unknown): Promise<T | null>;
  findMany(args?: unknown): Promise<T[]>;
  update(args: unknown): Promise<T>;
  delete(args: unknown): Promise<T>;
  count(args?: unknown): Promise<number>;
}

/** 事务客户端类型别名。真实工程中应替换为 ORM 生成的 TransactionClient 类型 */
export interface Tx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  [model: string]: unknown;
}

/** 数据库客户端契约，与 ORM 客户端实例的公共方法对齐 */
export interface PrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<R>(handler: (tx: Tx) => Promise<R>, options?: { timeout?: number }): Promise<R>;
  /** 原生查询，用于探活与下沉的空间运算 */
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  /** 原生执行，用于批量维护语句 */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  [model: string]: unknown;
}

/** 客户端工厂：由各服务注入真实 ORM 客户端的构造方式 */
export type PrismaClientFactory = (config: { url: string; poolSize: number }) => PrismaClientLike;

/** 把事务视为模型代理集合，供业务代码取用模型 */
export function model<T = unknown>(tx: Tx, name: string): ModelDelegate<T> {
  const delegate = tx[name];
  if (!delegate) {
    throw new BizError("SYS-500-001", `事务中不存在模型 ${name}`, 500);
  }
  return delegate as ModelDelegate<T>;
}

/** 事务上下文契约：供仓储层取用当前事务 */
export interface TransactionHost {
  /** 读取当前事务，未处于事务中时返回 undefined */
  current(): Tx | undefined;
  /** 在指定事务中执行回调 */
  run<R>(tx: Tx, fn: () => Promise<R>): Promise<R>;
}

const storage = new AsyncLocalStorage<Tx>();

/** 事务上下文单例 */
export const transactionHost: TransactionHost = {
  current(): Tx | undefined {
    return storage.getStore();
  },
  async run<R>(tx: Tx, fn: () => Promise<R>): Promise<R> {
    return storage.run(tx, fn);
  },
};
