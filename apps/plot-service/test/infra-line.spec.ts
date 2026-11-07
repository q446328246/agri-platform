import "reflect-metadata";

import { PrismaService } from "@agri/db";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createPlotHttpServer } from "../src/http.js";
import { InMemoryInfraLineRepository, estimateLengthM } from "../src/infra-line.repository.js";
import { PlotCodeService } from "../src/plot-code.service.js";
import { InMemoryPlotRepository } from "../src/plot.repository.js";
import { PlotService } from "../src/plot.service.js";
import { createExamplePrismaFactory } from "../src/prisma.factory.js";

/**
 * 管线图层验证：几何长度估算、仓储增删，以及 HTTP 层按类型过滤与软删除。
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
  const server = createPlotHttpServer(service, new InMemoryInfraLineRepository());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe("田间管线", () => {
  it("按折点估算长度", () => {
    // 纬度方向 0.001 度约 110.5 米
    const length = estimateLengthM({ type: "LineString", srid: 4490, coordinates: [[107.4213, 30.9824], [107.4213, 30.9834]] });
    expect(length).toBeGreaterThan(109);
    expect(length).toBeLessThan(112);
    expect(estimateLengthM({ type: "LineString", srid: 4490, coordinates: [[107.4213, 30.9824]] })).toBe(0);
  });

  it("新增、按类型过滤并软删除管线", async () => {
    const base = await startServer();
    const created = await fetch(`${base}/api/v1/plots/infra-lines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineName: "东区灌水主管",
        lineType: "IRRIGATION_PIPE",
        geom: { type: "LineString", coordinates: [[107.4213, 30.9824], [107.4223, 30.9824]], srid: 4490 },
      }),
    });
    expect(created.status).toBe(201);
    const line = (await created.json() as { data: { lineCode: string; lengthM: number } }).data;
    expect(line.lineCode).toMatch(/^LINE-/);
    expect(line.lengthM).toBeGreaterThan(90);

    const other = await fetch(`${base}/api/v1/plots/infra-lines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineName: "东区电力线", lineType: "ELECTRIC_LINE", geom: { type: "LineString", coordinates: [[107.4213, 30.9824], [107.4213, 30.9834]], srid: 4490 } }),
    });
    expect(other.status).toBe(201);

    const all = await fetch(`${base}/api/v1/plots/infra-lines`);
    expect((await all.json() as { data: unknown[] }).data).toHaveLength(2);

    const pipes = await fetch(`${base}/api/v1/plots/infra-lines?lineType=IRRIGATION_PIPE`);
    expect((await pipes.json() as { data: unknown[] }).data).toHaveLength(1);

    // 管线路径必须先于 /plots/:code 命中，不能被当成地块编码
    const removed = await fetch(`${base}/api/v1/plots/infra-lines/${line.lineCode}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await (await fetch(`${base}/api/v1/plots/infra-lines`)).json() as { data: unknown[] }).data).toHaveLength(1);

    const again = await fetch(`${base}/api/v1/plots/infra-lines/${line.lineCode}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("局部更新名称、类型与几何，改形状时重算里程", async () => {
    const base = await startServer();
    const created = await fetch(`${base}/api/v1/plots/infra-lines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lineName: "东区灌水主管",
        lineType: "IRRIGATION_PIPE",
        geom: { type: "LineString", coordinates: [[107.4213, 30.9824], [107.4223, 30.9824]], srid: 4490 },
      }),
    });
    const line = (await created.json() as { data: { lineCode: string; lengthM: number } }).data;
    const patchUrl = `${base}/api/v1/plots/infra-lines/${line.lineCode}`;

    // 只改名字：类型与几何保持原样
    const renamed = await fetch(patchUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineName: "  东区灌水支管  " }),
    });
    expect(renamed.status).toBe(200);
    const afterRename = (await renamed.json() as { data: { lineName: string; lineType: string; lengthM: number } }).data;
    expect(afterRename.lineName).toBe("东区灌水支管");
    expect(afterRename.lineType).toBe("IRRIGATION_PIPE");
    expect(afterRename.lengthM).toBeCloseTo(line.lengthM, 2);

    // 改几何：里程按新折点重算
    const reshaped = await fetch(patchUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ geom: { type: "LineString", coordinates: [[107.4213, 30.9824], [107.4213, 30.9834]], srid: 4490 } }),
    });
    expect(reshaped.status).toBe(200);
    const afterShape = (await reshaped.json() as { data: { lineName: string; lengthM: number } }).data;
    expect(afterShape.lineName).toBe("东区灌水支管");
    expect(afterShape.lengthM).toBeGreaterThan(109);
    expect(afterShape.lengthM).toBeLessThan(112);

    // 显式传长度时不再重算
    const retyped = await fetch(patchUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineType: "TELECOM", lengthM: 12.5 }),
    });
    expect(retyped.status).toBe(200);
    const afterRetype = (await retyped.json() as { data: { lineType: string; lengthM: number } }).data;
    expect(afterRetype.lineType).toBe("TELECOM");
    expect(afterRetype.lengthM).toBe(12.5);

    const badName = await fetch(patchUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineName: "  " }) });
    expect(badName.status).toBe(400);
    const badType = await fetch(patchUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineType: "PIPE" }) });
    expect(badType.status).toBe(400);
    const badGeom = await fetch(patchUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ geom: { type: "LineString", coordinates: [[107.4213, 30.9824]], srid: 4490 } }) });
    expect(badGeom.status).toBe(400);
    const missing = await fetch(`${base}/api/v1/plots/infra-lines/LINE-NOT-EXIST`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineName: "x" }) });
    expect(missing.status).toBe(404);
  });

  it("拒绝非法类型与不足两个点的几何", async () => {
    const base = await startServer();
    const badType = await fetch(`${base}/api/v1/plots/infra-lines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineName: "x", lineType: "PIPE", geom: { type: "LineString", coordinates: [[1, 2], [3, 4]], srid: 4490 } }),
    });
    expect(badType.status).toBe(400);

    const badGeom = await fetch(`${base}/api/v1/plots/infra-lines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineName: "x", lineType: "ROAD", geom: { type: "LineString", coordinates: [[1, 2]], srid: 4490 } }),
    });
    expect(badGeom.status).toBe(400);
  });
});
