import { describe, expect, it } from "vitest";

import { BizError } from "@agri/shared";

import {
  DbHealthIndicator,
  paginate,
  softDeleteExtension,
  SOFT_DELETE_FIELD,
  transactionHost,
  withTransaction,
} from "../src/index.js";
import type { PrismaClientLike, Tx } from "../src/index.js";

/**
 * 数据访问封装的契约测试。
 * 假客户端不连真实库，但完整保留事务边界与重试行为，因此能覆盖最容易出错的
 * 「事务边界」与「可重试错误判定」两处逻辑。
 */

interface FakeClient {
  client: PrismaClientLike;
  executed: string[];
  attempts: () => number;
}

/** 构造假客户端；failures 指定前若干次事务调用抛出可重试错误 */
function makeClient(options: { failures?: number; errorMessage?: string } = {}): FakeClient {
  const executed: string[] = [];
  let attempts = 0;
  const failures = options.failures ?? 0;
  const errorMessage = options.errorMessage ?? "deadlock detected";

  const tx: Tx = {
    async $queryRawUnsafe<T>(): Promise<T> {
      return [{ ok: 1 }] as unknown as T;
    },
    async $executeRawUnsafe(): Promise<number> {
      return 1;
    },
  };

  const client: PrismaClientLike = {
    async $connect(): Promise<void> {},
    async $disconnect(): Promise<void> {},
    async $transaction<R>(handler: (inner: Tx) => Promise<R>): Promise<R> {
      attempts += 1;
      if (attempts <= failures) {
        throw new Error(errorMessage);
      }
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
    async $queryRawUnsafe<T>(): Promise<T> {
      return tx.$queryRawUnsafe<T>("SELECT 1");
    },
    async $executeRawUnsafe(): Promise<number> {
      return 1;
    },
  };

  return { client, executed, attempts: () => attempts };
}

describe("事务封装", () => {
  it("提交路径写入 BEGIN 与 COMMIT，且事务上下文在回调内可见", async () => {
    const fake = makeClient();
    let inside: Tx | undefined;
    const result = await withTransaction(fake.client, async (tx) => {
      inside = transactionHost.current();
      return "done";
    });

    expect(result).toBe("done");
    expect(inside).toBeDefined();
    expect(fake.executed).toEqual(["BEGIN", "COMMIT"]);
    expect(transactionHost.current()).toBeUndefined();
  });

  it("异常时回滚并把原始异常上抛", async () => {
    const fake = makeClient();
    await expect(
      withTransaction(fake.client, async () => {
        throw new BizError("PLOT-409-001", "地块编码已存在", 409);
      }),
    ).rejects.toThrow("地块编码已存在");
    expect(fake.executed).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("并发冲突与死锁按策略重试，业务错误不重试", async () => {
    const retryable = makeClient({ failures: 2 });
    await expect(withTransaction(retryable.client, async () => "ok", { retries: 2, baseBackoffMs: 1 })).resolves.toBe(
      "ok",
    );
    expect(retryable.attempts()).toBe(3);

    const business = makeClient({ failures: 3, errorMessage: "面积必须大于 0" });
    await expect(
      withTransaction(business.client, async () => "ok", { retries: 2, baseBackoffMs: 1 }),
    ).rejects.toThrow("面积必须大于 0");
    expect(business.attempts()).toBe(1);
  });
});

describe("分页与软删除", () => {
  it("排序字段必须命中白名单，否则拒绝", async () => {
    const model = {
      findMany: async () => [{ id: "1" }],
      count: async () => 1,
    };
    await expect(paginate(model, { tenantId: "t" }, { sortBy: "createdAt" })).rejects.toThrow(BizError);
    const page = await paginate(model, { tenantId: "t" }, { sortBy: "createdAt", allowedSortFields: ["createdAt"] });
    expect(page.total).toBe(1);
  });

  it("每页条数与页码在边界内被修正", async () => {
    const model = { findMany: async () => [], count: async () => 0 };
    const page = await paginate(model, {}, { size: 999, page: 0 });
    expect(page.size).toBe(200);
    expect(page.page).toBe(1);
  });

  it("软删除把查询限定为未删除并保留租户条件", () => {
    expect(softDeleteExtension.buildWhere({ tenantId: "t" })).toEqual({ tenantId: "t", [SOFT_DELETE_FIELD]: null });
    expect(softDeleteExtension.buildDeletedWhere({ tenantId: "t" })[SOFT_DELETE_FIELD]).toEqual({ not: null });
    expect(softDeleteExtension.buildDeleteData()[SOFT_DELETE_FIELD]).toBeInstanceOf(Date);
  });
});

describe("数据源健康检查", () => {
  it("探测成功返回 up 与耗时", async () => {
    const fake = makeClient();
    const health = await new DbHealthIndicator(fake.client, { slowQueryMs: 10000 }).check();
    expect(health.status).toBe("up");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("探测失败返回 down 与原因", async () => {
    const failing: PrismaClientLike = {
      async $connect(): Promise<void> {},
      async $disconnect(): Promise<void> {},
      async $transaction<R>(handler: (inner: Tx) => Promise<R>): Promise<R> {
        return handler({} as Tx);
      },
      async $queryRawUnsafe<T>(): Promise<T> {
        throw new Error("连接被拒绝");
      },
      async $executeRawUnsafe(): Promise<number> {
        return 0;
      },
    };
    const health = await new DbHealthIndicator(failing).check();
    expect(health.status).toBe("down");
    expect(health.message).toBe("连接被拒绝");
  });
});
