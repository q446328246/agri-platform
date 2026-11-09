import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";

import { SqlDeviceRepository } from "../src/device.repository.js";

/**
 * SQL 设备仓储的语句与映射验证：部署走 sql 模式，
 * 列名、筛选片段和「空串/NULL 不当成真实取值」这些口径只有这里能守住。
 */

interface Captured {
  query: string;
  params: unknown[];
}

function makeClient(rows: Record<string, unknown>[] = []) {
  const calls: Captured[] = [];
  const client: PrismaClientLike = {
    async $connect() {},
    async $disconnect() {},
    async $transaction<R>(handler: (tx: Tx) => Promise<R>) {
      return handler(client as unknown as Tx);
    },
    async $queryRawUnsafe<T>(query: string, ...params: unknown[]) {
      calls.push({ query, params });
      return rows as T;
    },
    async $executeRawUnsafe(query: string, ...params: unknown[]) {
      calls.push({ query, params });
      return 1;
    },
  };
  return { client, calls };
}

const EAST_1 = "511723-000001-01-00001-0000-5";

describe("SqlDeviceRepository", () => {
  it("把台账行映射成设备，未绑定地块与未上报都不编造取值", async () => {
    const { client } = makeClient([
      { id: "device-x", device_no: "DZ-X-1", name: "东部墒情站", type: "SOIL_SENSOR", status: "ONLINE", plot_code: EAST_1, last_seen_at: "2026-11-09T01:02:03.000Z", created_at: "2026-11-01", updated_at: "2026-11-02" },
      { id: "device-y", device_no: "DZ-Y-1", name: "首部气象站", type: "WEATHER_STATION", status: "OFFLINE", plot_code: "", last_seen_at: null, created_at: "2026-11-01", updated_at: "2026-11-01" },
    ]);
    const list = await new SqlDeviceRepository(client).list();
    expect(list[0]).toMatchObject({ id: "device-x", deviceNo: "DZ-X-1", type: "SOIL_SENSOR", status: "ONLINE", plotCode: EAST_1 });
    expect(list[0]!.lastSeenAt).toBe("2026-11-09T01:02:03.000Z");
    expect(list[1]!.plotCode).toBeUndefined();
    expect(list[1]!.lastSeenAt).toBeNull();
  });

  it("筛选条件按出现顺序编号占位，值全部走参数绑定", async () => {
    const { client, calls } = makeClient();
    await new SqlDeviceRepository(client).list({ type: "INSECT_LAMP", status: "OFFLINE", plotCode: EAST_1, keyword: "测报灯" });
    const { query, params } = calls[0]!;
    expect(query).toContain("WHERE type = $1 AND status = $2 AND plot_code = $3 AND (name ILIKE $4 OR device_no ILIKE $4)");
    expect(query).toContain("ORDER BY device_no");
    expect(params).toEqual(["INSECT_LAMP", "OFFLINE", EAST_1, "%测报灯%"]);
  });

  it("无筛选条件时不拼空 WHERE", async () => {
    const { client, calls } = makeClient();
    await new SqlDeviceRepository(client).list({});
    expect(calls[0]!.query).not.toContain("WHERE");
    expect(calls[0]!.params).toEqual([]);
  });

  it("新增写入台账表，未上报时间落 NULL 而不是当前时刻", async () => {
    const { client, calls } = makeClient();
    const created = await new SqlDeviceRepository(client).create({ deviceNo: "DZ-N-001", name: "新墒情站", type: "SOIL_SENSOR", status: "OFFLINE", plotCode: EAST_1 });
    const insert = calls.find((call) => call.query.includes("INSERT INTO devices"));
    expect(insert).toBeDefined();
    expect(insert!.query).toContain("last_seen_at, created_at, updated_at");
    expect(insert!.params.slice(0, 6)).toEqual([created.id, "DZ-N-001", "新墒情站", "SOIL_SENSOR", "OFFLINE", EAST_1]);
    expect(created.id.startsWith("device-")).toBe(true);
    expect(created.lastSeenAt).toBeNull();
  });

  it("未绑定地块时以空串入库，避免仓储到处判 NULL", async () => {
    const { client, calls } = makeClient();
    await new SqlDeviceRepository(client).create({ deviceNo: "DZ-N-002", name: "无地块设备", type: "WEATHER_STATION", status: "ONLINE" });
    const insert = calls.find((call) => call.query.includes("INSERT INTO devices"));
    expect(insert!.params[5]).toBe("");
  });

  it("按编号与按 id 查询都限定单条，供撞号校验使用", async () => {
    const { client, calls } = makeClient([{ id: "device-a", device_no: "DZ-A-1", name: "甲", type: "SOIL_SENSOR", status: "ONLINE", plot_code: "", last_seen_at: null, created_at: "2026-11-01", updated_at: "2026-11-01" }]);
    const repository = new SqlDeviceRepository(client);
    expect(await repository.findByDeviceNo("DZ-A-1")).toMatchObject({ deviceNo: "DZ-A-1" });
    expect(await repository.find("device-a")).toMatchObject({ id: "device-a" });
    expect(calls[0]!.query).toContain("device_no = $1");
    expect(calls[1]!.query).toContain("id = $1");
  });

  it("编辑台账按合并后的全量字段更新，未传字段沿用当前行", async () => {
    const calls: Captured[] = [];
    const current: Record<string, unknown> = { id: "device-a", device_no: "DZ-A-1", name: "甲", type: "SOIL_SENSOR", status: "ONLINE", plot_code: EAST_1, last_seen_at: null, created_at: "2026-11-01", updated_at: "2026-11-01" };
    // 假客户端按语句区分：SELECT 给当前行，UPDATE...RETURNING 给写回后的行，这样能同时校验合并入参与返回映射
    const client: PrismaClientLike = {
      async $connect() {},
      async $disconnect() {},
      async $transaction<R>(handler: (tx: Tx) => Promise<R>) {
        return handler(client as unknown as Tx);
      },
      async $queryRawUnsafe<T>(query: string, ...params: unknown[]) {
        calls.push({ query, params });
        if (!query.includes("UPDATE")) return [current] as T;
        return [{ ...current, name: params[0], type: params[1], status: params[2], plot_code: params[3], updated_at: params[4] }] as T;
      },
      async $executeRawUnsafe(query: string, ...params: unknown[]) {
        calls.push({ query, params });
        return 1;
      },
    };

    const updated = await new SqlDeviceRepository(client).update("device-a", { status: "OFFLINE", plotCode: "" });
    const statement = calls.find((call) => call.query.includes("UPDATE devices"));
    expect(statement).toBeDefined();
    expect(statement!.query).toContain("RETURNING");
    expect(statement!.query).toContain("updated_at = $5::timestamptz");
    // 名称与类型没传，参数里仍是当前行的取值；解绑地块写成空串而不是 NULL
    expect(statement!.params.slice(0, 4)).toEqual(["甲", "SOIL_SENSOR", "OFFLINE", ""]);
    expect(statement!.params[5]).toBe("device-a");
    expect(updated).toMatchObject({ id: "device-a", deviceNo: "DZ-A-1", name: "甲", type: "SOIL_SENSOR", status: "OFFLINE" });
    expect(updated!.plotCode).toBeUndefined();
    expect(updated!.updatedAt).toBe(String(statement!.params[4]));
  });

  it("设备不存在时更新返回 null，不发写语句", async () => {
    const { client, calls } = makeClient([]);
    expect(await new SqlDeviceRepository(client).update("device-missing", { name: "乙" })).toBeNull();
    expect(calls.some((call) => call.query.includes("UPDATE devices"))).toBe(false);
  });

  it("查不到时返回 null 而不是空对象", async () => {
    const { client } = makeClient();
    const repository = new SqlDeviceRepository(client);
    expect(await repository.find("device-missing")).toBeNull();
    expect(await repository.findByDeviceNo("DZ-MISSING")).toBeNull();
  });
});
