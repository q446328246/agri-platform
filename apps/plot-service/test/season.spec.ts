import "reflect-metadata";

import { PrismaService } from "@agri/db";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";
import { polygonAreaMu, roundAreaMu } from "@agri/shared";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createPlotHttpServer } from "../src/http.js";
import { InMemoryInfraLineRepository } from "../src/infra-line.repository.js";
import { compareRotation, InMemoryCropSeasonRepository, isValidFarmDate } from "../src/season.repository.js";
import type { CropSeason } from "../src/season.repository.js";
import { PlotCodeService } from "../src/plot-code.service.js";
import { InMemoryPlotRepository } from "../src/plot.repository.js";
import { PlotService } from "../src/plot.service.js";
import { createExamplePrismaFactory } from "../src/prisma.factory.js";

/**
 * 种植季/茬口档案验证：轮作正序比较、日期合法性，以及 HTTP 层建档、过滤、局部更新与软删除。
 */

const servers: Server[] = [];

async function startServer(): Promise<string> {
  const prisma = new PrismaService(
    { url: "postgresql://agri:agri@localhost:5432/agri", shardMode: "single", poolSize: 5, slowQueryMs: 500 },
    createExamplePrismaFactory(),
  );
  await prisma.onModuleInit();
  const publisher = new InMemoryEventPublisher();
  const outbox = new OutboxService(new InMemoryOutboxStore(), publisher, { tenantId: "t", traceId: "tr", producer: "plot" });
  const service = new PlotService(new InMemoryPlotRepository(), outbox, new PlotCodeService(), prisma);
  const server = createPlotHttpServer(service, new InMemoryInfraLineRepository(), undefined, new InMemoryCropSeasonRepository());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

async function createPlot(base: string, parcel: string): Promise<string> {
  const ring = [[107.4212, 30.9805], [107.4232, 30.9805], [107.4232, 30.9825], [107.4212, 30.9825], [107.4212, 30.9805]];
  const res = await fetch(`${base}/api/v1/plots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      region: "511723", farm: "000001", area: "01", parcel, parcelName: `茬口验证地块${parcel}`,
      areaMu: roundAreaMu(polygonAreaMu(ring)), farmId: "farm-kaijiang-01",
      geom: { type: "Polygon", coordinates: [ring], srid: 4490 },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { data: { parcelCode: string } }).data.parcelCode;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe("种植季/茬口档案", () => {
  it("轮作正序按年份→茬次→栽期，缺日期沉底", () => {
    const mk = (over: Partial<CropSeason>): CropSeason => ({
      id: "x", seasonCode: "S", plotCode: "P", crop: "水稻", variety: "", seasonYear: 2026, seasonIndex: 1,
      plantDate: "", harvestDate: "", status: "planned", yieldKg: null, note: "", tenantId: "t", createdAt: "2026-01-01T00:00:00.000Z", ...over,
    });
    const rows = [
      mk({ seasonCode: "c", seasonYear: 2026, seasonIndex: 2 }),
      mk({ seasonCode: "a", seasonYear: 2025 }),
      mk({ seasonCode: "b", seasonYear: 2026, seasonIndex: 1, plantDate: "2026-03-01" }),
      mk({ seasonCode: "d", seasonYear: 2026, seasonIndex: 1, plantDate: "" }),
    ];
    expect(rows.sort(compareRotation).map((r) => r.seasonCode)).toEqual(["a", "b", "d", "c"]);
  });

  it("日期校验按日历，挡住 2 月 30 日", () => {
    expect(isValidFarmDate("")).toBe(true);
    expect(isValidFarmDate("2026-03-01")).toBe(true);
    expect(isValidFarmDate("2026-02-30")).toBe(false);
    expect(isValidFarmDate("2026/03/01")).toBe(false);
    expect(isValidFarmDate("2026-3-1")).toBe(false);
  });

  it("建档、按地块轮作正序查询，路径先于 /plots/:code", async () => {
    const base = await startServer();
    const parcelCode = await createPlot(base, "9101");

    const post = (body: unknown) => fetch(`${base}/api/v1/plots/seasons`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const first = await post({ plotCode: parcelCode, crop: "油菜", seasonYear: 2025, plantDate: "2025-03-20", harvestDate: "2025-05-30", status: "harvested", yieldKg: 1200 });
    expect(first.status).toBe(201);
    expect((await first.json() as { data: { seasonCode: string } }).data.seasonCode).toMatch(/^SEASON-/);

    await post({ plotCode: parcelCode, crop: " 水稻 ", variety: "甬优", seasonYear: 2026, seasonIndex: 1, plantDate: "2026-05-01", status: "growing" });
    await post({ plotCode: parcelCode, crop: "小麦", seasonYear: 2026, seasonIndex: 2, plantDate: "2026-10-20" });

    // 轮作正序：2025 油菜 → 2026-1 水稻 → 2026-2 小麦
    const listed = await fetch(`${base}/api/v1/plots/seasons?plotCode=${parcelCode}`);
    const rows = (await listed.json() as { data: { crop: string; seasonIndex: number; seasonYear: number }[] }).data;
    expect(rows.map((r) => r.crop)).toEqual(["油菜", "水稻", "小麦"]);

    // 作物名已 trim
    expect(rows[1]?.crop).toBe("水稻");

    // 按年份过滤命中 2026 两茬；按作物关键字"水"只命中水稻
    const byYear = await fetch(`${base}/api/v1/plots/seasons?plotCode=${parcelCode}&year=2026`);
    expect(((await byYear.json() as { data: unknown[] }).data)).toHaveLength(2);
    const byCrop = await fetch(`${base}/api/v1/plots/seasons?plotCode=${parcelCode}&crop=水`);
    const cropRows = (await byCrop.json() as { data: { crop: string }[] }).data;
    expect(cropRows.map((r) => r.crop)).toEqual(["水稻"]);

    // seasons 不能被当成地块编码：/plots/seasons 命中列表而非 404
    const asCode = await fetch(`${base}/api/v1/plots/seasons`);
    expect(asCode.status).toBe(200);
  });

  it("拒绝幽灵地块、非法状态、倒挂日期与负产量", async () => {
    const base = await startServer();
    const parcelCode = await createPlot(base, "9102");
    const post = (body: unknown) => fetch(`${base}/api/v1/plots/seasons`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    expect((await post({ plotCode: "PLOT-NOT-EXIST", crop: "水稻", seasonYear: 2026 })).status).toBe(400);
    expect((await post({ plotCode: parcelCode, crop: "", seasonYear: 2026 })).status).toBe(400);
    expect((await post({ plotCode: parcelCode, crop: "水稻", seasonYear: 1800 })).status).toBe(400);
    expect((await post({ plotCode: parcelCode, crop: "水稻", seasonYear: 2026, seasonIndex: 0 })).status).toBe(400);
    expect((await post({ plotCode: parcelCode, crop: "水稻", seasonYear: 2026, status: "growing " })).status).toBe(400);
    expect((await post({ plotCode: parcelCode, crop: "水稻", seasonYear: 2026, plantDate: "2026-05-01", harvestDate: "2026-04-01" })).status).toBe(400);
    expect((await post({ plotCode: parcelCode, crop: "水稻", seasonYear: 2026, yieldKg: -5 })).status).toBe(400);
    expect((await post({ plotCode: parcelCode, crop: "水稻", seasonYear: 2026, plantDate: "2026-02-30" })).status).toBe(400);
  });

  it("重复编码 409，局部更新保留其他字段，软删后不可查", async () => {
    const base = await startServer();
    const parcelCode = await createPlot(base, "9103");
    const created = await fetch(`${base}/api/v1/plots/seasons`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ seasonCode: "SEASON-FIXED", plotCode: parcelCode, crop: "玉米", seasonYear: 2026, seasonIndex: 1, plantDate: "2026-04-20", status: "growing" }),
    });
    expect(created.status).toBe(201);

    const dup = await fetch(`${base}/api/v1/plots/seasons`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ seasonCode: "SEASON-FIXED", plotCode: parcelCode, crop: "大豆", seasonYear: 2026 }),
    });
    expect(dup.status).toBe(409);

    const patchUrl = `${base}/api/v1/plots/seasons/SEASON-FIXED`;
    // 只改状态与产量：作物、栽期保持
    const harvested = await fetch(patchUrl, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "harvested", yieldKg: 650 }),
    });
    expect(harvested.status).toBe(200);
    const after = (await harvested.json() as { data: { crop: string; plantDate: string; status: string; yieldKg: number } }).data;
    expect(after.crop).toBe("玉米");
    expect(after.plantDate).toBe("2026-04-20");
    expect(after.status).toBe("harvested");
    expect(after.yieldKg).toBe(650);

    // 更新时倒挂日期被拒
    const badDate = await fetch(patchUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ harvestDate: "2026-01-01" }) });
    expect(badDate.status).toBe(400);

    // 改到幽灵地块被拒
    expect((await fetch(patchUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plotCode: "PLOT-NOT-EXIST" }) })).status).toBe(400);

    const removed = await fetch(patchUrl, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const gone = await fetch(`${base}/api/v1/plots/seasons?plotCode=${parcelCode}`);
    expect(((await gone.json() as { data: unknown[] }).data)).toHaveLength(0);
    expect((await fetch(patchUrl, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(patchUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ crop: "x" }) })).status).toBe(404);
  });
});
