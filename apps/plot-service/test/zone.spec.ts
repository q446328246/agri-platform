import "reflect-metadata";

import { PrismaService } from "@agri/db";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createPlotHttpServer } from "../src/http.js";
import { InMemoryInfraLineRepository } from "../src/infra-line.repository.js";
import { PlotCodeService } from "../src/plot-code.service.js";
import { InMemoryPlotRepository } from "../src/plot.repository.js";
import { PlotService } from "../src/plot.service.js";
import { createExamplePrismaFactory } from "../src/prisma.factory.js";
import { convexHull, hullPolygon } from "../src/zone.geometry.js";
import { InMemoryZoneRepository } from "../src/zone.repository.js";

/**
 * 片区台账验证：凸包轮廓、片区增删改、地块划入/移出与按片区过滤。
 * 用内存仓储与真实 HTTP 端口，不依赖 PostgreSQL。
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
  const server = createPlotHttpServer(service, new InMemoryInfraLineRepository(), new InMemoryZoneRepository());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

interface Envelope<T> {
  status: number;
  body: { data: T; message: string };
}

async function call<T>(base: string, method: string, path: string, payload?: unknown): Promise<Envelope<T>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as { data: T; message: string } };
}

const DEMO_GEOM = {
  type: "Polygon",
  coordinates: [[[107.4212, 30.9805], [107.4232, 30.9805], [107.4232, 30.9825], [107.4212, 30.9825], [107.4212, 30.9805]]],
  srid: 4490,
};

async function createPlot(base: string, parcel: string): Promise<string> {
  const created = await call<{ parcelCode: string }>(base, "POST", "/api/v1/plots", {
    region: "511723",
    farm: "000001",
    area: "01",
    parcel,
    parcelName: `片区验证地块 ${parcel}`,
    areaMu: 12.5,
    soilType: "PADDY_SOIL",
    farmId: "farm-kaijiang-01",
    geom: DEMO_GEOM,
  });
  expect(created.status).toBe(201);
  return created.body.data.parcelCode;
}

describe("片区凸包", () => {
  it("外轮廓取凸包并首尾闭合，点不足时返回 null", () => {
    const hull = convexHull([
      { lng: 0, lat: 0 },
      { lng: 2, lat: 0 },
      { lng: 2, lat: 2 },
      { lng: 0, lat: 2 },
      { lng: 1, lat: 1 },
    ]);
    expect(hull).toHaveLength(4);
    const polygon = hullPolygon(hull);
    expect(polygon?.coordinates[0]).toHaveLength(5);
    expect(polygon?.coordinates[0]?.[0]).toEqual(polygon?.coordinates[0]?.[4]);
    expect(hullPolygon([{ lng: 0, lat: 0 }, { lng: 1, lat: 1 }])).toBeNull();
  });
});

describe("片区台账与地块归属", () => {
  it("建档、重码拒绝、划入地块、按片区过滤、移出后删除", async () => {
    const base = await startServer();
    const created = await call<{ zoneCode: string; color: string }>(base, "POST", "/api/v1/zones", {
      zoneCode: "ZONE-T1",
      zoneName: "测试东区",
      color: "#00d4ff",
      description: "单测片区",
    });
    expect(created.status).toBe(201);
    expect(created.body.data.zoneCode).toBe("ZONE-T1");

    const duplicate = await call(base, "POST", "/api/v1/zones", { zoneCode: "ZONE-T1", zoneName: "重复编码" });
    expect(duplicate.status).toBe(409);

    // 未给编码时自动生成，避免前端必须自己想编码规则
    const auto = await call<{ zoneCode: string }>(base, "POST", "/api/v1/zones", { zoneName: "自动编码片区" });
    expect(auto.status).toBe(201);
    expect(auto.body.data.zoneCode).toMatch(/^ZONE-/);

    const parcelCode = await createPlot(base, "00011");
    const assigned = await call<{ zoneCode: string }>(base, "POST", "/api/v1/zones/ZONE-T1/plots", { parcelCode });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.zoneCode).toBe("ZONE-T1");

    const list = await call<Array<{ zoneCode: string; plotCount: number; areaMu: number }>>(base, "GET", "/api/v1/zones");
    const zone = list.body.data.find((item) => item.zoneCode === "ZONE-T1");
    expect(zone?.plotCount).toBe(1);
    expect(zone?.areaMu).toBe(12.5);

    const filtered = await call<{ total: number; items: Array<{ parcelCode: string }> }>(base, "GET", "/api/v1/plots?zoneCode=ZONE-T1");
    expect(filtered.body.data.total).toBe(1);
    expect(filtered.body.data.items[0]?.parcelCode).toBe(parcelCode);

    // 一张图：有成员地块就有凸包与中心点，空片区两者都为空
    const map = await call<Array<{ zoneCode: string; hull: unknown; centroid: { lng: number; lat: number } | null }>>(base, "GET", "/api/v1/zones/map");
    const drawn = map.body.data.find((item) => item.zoneCode === "ZONE-T1");
    expect(drawn?.hull).not.toBeNull();
    expect(drawn?.centroid?.lng).toBeCloseTo(107.4222, 3);
    const empty = map.body.data.find((item) => item.zoneCode === auto.body.data.zoneCode);
    expect(empty?.hull).toBeNull();

    const detail = await call<{ plots: unknown[] }>(base, "GET", "/api/v1/zones/ZONE-T1");
    expect(detail.body.data.plots).toHaveLength(1);

    // 有归属地块时不能删片区，先移出再删
    expect((await call(base, "DELETE", "/api/v1/zones/ZONE-T1")).status).toBe(409);
    expect((await call(base, "DELETE", `/api/v1/zones/ZONE-T1/plots/${parcelCode}`)).status).toBe(200);
    expect((await call<{ total: number }>(base, "GET", "/api/v1/plots?zoneCode=ZONE-T1")).body.data.total).toBe(0);
    expect((await call(base, "DELETE", "/api/v1/zones/ZONE-T1")).status).toBe(200);
    expect((await call(base, "DELETE", "/api/v1/zones/ZONE-T1")).status).toBe(404);
  });

  it("拒绝空名称、非法边界与不存在的片区", async () => {
    const base = await startServer();
    expect((await call(base, "POST", "/api/v1/zones", { zoneName: "  " })).status).toBe(400);
    expect((await call(base, "POST", "/api/v1/zones", { zoneName: "坏边界", geom: { type: "Polygon", coordinates: [[[107.4, 30.9]]], srid: 4490 } })).status).toBe(400);
    expect((await call(base, "POST", "/api/v1/zones/NOPE/plots", { parcelCode: "X" })).status).toBe(404);
    expect((await call(base, "GET", "/api/v1/zones/NOPE")).status).toBe(404);
  });
});
