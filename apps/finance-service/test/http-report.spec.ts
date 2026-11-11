import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createFinanceHttpServer } from "../src/http.js";
import { InMemoryFinanceRepository } from "../src/repository.js";
import type { FinanceEntry } from "../src/repository.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

function seed(): InMemoryFinanceRepository {
  const repo = new InMemoryFinanceRepository();
  const rows: FinanceEntry[] = [
    { id: "a", plotCode: "P-1", season: "2026", kind: "INPUT", category: "SEED", amount: 100, unit: "元", note: "种子", createdAt: "2025-12-31T16:30:00.000Z" },
    { id: "b", plotCode: "P-1", season: "2026", kind: "OUTPUT", category: "稻谷销售", amount: 300, unit: "元", note: "订单结算", createdAt: "2026-01-15T02:00:00.000Z" },
    { id: "c", plotCode: "P-2", season: "2026", kind: "INPUT", category: "SEED", amount: 60, unit: "元", note: "种子", createdAt: "2026-02-10T02:00:00.000Z" },
  ];
  for (const row of rows) void repo.create(row);
  return repo;
}

describe("finance HTTP report", () => {
  it("无筛选走聚合报表，返回月份/类别/地块三维", async () => {
    const base = await start(createFinanceHttpServer(seed()));
    const res = await fetch(`${base}/api/v1/finance/report`);
    expect(res.status).toBe(200);
    const report = (await res.json() as { data: { months: Array<{ month: string; profit: number }>; categories: unknown[]; plots: Array<{ plotCode: string }> } }).data;
    expect(report.months.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(report.months[0]?.profit).toBe(200);
    expect(report.plots.map((p) => p.plotCode).sort()).toEqual(["P-1", "P-2"]);
  });

  it("带附加筛选时按过滤后的行现算，与列表联动", async () => {
    const base = await start(createFinanceHttpServer(seed()));
    const res = await fetch(`${base}/api/v1/finance/report?category=SEED`);
    const report = (await res.json() as { data: { categories: Array<{ category: string; amount: number }>; months: Array<{ input: number; output: number }> } }).data;
    expect(report.categories).toHaveLength(1);
    expect(report.categories[0]).toMatchObject({ category: "SEED", amount: 160 });
    // 过滤掉 OUTPUT 后各月利润为负或零
    expect(report.months.every((m) => m.output === 0)).toBe(true);
  });

  it("plotCode 过滤只统计该地块", async () => {
    const base = await start(createFinanceHttpServer(seed()));
    const res = await fetch(`${base}/api/v1/finance/report?plotCode=P-2`);
    const report = (await res.json() as { data: { plots: Array<{ plotCode: string }> } }).data;
    expect(report.plots).toEqual([{ plotCode: "P-2", input: 60, output: 0, profit: -60 }]);
  });
});
