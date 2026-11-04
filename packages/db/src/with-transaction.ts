import { sleep } from "@agri/shared";

import type { PrismaClientLike, Tx } from "./transaction.js";
import { transactionHost } from "./transaction.js";

/**
 * 事务包装，自动重试可重试错误。
 *
 * 只重试由并发冲突与死锁引起的错误：这类错误重试后通常能成功；
 * 业务错误重试只会放大问题，因此一律直接抛出。
 */

/** 事务选项 */
export interface TransactionOptions {
  /** 事务超时（毫秒） */
  timeoutMs?: number;
  /** 最大重试次数，默认 2 */
  retries?: number;
  /** 重试基础退避（毫秒），按次数指数增长 */
  baseBackoffMs?: number;
}

/** 可重试的错误特征：数据库并发冲突、序列化失败、死锁 */
const RETRYABLE_PATTERNS = ["P2034", "40001", "40P01", "deadlock", "serialization"];

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const haystack = `${code} ${message}`.toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) => haystack.includes(pattern.toLowerCase()));
}

let defaultClient: PrismaClientLike | undefined;

/** 注册默认客户端，供仅传回调的调用形式使用 */
export function setDefaultClient(client: PrismaClientLike): void {
  defaultClient = client;
}

/** 读取默认客户端 */
export function getDefaultClient(): PrismaClientLike | undefined {
  return defaultClient;
}

/**
 * 事务包装。
 * 支持两种调用形式：显式传入客户端，或使用已注册的默认客户端。
 * @param clientOrHandler 客户端实例或事务回调
 * @param handlerOrOptions 事务回调或选项
 * @param options 选项
 */
export function withTransaction<R>(
  handler: (tx: Tx) => Promise<R>,
  options?: TransactionOptions,
): Promise<R>;
export function withTransaction<R>(
  client: PrismaClientLike,
  handler: (tx: Tx) => Promise<R>,
  options?: TransactionOptions,
): Promise<R>;
export async function withTransaction<R>(
  clientOrHandler: PrismaClientLike | ((tx: Tx) => Promise<R>),
  handlerOrOptions?: ((tx: Tx) => Promise<R>) | TransactionOptions,
  options?: TransactionOptions,
): Promise<R> {
  const client: PrismaClientLike | undefined =
    typeof clientOrHandler === "function" ? defaultClient : clientOrHandler;
  const handler: ((tx: Tx) => Promise<R>) | undefined =
    typeof clientOrHandler === "function"
      ? clientOrHandler
      : (handlerOrOptions as ((tx: Tx) => Promise<R>) | undefined);
  const opts: TransactionOptions =
    typeof clientOrHandler === "function" ? ((handlerOrOptions as TransactionOptions | undefined) ?? {}) : (options ?? {});

  if (!client) {
    throw new Error("未提供数据库客户端，且未注册默认客户端");
  }
  if (!handler) {
    throw new Error("事务回调不能为空");
  }

  const retries = opts.retries ?? 2;
  const baseBackoff = opts.baseBackoffMs ?? 20;

  let attempt = 0;
  for (;;) {
    try {
      const txOptions = opts.timeoutMs === undefined ? undefined : { timeout: opts.timeoutMs };
      return await client.$transaction(async (tx: Tx) => transactionHost.run(tx, () => handler(tx)), txOptions);
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) {
        throw error;
      }
      attempt += 1;
      await sleep(baseBackoff * 2 ** (attempt - 1));
    }
  }
}
