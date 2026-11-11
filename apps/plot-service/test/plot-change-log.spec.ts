import "reflect-metadata";

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
 * 地块变更留痕验证：建档/改档案/重绘边界/删除各追加一条历史，详情页按倒序回看。
 */

const servers: Server[] = [];

async function startServer(): Promise<{ base: string; logs: InMemoryPlotChangeLogRepository }> {
  const prisma = new PrismaService(
    { url: "postgresql://agri:agri@localhost:5432/agri", shardMode: "single", poolSize: 5, slowQueryMs: 500 },
    createExamplePrismaFactory(),
  );
  await prisma.onModuleInit();
  const publisher = new InMemoryEventPublisher();
  const outbox = new OutboxService(new InMemoryOutboxStore(), publisher, { tenantId: "t", traceId: "tr", producer: "plot" });
  const service = new PlotService(new InMemoryPlotRepository(), outbox, new PlotCodeService(), prisma);
  const logs = new InMemoryPlotChangeLogRepository();
  const server = createPlotHttpServer(service, new InMemoryInfraLineRepository(), undefined, undefined, logs);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return { base: `http://127.0.0.1:${address.port}`, logs };
}

const ring = [[107.4212, 30.9805], [107.4232, 30.9805], [107.4232, 30.9825], [107.4212, 30.9825], [107.4212, 30.9805]];
const geom = { type: "Polygon", coordinates: [ring], srid: 4490 };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe("地块变更历史", () => {
  it("建档追加 CREATE，改档案追加 UPDATE，历史按倒序回看", async () => {
    const { base } = await startServer();
    const created = await fetch(`${base}/api/v1/plots`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u-1" },
      body: JSON.stringify({ region: "511723", farm: "000001", area: "01", parcel: "9201", parcelName: "留痕验证地块", areaMu: roundAreaMu(polygonAreaMu(ring)), farmId: "farm-kaijiang-01", geom }),
    });
    expect(created.status).toBe(201);
    const parcelCode = (await created.json() as { data: { parcelCode: string; areaMu: number } }).data.parcelCode;

    // 只改当前作物 + 重绘边界 → 摘要含两项标签
    const updated = await fetch(`${base}/api/v1/plots/${parcelCode}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user-id": "u-2" },
      body: JSON.stringify({ currentCrop: "水稻", geom: { ...geom, coordinates: [ring.map(([lng, lat]) => [lng + 0.0001, lat])] } }),
    });
    expect(updated.status).toBe(200);

    const history = await fetch(`${base}/api/v1/plots/${parcelCode}/history`);
    expect(history.status).toBe(200);
    const rows = (await history.json() as { data: { action: string; summary: string; actor: string }[] }).data;
    expect(rows).toHaveLength(2);
    // 倒序：UPDATE 在前，CREATE 在后
    expect(rows[0]?.action).toBe("UPDATE");
    expect(rows[0]?.actor).toBe("u-2");
    expect(rows[0]?.summary).toContain("当前作物");
    expect(rows[0]?.summary).toContain("边界");
    expect(rows[1]?.action).toBe("CREATE");
    expect(rows[1]?.actor).toBe("u-1");
    expect(rows[1]?.summary).toContain("留痕验证地块");
  });

  it("删除追加 DELETE 留痕；无字段变化的更新不落库", async () => {
    const { base } = await startServer();
    const created = await fetch(`${base}/api/v1/plots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "511723", farm: "000001", area: "01", parcel: "9202", parcelName: "空更新地块", areaMu: 10, farmId: "farm-kaijiang-01", geom }),
    });
    const parcelCode = (await created.json() as { data: { parcelCode: string } }).data.parcelCode;

    // 空 body 更新：patch 无有效字段，摘要为空 → 不追加 UPDATE
    await fetch(`${base}/api/v1/plots/${parcelCode}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    // 未显式传 actor 时记为 system
    const afterUpdate = (await (await fetch(`${base}/api/v1/plots/${parcelCode}/history`)).json() as { data: { action: string; actor: string }[] }).data;
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]?.action).toBe("CREATE");
    expect(afterUpdate[0]?.actor).toBe("system");

    await fetch(`${base}/api/v1/plots/${parcelCode}`, { method: "DELETE" });
    const afterDelete = (await (await fetch(`${base}/api/v1/plots/${parcelCode}/history`)).json() as { data: { action: string }[] }).data;
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete[0]?.action).toBe("DELETE");
  });

  it("按租户隔离历史，其他租户查不到", async () => {
    const { base } = await startServer();
    const created = await fetch(`${base}/api/v1/plots`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": "tenant-a" },
      body: JSON.stringify({ region: "511723", farm: "000001", area: "01", parcel: "9203", parcelName: "租户隔离地块", areaMu: 8, farmId: "farm-kaijiang-01", geom }),
    });
    const parcelCode = (await created.json() as { data: { parcelCode: string } }).data.parcelCode;
    const other = (await (await fetch(`${base}/api/v1/plots/${parcelCode}/history`, { headers: { "x-tenant-id": "tenant-b" } })).json() as { data: unknown[] }).data;
    expect(other).toHaveLength(0);
    const own = (await (await fetch(`${base}/api/v1/plots/${parcelCode}/history`, { headers: { "x-tenant-id": "tenant-a" } })).json() as { data: unknown[] }).data;
    expect(own).toHaveLength(1);
  });
});
