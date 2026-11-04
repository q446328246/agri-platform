import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";
import { SqlPlotRepository } from "../src/plot.repository.js";

function makeClient() {
  const queries: string[] = [];
  const rows = [{ parcel_id: "p-1", parcel_code: "511723-000001-01-00001-0000-5", parcel_name: "示范田", tenant_id: "tenant-demo", farm_id: "farm-1", area_mu: 12.5, soil_type: "PADDY_SOIL", geom: { type: "Polygon", coordinates: [], srid: 4490 }, created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null }];
  const client: PrismaClientLike = {
    async $connect() {}, async $disconnect() {},
    async $transaction<R>(handler: (tx: Tx) => Promise<R>) { return handler(client as unknown as Tx); },
    async $queryRawUnsafe<T>(query: string) { queries.push(query); return rows as T; },
    async $executeRawUnsafe(query: string) { queries.push(query); return 1; },
  };
  return { client, queries };
}

describe("SqlPlotRepository", () => {
  it("按租户查询并映射数据库字段", async () => {
    const fake = makeClient();
    const repository = new SqlPlotRepository(fake.client);
    const records = await repository.listByTenant("tenant-demo");
    expect(records[0]).toMatchObject({ parcelId: "p-1", parcelCode: "511723-000001-01-00001-0000-5", areaMu: 12.5 });
    expect(fake.queries[0]).toContain("tenant_id = $1");
  });

  it("在事务客户端上执行插入并保留业务记录", async () => {
    const fake = makeClient();
    const repository = new SqlPlotRepository(fake.client);
    const record = { parcelId: "p-2", parcelCode: "code-2", parcelName: "田块二", tenantId: "tenant-demo", farmId: "farm-1", areaMu: 3, geom: { type: "Polygon" as const, coordinates: [], srid: 4490 }, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    await repository.create(undefined, record);
    expect(fake.queries[0]).toContain("INSERT INTO plot_records");
    expect(await repository.findByCode(undefined, record.parcelCode)).toMatchObject({ parcelCode: "511723-000001-01-00001-0000-5" });
  });
});
