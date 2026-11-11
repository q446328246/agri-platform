import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";
import { aggregateReport, InMemoryFinanceRepository, SqlFinanceRepository } from "../src/repository.js";

const entry = { id: "f-1", plotCode: "P-1", season: "2026", kind: "INPUT" as const, category: "SEED", amount: 100, unit: "元", note: "种子", createdAt: "2026-01-01" };

describe("FinanceRepository", () => {
  it("内存实现计算投入产出利润", async () => { const repo = new InMemoryFinanceRepository(); await repo.create(entry); await repo.create({ ...entry, id: "f-2", kind: "OUTPUT", amount: 260 }); await expect(repo.summary("P-1")).resolves.toMatchObject({ input: 100, output: 260, profit: 160 }); });
  it("SQL 实现使用租户外的地块过滤参数", async () => { const queries: string[] = []; const client: PrismaClientLike = { async $connect() {}, async $disconnect() {}, async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler({} as Tx); }, async $queryRawUnsafe<T>(query: string) { queries.push(query); return [{ kind: "INPUT", total: 100 }] as T; }, async $executeRawUnsafe(query: string) { queries.push(query); return 1; } }; const repo = new SqlFinanceRepository(client); await repo.summary("P-1"); expect(queries[0]).toContain("WHERE plot_code = $1"); });
  it("内存报表按月份/类别/地块聚合，利润现算", async () => {
    const repo = new InMemoryFinanceRepository();
    // 东八区跨月：UTC 2025-12-31T16:30 属 2026-01-01；UTC 2026-01-31T23:00 属 2026-02-01
    await repo.create({ ...entry, id: "a", plotCode: "P-1", kind: "INPUT", category: "SEED", amount: 100, createdAt: "2025-12-31T16:30:00.000Z" });
    await repo.create({ ...entry, id: "b", plotCode: "P-1", kind: "OUTPUT", category: "稻谷销售", amount: 300, createdAt: "2026-01-15T02:00:00.000Z" });
    await repo.create({ ...entry, id: "c", plotCode: "P-2", kind: "INPUT", category: "SEED", amount: 50, createdAt: "2026-01-31T23:00:00.000Z" });
    const report = await repo.report();
    expect(report.months.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(report.months[0]).toMatchObject({ input: 100, output: 300, profit: 200 });
    expect(report.categories.find((c) => c.category === "SEED")?.amount).toBe(150);
    expect(report.plots.map((p) => p.plotCode)).toEqual(["P-1", "P-2"]);
    expect(report.plots[0]).toMatchObject({ profit: 200 });
    const filtered = await repo.report("P-2");
    expect(filtered.months).toHaveLength(1);
    expect(filtered.plots).toEqual([{ plotCode: "P-2", input: 50, output: 0, profit: -50 }]);
  });
  it("SQL 报表走三组 GROUP BY 且金额由库聚合", async () => {
    const queries: string[] = [];
    const client: PrismaClientLike = {
      async $connect() {}, async $disconnect() {},
      async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler({} as Tx); },
      async $queryRawUnsafe<T>(query: string) {
        queries.push(query);
        if (query.includes("GROUP BY month")) return [{ month: "2026-01", kind: "INPUT", total: "100" }, { month: "2026-01", kind: "OUTPUT", total: "300" }] as T;
        if (query.includes("GROUP BY kind, category")) return [{ kind: "OUTPUT", category: "稻谷销售", total: "300" }] as T;
        return [{ plot_code: "P-1", kind: "INPUT", total: "100" }, { plot_code: "P-1", kind: "OUTPUT", total: "300" }] as T;
      },
      async $executeRawUnsafe(query: string) { queries.push(query); return 1; },
    };
    const report = await new SqlFinanceRepository(client).report("P-1");
    expect(queries).toHaveLength(3);
    expect(queries.every((q) => q.includes("WHERE plot_code = $1"))).toBe(true);
    expect(report.months[0]).toMatchObject({ month: "2026-01", input: 100, output: 300, profit: 200 });
    expect(report.categories[0]).toMatchObject({ kind: "OUTPUT", amount: 300 });
    expect(report.plots[0]).toMatchObject({ plotCode: "P-1", profit: 200 });
  });
  it("报表聚合与展示层月份口径一致（东八区跨年）", () => {
    const report = aggregateReport([{ ...entry, kind: "OUTPUT", amount: 10, createdAt: "2026-01-01T00:00:00.000Z" }]);
    expect(report.months[0]?.month).toBe("2026-01");
  });
});
