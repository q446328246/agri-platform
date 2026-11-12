import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createTraceHttpServer } from "../src/http.js";
import { InMemoryTraceRepository } from "../src/repository.js";

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

function seed(): InMemoryTraceRepository {
  const repo = new InMemoryTraceRepository();
  const base = { plotCode: "P-1", event: "FARM_OPERATION", detail: "", operator: "admin" };
  void repo.create({ id: "c1", traceCode: "TR-a", batchCode: "BT-CHAIN", ...base, createdAt: "2026-01-01T00:00:00.000Z" });
  void repo.create({ id: "c3", traceCode: "TR-c", batchCode: "BT-CHAIN", ...base, event: "HARVEST", detail: "采收", createdAt: "2026-03-01T00:00:00.000Z" });
  void repo.create({ id: "c2", traceCode: "TR-b", batchCode: "BT-CHAIN", ...base, createdAt: "2026-02-01T00:00:00.000Z" });
  void repo.create({ id: "x", traceCode: "TR-x", batchCode: "", ...base, createdAt: "2026-02-15T00:00:00.000Z" });
  return repo;
}

describe("trace HTTP chain", () => {
  it("按溯源码返回时间正序的完整链条", async () => {
    const base = await start(createTraceHttpServer(seed()));
    const res = await fetch(`${base}/api/v1/trace/chain/BT-CHAIN`);
    expect(res.status).toBe(200);
    const chain = (await res.json() as { data: Array<{ id: string }> }).data;
    expect(chain.map((row) => row.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("列表按 batchCode 过滤，未成链记录可查", async () => {
    const base = await start(createTraceHttpServer(seed()));
    const res = await fetch(`${base}/api/v1/trace/records?batchCode=BT-CHAIN&size=50`);
    const page = (await res.json() as { data: { total: number } }).data;
    expect(page.total).toBe(3);
  });

  it("新增记录写入溯源码并可回查", async () => {
    const base = await start(createTraceHttpServer(seed()));
    const created = await fetch(`${base}/api/v1/trace/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchCode: "BT-NEW", plotCode: "P-9", event: "INPUT", detail: "领用有机肥", operator: "张伟" }) });
    expect(created.status).toBe(201);
    const record = (await created.json() as { data: { batchCode: string } }).data;
    expect(record.batchCode).toBe("BT-NEW");
    const chain = await fetch(`${base}/api/v1/trace/chain/BT-NEW`);
    expect(((await chain.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("灌溉完成档案不接受人工补录", async () => {
    const base = await start(createTraceHttpServer(seed()));
    const res = await fetch(`${base}/api/v1/trace/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plotCode: "P-9", event: "IRRIGATION_FINISHED", detail: "手填用水 999 立方米", operator: "张伟" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toContain("不支持人工补录");
    // 拒绝要真的没落库：这条地块的档案还是空的
    const list = (await (await fetch(`${base}/api/v1/trace/records?plotCode=P-9`)).json() as { data: { items: unknown[] } }).data;
    expect(list.items).toHaveLength(0);
  });

  it("chain 路由不被单条追溯码路由抢占", async () => {
    const base = await start(createTraceHttpServer(seed()));
    const res = await fetch(`${base}/api/v1/trace/chain/TR-a`);
    // TR-a 不是溯源码，链为空数组而非 findByCode 的单条
    const body = (await res.json() as { data: unknown[] }).data;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });
});
