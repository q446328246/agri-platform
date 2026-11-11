import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";
import { InMemoryTraceRepository, SqlTraceRepository } from "../src/repository.js";

const record = { id: "r-1", traceCode: "TR-1", batchCode: "BT-1", plotCode: "P-1", event: "SOWING", detail: "播种完成", operator: "admin", createdAt: "2026-01-01" };
describe("TraceRepository", () => {
  it("内存实现支持按地块与追溯码查询", async () => { const repo = new InMemoryTraceRepository(); await repo.create(record); await expect(repo.list("P-1")).resolves.toHaveLength(1); await expect(repo.findByCode("TR-1")).resolves.toMatchObject({ event: "SOWING" }); });
  it("内存实现支持按事件类型筛选", async () => { const repo = new InMemoryTraceRepository(); await repo.create(record); await repo.create({ ...record, id: "r-2", traceCode: "TR-2", event: "PRESCRIPTION_ISSUED" }); await expect(repo.list(undefined, "PRESCRIPTION_ISSUED")).resolves.toMatchObject([{ traceCode: "TR-2" }]); await expect(repo.list("P-1", "FARM_OPERATION")).resolves.toHaveLength(0); });
  it("内存实现按溯源码成链，时间正序", async () => {
    const repo = new InMemoryTraceRepository();
    await repo.create({ ...record, id: "c3", traceCode: "TR-3", batchCode: "BT-CHAIN", createdAt: "2026-03-01" });
    await repo.create({ ...record, id: "c1", traceCode: "TR-4", batchCode: "BT-CHAIN", createdAt: "2026-01-01" });
    await repo.create({ ...record, id: "c2", traceCode: "TR-5", batchCode: "BT-CHAIN", createdAt: "2026-02-01" });
    await repo.create({ ...record, id: "c9", traceCode: "TR-9", batchCode: "BT-OTHER", createdAt: "2026-01-15" });
    const chain = await repo.chain("BT-CHAIN");
    expect(chain.map((row) => row.id)).toEqual(["c1", "c2", "c3"]);
    await expect(repo.list(undefined, undefined, "BT-CHAIN")).resolves.toHaveLength(3);
  });
  it("SQL 实现按地块与事件组合过滤", async () => { const calls: Array<{ query: string; values: unknown[] }> = []; const client: PrismaClientLike = { async $connect() {}, async $disconnect() {}, async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler({} as Tx); }, async $queryRawUnsafe<T>(query: string, ...values: unknown[]) { calls.push({ query, values }); return [] as T; }, async $executeRawUnsafe(query: string) { calls.push({ query, values: [] }); return 1; } }; const repo = new SqlTraceRepository(client); await repo.list("P-1", "PRESCRIPTION_ISSUED"); expect(calls[0]?.query).toContain("WHERE plot_code = $1 AND event = $2"); expect(calls[0]?.values).toEqual(["P-1", "PRESCRIPTION_ISSUED"]); });
  it("SQL 实现按溯源码过滤走 batch_code 参数", async () => { const calls: Array<{ query: string; values: unknown[] }> = []; const client: PrismaClientLike = { async $connect() {}, async $disconnect() {}, async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler({} as Tx); }, async $queryRawUnsafe<T>(query: string, ...values: unknown[]) { calls.push({ query, values }); return [] as T; }, async $executeRawUnsafe(query: string) { calls.push({ query, values: [] }); return 1; } }; const repo = new SqlTraceRepository(client); await repo.list(undefined, undefined, "BT-1"); expect(calls[0]?.query).toContain("batch_code = $1"); expect(calls[0]?.values).toEqual(["BT-1"]); });
  it("SQL 实现链条按 batch_code 正序", async () => { const queries: string[] = []; const client: PrismaClientLike = { async $connect() {}, async $disconnect() {}, async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler({} as Tx); }, async $queryRawUnsafe<T>(query: string) { queries.push(query); return [] as T; }, async $executeRawUnsafe(query: string) { queries.push(query); return 1; } }; const repo = new SqlTraceRepository(client); await repo.chain("BT-1"); expect(queries[0]).toContain("WHERE batch_code = $1"); expect(queries[0]).toContain("ORDER BY created_at ASC"); });
  it("SQL 实现使用追溯码参数查询", async () => { const queries: string[] = []; const client: PrismaClientLike = { async $connect() {}, async $disconnect() {}, async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler({} as Tx); }, async $queryRawUnsafe<T>(query: string) { queries.push(query); return [] as T; }, async $executeRawUnsafe(query: string) { queries.push(query); return 1; } }; const repo = new SqlTraceRepository(client); await repo.findByCode("TR-1"); expect(queries[0]).toContain("WHERE trace_code = $1"); });
});
