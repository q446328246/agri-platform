import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createPlatformHttpServer } from "../src/http.js";
import { InMemoryDataCatalogRepository, seedDataCatalog } from "../src/data-catalog.repository.js";

// 本批测试随交付编写，按交付口径未执行（已写未跑）。

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function put(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function pageOf<T>(response: Response): Promise<{ items: T[]; total: number }> {
  return (await response.json() as { data: { items: T[]; total: number } }).data;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

describe("数据目录仓储（内存口径）", () => {
  it("构造函数默认空，种子由服务工厂显式注入，与迁移 058 逐条对齐", async () => {
    const empty = new InMemoryDataCatalogRepository();
    expect((await empty.pageAssets("tenant-demo", { page: 1, size: 20 })).total).toBe(0);
    expect((await empty.pageDictionary("tenant-demo", { page: 1, size: 20 })).total).toBe(0);

    const seed = seedDataCatalog();
    expect(seed.assets).toHaveLength(26);
    expect(seed.dictionary).toHaveLength(26);
    const repo = new InMemoryDataCatalogRepository(seed);
    expect((await repo.pageAssets("tenant-demo", { page: 1, size: 200 })).total).toBe(26);
    expect((await repo.pageDictionary("tenant-demo", { page: 1, size: 200 })).total).toBe(26);
  });

  it("分类/关键词筛选与租户隔离，字典按资产过滤", async () => {
    const repo = new InMemoryDataCatalogRepository(seedDataCatalog());
    const spatial = await repo.pageAssets("tenant-demo", { page: 1, size: 20, category: "SPATIAL" });
    expect(spatial.total).toBe(3);
    const keyword = await repo.pageAssets("tenant-demo", { page: 1, size: 20, keyword: "telemetry_readings" });
    expect(keyword.items.map((asset) => asset.code)).toContain("telemetry_readings");
    expect((await repo.pageAssets("tenant-other", { page: 1, size: 20 })).total).toBe(0);

    const readings = await repo.pageDictionary("tenant-demo", { page: 1, size: 200, assetCode: "telemetry_readings" });
    expect(readings.total).toBe(18);
    expect(await repo.countDictionaryByAsset("tenant-demo", "plot_records")).toBe(1);
    expect(await repo.countDictionaryByAsset("tenant-other", "plot_records")).toBe(0);
  });
});

describe("platform HTTP 数据资产目录（方案 11.4）", () => {
  it("默认种子可查，分类白名单校验，非法分类 400", async () => {
    const base = await start(createPlatformHttpServer());
    const all = await pageOf<{ code: string }>(await fetch(`${base}/api/v1/platform/data-assets?size=200`));
    expect(all.total).toBe(26);
    expect(all.items.map((asset) => asset.code)).toContain("plot_records");

    const spatial = await pageOf(await fetch(`${base}/api/v1/platform/data-assets?category=SPATIAL`));
    expect(spatial.total).toBe(3);

    const invalid = await fetch(`${base}/api/v1/platform/data-assets?category=UNKNOWN`);
    expect(invalid.status).toBe(400);
  });

  it("登记资产、更新与审计留痕，编码不可改、重码 409", async () => {
    const base = await start(createPlatformHttpServer());
    const created = await post(base, "/api/v1/platform/data-assets", { code: "custom_table", name: "自定义台账", category: "BUSINESS", plotLinked: true }, { "x-user-id": "user-admin" });
    expect(created.status).toBe(201);
    const asset = (await created.json() as { data: { id: string; code: string; plotLinked: boolean } }).data;
    expect(asset).toMatchObject({ code: "custom_table", plotLinked: true });

    const duplicated = await post(base, "/api/v1/platform/data-assets", { code: "custom_table", name: "重码", category: "BUSINESS" });
    expect(duplicated.status).toBe(409);

    const renamedCode = await put(base, `/api/v1/platform/data-assets/${asset.id}`, { code: "other_table" });
    expect(renamedCode.status).toBe(400);

    const updated = await put(base, `/api/v1/platform/data-assets/${asset.id}`, { name: "自定义台账（改）", plotLinked: false });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { name: string; plotLinked: boolean } }).data).toMatchObject({ name: "自定义台账（改）", plotLinked: false });

    const audit = await pageOf<{ action: string; operator: string }>(await fetch(`${base}/api/v1/platform/audit-logs?keyword=dataAsset`));
    expect(audit.items.map((log) => log.action)).toEqual(expect.arrayContaining(["dataAsset.create", "dataAsset.update"]));

    const removed = await fetch(`${base}/api/v1/platform/data-assets/${asset.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await fetch(`${base}/api/v1/platform/data-assets/${asset.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("入参校验：非法编码/分类/缺名称 400，地块标记非布尔 400，幽灵资产 404", async () => {
    const base = await start(createPlatformHttpServer());
    expect((await post(base, "/api/v1/platform/data-assets", { code: "Bad-Code", name: "非法编码", category: "BUSINESS" })).status).toBe(400);
    expect((await post(base, "/api/v1/platform/data-assets", { code: "good_code", name: "非法分类", category: "UNKNOWN" })).status).toBe(400);
    expect((await post(base, "/api/v1/platform/data-assets", { code: "good_code", category: "BUSINESS" })).status).toBe(400);
    expect((await put(base, "/api/v1/platform/data-assets/asset-demo-001", { plotLinked: "yes" })).status).toBe(400);
    expect((await put(base, "/api/v1/platform/data-assets/asset-ghost", { name: "幽灵" })).status).toBe(404);
  });

  it("删除引用守卫：资产下仍挂字典条目时 409，清理条目后才可删", async () => {
    const base = await start(createPlatformHttpServer());
    // plot_records 种子下挂 areaMu 一条字典
    const guarded = await fetch(`${base}/api/v1/platform/data-assets/asset-demo-001`, { method: "DELETE" });
    expect(guarded.status).toBe(409);
    expect((await guarded.json() as { message: string }).message).toContain("字典条目");

    const entries = await pageOf<{ id: string }>(await fetch(`${base}/api/v1/platform/data-dictionary?assetCode=plot_records`));
    for (const entry of entries.items) {
      expect((await fetch(`${base}/api/v1/platform/data-dictionary/${entry.id}`, { method: "DELETE" })).status).toBe(200);
    }
    expect((await fetch(`${base}/api/v1/platform/data-assets/asset-demo-001`, { method: "DELETE" })).status).toBe(200);
  });

  it("跨租户读不到资产，也改不了别家资产", async () => {
    const base = await start(createPlatformHttpServer());
    const headers = { "x-tenant-id": "tenant-other" };
    expect((await pageOf(await fetch(`${base}/api/v1/platform/data-assets`, { headers }))).total).toBe(0);
    const denied = await put(base, "/api/v1/platform/data-assets/asset-demo-001", { name: "被篡改" }, headers);
    expect(denied.status).toBe(404);
  });
});

describe("platform HTTP 数据字典（方案 11.4）", () => {
  it("新增条目、更新口径并留痕；所属资产与指标键不可改", async () => {
    const base = await start(createPlatformHttpServer());
    const created = await post(base, "/api/v1/platform/data-dictionary", { assetCode: "operation_tasks", metricKey: "priority", label: "任务优先级", unit: "", dataType: "string" }, { "x-user-id": "user-admin" });
    expect(created.status).toBe(201);
    const entry = (await created.json() as { data: { id: string; assetCode: string; metricKey: string } }).data;
    expect(entry).toMatchObject({ assetCode: "operation_tasks", metricKey: "priority" });

    const movedAsset = await put(base, `/api/v1/platform/data-dictionary/${entry.id}`, { assetCode: "plot_records" });
    expect(movedAsset.status).toBe(400);
    const movedKey = await put(base, `/api/v1/platform/data-dictionary/${entry.id}`, { metricKey: "otherKey" });
    expect(movedKey.status).toBe(400);

    const updated = await put(base, `/api/v1/platform/data-dictionary/${entry.id}`, { definition: "HIGH/NORMAL/LOW 三档" });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { definition: string } }).data.definition).toBe("HIGH/NORMAL/LOW 三档");

    const audit = await pageOf<{ action: string }>(await fetch(`${base}/api/v1/platform/audit-logs?keyword=dataDictionary`));
    expect(audit.items.map((log) => log.action)).toEqual(expect.arrayContaining(["dataDictionary.create", "dataDictionary.update"]));

    expect((await fetch(`${base}/api/v1/platform/data-dictionary/${entry.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/platform/data-dictionary/${entry.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("同一资产同一指标只留一条口径：重键 409，幽灵资产 404，非法指标键 400", async () => {
    const base = await start(createPlatformHttpServer());
    const duplicated = await post(base, "/api/v1/platform/data-dictionary", { assetCode: "telemetry_readings", metricKey: "soilMoisture", label: "土壤湿度另一口径" });
    expect(duplicated.status).toBe(409);

    const ghost = await post(base, "/api/v1/platform/data-dictionary", { assetCode: "table_not_exist", metricKey: "someKey", label: "幽灵指标" });
    expect(ghost.status).toBe(404);

    const badKey = await post(base, "/api/v1/platform/data-dictionary", { assetCode: "telemetry_readings", metricKey: "1bad-key", label: "非法键" });
    expect(badKey.status).toBe(400);
  });

  it("关键词与资产筛选同口径，跨租户读空", async () => {
    const base = await start(createPlatformHttpServer());
    const keyword = await pageOf<{ metricKey: string }>(await fetch(`${base}/api/v1/platform/data-dictionary?keyword=soilMoisture`));
    expect(keyword.total).toBe(1);
    expect(keyword.items[0]!.metricKey).toBe("soilMoisture");

    const weather = await pageOf(await fetch(`${base}/api/v1/platform/data-dictionary?assetCode=weather_forecasts`));
    expect(weather.total).toBe(5);

    expect((await pageOf(await fetch(`${base}/api/v1/platform/data-dictionary`, { headers: { "x-tenant-id": "tenant-other" } }))).total).toBe(0);
  });
});