import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";
import { InMemoryFinanceRepository, SqlFinanceRepository } from "../src/repository.js";

const entry = { id: "f-1", plotCode: "P-1", season: "2026", kind: "INPUT" as const, category: "SEED", amount: 100, unit: "元", note: "种子", createdAt: "2026-01-01" };

describe("FinanceRepository", () => {
  it("内存实现计算投入产出利润", async () => { const repo = new InMemoryFinanceRepository(); await repo.create(entry); await repo.create({ ...entry, id: "f-2", kind: "OUTPUT", amount: 260 }); await expect(repo.summary("P-1")).resolves.toMatchObject({ input: 100, output: 260, profit: 160 }); });
  it("SQL 实现使用租户外的地块过滤参数", async () => { const queries: string[] = []; const client: PrismaClientLike = { async $connect() {}, async $disconnect() {}, async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler({} as Tx); }, async $queryRawUnsafe<T>(query: string) { queries.push(query); return [{ kind: "INPUT", total: 100 }] as T; }, async $executeRawUnsafe(query: string) { queries.push(query); return 1; } }; const repo = new SqlFinanceRepository(client); await repo.summary("P-1"); expect(queries[0]).toContain("WHERE plot_code = $1"); });
});
