import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import { PrismaService } from "@agri/db";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";
import { polygonAreaMu, roundAreaMu } from "@agri/shared";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createPlotHttpServer } from "../src/http.js";
import { InMemoryInfraLineRepository } from "../src/infra-line.repository.js";
import { InMemoryPlotChangeLogRepository } from "../src/plot-change-log.repository.js";
import { PlotCodeService } from "../src/plot-code.service.js";
import { InMemoryPlotRepository } from "../src/plot.repository.js";
import { PlotService } from "../src/plot.service.js";
import { createExamplePrismaFactory } from "../src/prisma.factory.js";

/**
 * 地块合并/拆分（#83）。
 *
 * 口径要点在这里被当成断言而不是注释：
 * - 合并后边界取源地块顶点凸包，面积按合并边界现算——两块紧邻共边的矩形
 *   凸包即真并集，因此「合并面积 = 两块面积之和」可逐位校验；
 * - 拆分块边界由调用方给出，面积同样只认几何，单块与合计都不得超过原地块；
 * - 源地块软删归档，变更历史分别落 MERGE/SPLIT/DELETE，可回查去向。
 */

const servers: Server[] = [];

function rectangle(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  const ring = [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
  return { type: "Polygon", coordinates: [ring], srid: 4490 };
}

/** 夹具面积一律由几何现算（口径见 packages/shared/src/area.ts），不写申报值 */
function areaOf(geom: { coordinates: [number, number][][] }): number {
  return roundAreaMu(polygonAreaMu(geom.coordinates[0] ?? []));
}

interface Sut {
  base: string;
  repository: InMemoryPlotRepository;
  outboxStore: InMemoryOutboxStore;
  logs: InMemoryPlotChangeLogRepository;
}

async function startServer(): Promise<Sut> {
  const prisma = new PrismaService(
    { url: "postgresql://agri:agri@localhost:5432/agri", shardMode: "single", poolSize: 5, slowQueryMs: 500 },
    createExamplePrismaFactory(),
  );
  await prisma.onModuleInit();
  const repository = new InMemoryPlotRepository();
  const outboxStore = new InMemoryOutboxStore();
  const outbox = new OutboxService(outboxStore, new InMemoryEventPublisher(), { tenantId: "t", traceId: "tr", producer: "plot" });
  const service = new PlotService(repository, outbox, new PlotCodeService(), prisma);
  const logs = new InMemoryPlotChangeLogRepository();
  const server = createPlotHttpServer(service, new InMemoryInfraLineRepository(), undefined, undefined, logs);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return { base: `http://127.0.0.1:${address.port}`, repository, outboxStore, logs };
}

async function call(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-user-id": "u-merge" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function register(base: string, parcel: string, parcelName: string, geom: unknown): Promise<string> {
  const created = await call(base, "POST", "/api/v1/plots", {
    region: "511723", farm: "000001", area: "01", parcel, parcelName,
    areaMu: areaOf(geom as { coordinates: [number, number][][] }), farmId: "farm-kaijiang-01", geom,
  });
  expect(created.status).toBe(201);
  return created.body.data.parcelCode as string;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

describe("地块合并", () => {
  // 两块东西紧邻、共边 lng=107.4232 的矩形：凸包即真并集，合并面积可逐位断言
  const east = rectangle(107.4212, 30.9805, 107.4232, 30.9825);
  const west = rectangle(107.4232, 30.9805, 107.4252, 30.9825);

  it("两个共边地块合并：新编码同片区，面积按凸包现算，源地块归档", async () => {
    const { base, repository, outboxStore } = await startServer();
    const codeA = await register(base, "9301", "合并东块", east);
    const codeB = await register(base, "9302", "合并西块", west);

    const merged = await call(base, "POST", "/api/v1/plots/merge", { parcelCodes: [codeA, codeB], parcelName: "合并后的整块" });
    expect(merged.status).toBe(201);
    const plot = merged.body.data.plot as { parcelCode: string; parcelName: string; areaMu: number; geom: { coordinates: [number, number][][] } };
    expect(plot.parcelName).toBe("合并后的整块");
    // 编码沿用源地块的区/场/片区段，仅地块序号换新
    expect(plot.parcelCode.startsWith("511723-000001-01-")).toBe(true);
    expect(plot.parcelCode).not.toBe(codeA);
    expect(plot.parcelCode).not.toBe(codeB);
    // 面积只认合并边界：凸包恰为 107.4212~107.4252 的整矩形，等于两块之和
    expect(plot.areaMu).toBe(roundAreaMu(polygonAreaMu(east.coordinates[0]) + polygonAreaMu(west.coordinates[0])));
    expect(roundAreaMu(polygonAreaMu(plot.geom.coordinates[0]))).toBe(plot.areaMu);

    // 源地块软删归档，不再出现在档案里
    expect(merged.body.data.sourceCodes).toEqual([codeA, codeB]);
    expect(repository.all().filter((row) => row.deletedAt === undefined).map((row) => row.parcelCode)).toEqual([plot.parcelCode]);

    // 建档链路不变：合并生成的新地块同样先入本地消息表
    const pending = await outboxStore.listPending(10);
    expect(pending.filter((row) => row.topic === EventTopic.PlotCreated)).toHaveLength(3);

    const history = await call(base, "GET", `/api/v1/plots/${plot.parcelCode}/history`);
    expect(history.body.data[0]).toMatchObject({ action: "MERGE", actor: "u-merge" });
    expect(history.body.data[0].summary).toContain(codeA);
    const sourceHistory = await call(base, "GET", `/api/v1/plots/${codeA}/history`);
    expect(sourceHistory.body.data.map((row: { action: string }) => row.action)).toEqual(["DELETE", "CREATE"]);
    expect(sourceHistory.body.data[0].summary).toContain(`已合并至 ${plot.parcelCode}`);
  });

  it("少于两块、含不存在或已归档编码合并被拒绝", async () => {
    const { base } = await startServer();
    const codeA = await register(base, "9311", "单块", east);

    expect((await call(base, "POST", "/api/v1/plots/merge", { parcelCodes: [codeA] })).status).toBe(400);
    const missing = await call(base, "POST", "/api/v1/plots/merge", { parcelCodes: [codeA, "511723-000001-01-99999-0000-0"] });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain("地块不存在");

    await call(base, "DELETE", `/api/v1/plots/${codeA}`);
    const codeB = await register(base, "9312", "另一块", west);
    const archived = await call(base, "POST", "/api/v1/plots/merge", { parcelCodes: [codeA, codeB] });
    expect(archived.status).toBe(404);
  });

  it("拆出去的子块面积不得超过原地块", async () => {
    const { base, repository } = await startServer();
    const code = await register(base, "9321", "待拆地块", east);
    const oversized = rectangle(107.4212, 30.9805, 107.4292, 30.9825);
    const half = rectangle(107.4212, 30.9805, 107.4222, 30.9825);
    const result = await call(base, "POST", "/api/v1/plots/split", {
      parcelCode: code,
      pieces: [
        { parcelName: "超界子块", geom: oversized },
        { parcelName: "正常子块", geom: half },
      ],
    });
    expect(result.status).toBe(400);
    expect(result.body.message).toContain("超过原地块");
    // 校验失败不落半块：原地块未归档，也没有新增任何子地块档案
    expect(repository.all().filter((row) => row.deletedAt === undefined)).toHaveLength(1);
    expect(repository.all()).toHaveLength(1);
  });
});

describe("地块拆分", () => {
  const whole = rectangle(107.4212, 30.9805, 107.4252, 30.9825);
  const pieceA = rectangle(107.4212, 30.9805, 107.4232, 30.9825);
  const pieceB = rectangle(107.4232, 30.9805, 107.4252, 30.9825);

  it("沿中线拆两块：面积各按子块几何现算，原地块归档并留痕", async () => {
    const { base, repository, outboxStore } = await startServer();
    const code = await register(base, "9331", "整块待拆", whole);

    const result = await call(base, "POST", "/api/v1/plots/split", {
      parcelCode: code,
      pieces: [
        { parcelName: "东侧子块", geom: pieceA },
        { parcelName: "西侧子块", geom: pieceB },
      ],
    });
    expect(result.status).toBe(201);
    const plots = result.body.data.plots as Array<{ parcelCode: string; parcelName: string; areaMu: number; geom: { coordinates: [number, number][][] } }>;
    expect(plots).toHaveLength(2);
    expect(plots[0]?.parcelName).toBe("东侧子块");
    expect(plots[0]?.areaMu).toBe(areaOf(pieceA));
    expect(plots[1]?.areaMu).toBe(areaOf(pieceB));
    expect(result.body.data).toMatchObject({ sourceCode: code, sourceRemoved: true, pieceAreaSum: roundAreaMu(areaOf(pieceA) + areaOf(pieceB)) });
    for (const plot of plots) expect(plot.parcelCode.startsWith("511723-000001-01-")).toBe(true);

    const live = repository.all().filter((row) => row.deletedAt === undefined).map((row) => row.parcelCode);
    expect(live).toEqual(plots.map((plot) => plot.parcelCode));

    const pending = await outboxStore.listPending(10);
    // 拆出的两块各发一条 PlotCreated，与源地块的建档事件同走本地消息表
    expect(pending.filter((row) => row.topic === EventTopic.PlotCreated)).toHaveLength(3);

    const sourceHistory = await call(base, "GET", `/api/v1/plots/${code}/history`);
    expect(sourceHistory.body.data[0]).toMatchObject({ action: "DELETE" });
    expect(sourceHistory.body.data[0].summary).toContain("已拆分为");
    const pieceHistory = await call(base, "GET", `/api/v1/plots/${plots[0]!.parcelCode}/history`);
    expect(pieceHistory.body.data[0]).toMatchObject({ action: "SPLIT" });
    expect(pieceHistory.body.data[0].summary).toContain(`由 ${code} 拆出`);
  });

  it("子块各自不超原块但相互重叠，合计超原地块仍被拒绝", async () => {
    const { base, repository } = await startServer();
    const code = await register(base, "9332", "重叠切法", whole);
    // 两块各占 3/4 宽度、中间重叠 1/4：单块校验放行，合计 1.5 倍原面积必须拦下
    const wide = rectangle(107.4212, 30.9805, 107.4242, 30.9825);
    const wideShifted = rectangle(107.4222, 30.9805, 107.4252, 30.9825);

    const result = await call(base, "POST", "/api/v1/plots/split", {
      parcelCode: code,
      pieces: [
        { parcelName: "重叠子块甲", geom: wide },
        { parcelName: "重叠子块乙", geom: wideShifted },
      ],
    });
    expect(result.status).toBe(400);
    expect(result.body.message).toContain("合计");
    expect(result.body.message).toContain("超过原地块");
    expect(repository.all()).toHaveLength(1);
    expect(repository.all()[0]?.deletedAt).toBeUndefined();
  });

  it("keepSource 保留原地块，留痕记 UPDATE", async () => {
    const { base, repository } = await startServer();
    const code = await register(base, "9341", "保留源的拆分", whole);
    const result = await call(base, "POST", "/api/v1/plots/split", {
      parcelCode: code,
      keepSource: true,
      pieces: [
        { parcelName: "试拆一", geom: pieceA },
        { parcelName: "试拆二", geom: pieceB },
      ],
    });
    expect(result.status).toBe(201);
    expect(result.body.data.sourceRemoved).toBe(false);
    expect(repository.all().filter((row) => row.deletedAt === undefined).map((row) => row.parcelCode)).toContain(code);
    const sourceHistory = await call(base, "GET", `/api/v1/plots/${code}/history`);
    expect(sourceHistory.body.data[0]).toMatchObject({ action: "UPDATE" });
    expect(sourceHistory.body.data[0].summary).toContain("保留原地块");
  });

  it("子地块少于两块或退化几何被拒绝", async () => {
    const { base } = await startServer();
    const code = await register(base, "9351", "非法拆分", whole);

    const single = await call(base, "POST", "/api/v1/plots/split", { parcelCode: code, pieces: [{ parcelName: "只有一块", geom: pieceA }] });
    expect(single.status).toBe(400);
    expect(single.body.message).toContain("至少需要两个子地块");

    const degenerate = await call(base, "POST", "/api/v1/plots/split", {
      parcelCode: code,
      pieces: [
        { parcelName: "共线退化", geom: rectangle(107.4212, 30.9805, 107.4212, 30.9825) },
        { parcelName: "正常", geom: pieceB },
      ],
    });
    expect(degenerate.status).toBe(400);
    expect(degenerate.body.message).toContain("面积为 0");
  });
});
