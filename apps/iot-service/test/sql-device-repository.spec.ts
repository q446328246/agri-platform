import { describe, expect, it } from "vitest";
import type { PrismaClientLike, Tx } from "@agri/db";

import { DEFAULT_TENANT, SqlDeviceRepository } from "../src/device.repository.js";

/**
 * SQL 设备仓储的语句与映射验证：部署走 sql 模式，
 * 列名、筛选片段、租户前缀、接入协议/绑定列和「空串/NULL 不当成真实取值」这些口径只有这里能守住。
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
const OTHER_TENANT = "tenant-beta";

/** 台账行样例：迁移 035 之后每行都带 tenant_id，迁移 038 之后带接入协议与绑定 */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "device-x",
    tenant_id: DEFAULT_TENANT,
    device_no: "DZ-X-1",
    name: "东部墒情站",
    type: "SOIL_SENSOR",
    status: "ONLINE",
    plot_code: EAST_1,
    protocol: "HTTP",
    binding_json: null,
    last_seen_at: "2026-11-09T01:02:03.000Z",
    created_at: "2026-11-01",
    updated_at: "2026-11-02",
    ...overrides,
  };
}

describe("SqlDeviceRepository", () => {
  it("把台账行映射成设备，未绑定地块与未上报都不编造取值", async () => {
    const { client } = makeClient([
      row(),
      row({ id: "device-y", device_no: "DZ-Y-1", name: "首部气象站", type: "WEATHER_STATION", status: "OFFLINE", plot_code: "", last_seen_at: null }),
    ]);
    const list = await new SqlDeviceRepository(client).list(DEFAULT_TENANT);
    expect(list[0]).toMatchObject({ id: "device-x", tenantId: DEFAULT_TENANT, deviceNo: "DZ-X-1", type: "SOIL_SENSOR", status: "ONLINE", plotCode: EAST_1, protocol: "HTTP" });
    expect(list[0]!.lastSeenAt).toBe("2026-11-09T01:02:03.000Z");
    expect(list[1]!.plotCode).toBeUndefined();
    expect(list[1]!.binding).toBeUndefined();
    expect(list[1]!.lastSeenAt).toBeNull();
  });

  it("现场协议设备的绑定从 JSONB 还原，对象与文本两种形状都收", async () => {
    const binding = { host: "10.20.30.40", port: 502, unitId: 3, profile: "WATER_M3", timeoutMs: 2000 };
    const { client, calls } = makeClient([
      row({ id: "device-p", device_no: "DZ-P-9", type: "IRRIGATION_PUMP", protocol: "MODBUS_TCP", binding_json: binding }),
      row({ id: "device-q", device_no: "DZ-Q-9", type: "IRRIGATION_VALVE", protocol: "MODBUS_TCP", binding_json: JSON.stringify(binding) }),
    ]);
    const list = await new SqlDeviceRepository(client).list(DEFAULT_TENANT, { protocol: "MODBUS_TCP" });
    expect(list.map((device) => device.protocol)).toEqual(["MODBUS_TCP", "MODBUS_TCP"]);
    expect(list[0]!.binding).toEqual(binding);
    expect(list[1]!.binding).toEqual(binding);
    // 网关按协议取数，落到 SQL 是等值条件
    expect(calls[0]!.query).toContain("WHERE tenant_id = $1 AND protocol = $2");
    expect(calls[0]!.params).toEqual([DEFAULT_TENANT, "MODBUS_TCP"]);
  });

  it("筛选条件按出现顺序编号占位，租户固定为第一个条件", async () => {
    const { client, calls } = makeClient();
    await new SqlDeviceRepository(client).list(DEFAULT_TENANT, { type: "INSECT_LAMP", status: "OFFLINE", plotCode: EAST_1, keyword: "测报灯" });
    const { query, params } = calls[0]!;
    expect(query).toContain("WHERE tenant_id = $1 AND type = $2 AND status = $3 AND plot_code = $4 AND (name ILIKE $5 OR device_no ILIKE $5)");
    expect(query).toContain("ORDER BY device_no");
    expect(params).toEqual([DEFAULT_TENANT, "INSECT_LAMP", "OFFLINE", EAST_1, "%测报灯%"]);
  });

  it("没有筛选条件也带租户条件，绝不退化成全表台账", async () => {
    const { client, calls } = makeClient();
    await new SqlDeviceRepository(client).list(OTHER_TENANT, {});
    expect(calls[0]!.query).toContain("WHERE tenant_id = $1");
    expect(calls[0]!.query).not.toContain(" AND ");
    expect(calls[0]!.params).toEqual([OTHER_TENANT]);
  });

  it("新增写入台账表，未上报时间落 NULL 而不是当前时刻", async () => {
    const { client, calls } = makeClient();
    const created = await new SqlDeviceRepository(client).create(OTHER_TENANT, { deviceNo: "DZ-N-001", name: "新墒情站", type: "SOIL_SENSOR", status: "OFFLINE", plotCode: EAST_1 });
    const insert = calls.find((call) => call.query.includes("INSERT INTO devices"));
    expect(insert).toBeDefined();
    expect(insert!.query).toContain("last_seen_at, created_at, updated_at");
    expect(insert!.params.slice(0, 7)).toEqual([created.id, OTHER_TENANT, "DZ-N-001", "新墒情站", "SOIL_SENSOR", "OFFLINE", EAST_1]);
    expect(created.id.startsWith("device-")).toBe(true);
    expect(created.tenantId).toBe(OTHER_TENANT);
    expect(created.lastSeenAt).toBeNull();
  });

  it("未绑定地块时以空串入库，避免仓储到处判 NULL", async () => {
    const { client, calls } = makeClient();
    await new SqlDeviceRepository(client).create(DEFAULT_TENANT, { deviceNo: "DZ-N-002", name: "无地块设备", type: "WEATHER_STATION", status: "ONLINE" });
    const insert = calls.find((call) => call.query.includes("INSERT INTO devices"));
    expect(insert!.params[6]).toBe("");
    expect(insert!.params[7]).toBe("HTTP");
    expect(insert!.params[8]).toBeNull();
  });

  it("现场协议建档把绑定序列化成 JSONB，缺省端口与超时由入参给全", async () => {
    const { client, calls } = makeClient();
    const binding = { host: "10.20.30.40", port: 1502, unitId: 3, profile: "WATER_M3", timeoutMs: 3000 };
    const created = await new SqlDeviceRepository(client).create(DEFAULT_TENANT, { deviceNo: "DZ-N-003", name: "联片泵站", type: "IRRIGATION_PUMP", status: "ONLINE", protocol: "MODBUS_TCP", binding });
    const insert = calls.find((call) => call.query.includes("INSERT INTO devices"));
    expect(insert!.query).toContain("protocol, binding_json");
    expect(insert!.query).toContain("$9::jsonb");
    expect(insert!.params[7]).toBe("MODBUS_TCP");
    expect(JSON.parse(String(insert!.params[8]))).toEqual(binding);
    expect(created.protocol).toBe("MODBUS_TCP");
    expect(created.binding).toEqual(binding);
  });

  it("按编号与按 id 查询都限定单条并锁在租户内，供撞号校验使用", async () => {
    const { client, calls } = makeClient([row({ id: "device-a", device_no: "DZ-A-1", name: "甲", plot_code: "" })]);
    const repository = new SqlDeviceRepository(client);
    expect(await repository.findByDeviceNo(DEFAULT_TENANT, "DZ-A-1")).toMatchObject({ deviceNo: "DZ-A-1" });
    expect(await repository.find(DEFAULT_TENANT, "device-a")).toMatchObject({ id: "device-a" });
    expect(calls[0]!.query).toContain("WHERE tenant_id = $1 AND device_no = $2");
    expect(calls[1]!.query).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(calls[0]!.params).toEqual([DEFAULT_TENANT, "DZ-A-1"]);
    expect(calls[1]!.params).toEqual([DEFAULT_TENANT, "device-a"]);
  });

  it("编辑台账按合并后的全量字段更新，未传字段沿用当前行", async () => {
    const calls: Captured[] = [];
    const current = row({ id: "device-a", device_no: "DZ-A-1", name: "甲", last_seen_at: null });
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
        return [{ ...current, name: params[0], type: params[1], status: params[2], plot_code: params[3], protocol: params[4], binding_json: params[5], updated_at: params[6] }] as T;
      },
      async $executeRawUnsafe(query: string, ...params: unknown[]) {
        calls.push({ query, params });
        return 1;
      },
    };

    const updated = await new SqlDeviceRepository(client).update(DEFAULT_TENANT, "device-a", { status: "OFFLINE", plotCode: "" });
    const statement = calls.find((call) => call.query.includes("UPDATE devices"));
    expect(statement).toBeDefined();
    expect(statement!.query).toContain("RETURNING");
    expect(statement!.query).toContain("updated_at = $7::timestamptz");
    expect(statement!.query).toContain("WHERE tenant_id = $8 AND id = $9");
    // 名称与类型没传，参数里仍是当前行的取值；解绑地块写成空串而不是 NULL
    expect(statement!.params.slice(0, 4)).toEqual(["甲", "SOIL_SENSOR", "OFFLINE", ""]);
    // 没传协议与绑定：沿用当前行的 HTTP，绑定为 NULL 与 CHECK 约束同口径
    expect(statement!.params.slice(4, 6)).toEqual(["HTTP", null]);
    expect(statement!.params.slice(7)).toEqual([DEFAULT_TENANT, "device-a"]);
    expect(updated).toMatchObject({ id: "device-a", tenantId: DEFAULT_TENANT, deviceNo: "DZ-A-1", name: "甲", type: "SOIL_SENSOR", status: "OFFLINE", protocol: "HTTP" });
    expect(updated!.plotCode).toBeUndefined();
    expect(updated!.binding).toBeUndefined();
    expect(updated!.updatedAt).toBe(String(statement!.params[6]));
  });

  it("设备不存在时更新返回 null，不发写语句", async () => {
    const { client, calls } = makeClient([]);
    expect(await new SqlDeviceRepository(client).update(DEFAULT_TENANT, "device-missing", { name: "乙" })).toBeNull();
    expect(calls.some((call) => call.query.includes("UPDATE devices"))).toBe(false);
  });

  it("读、写与撞号校验都锁在租户内，没有一条语句能跨租户", async () => {
    const { client, calls } = makeClient([row({ tenant_id: OTHER_TENANT })]);
    const repository = new SqlDeviceRepository(client);
    await repository.list(DEFAULT_TENANT, { type: "SOIL_SENSOR" });
    await repository.find(DEFAULT_TENANT, "device-x");
    await repository.findByDeviceNo(DEFAULT_TENANT, "DZ-X-1");
    await repository.create(DEFAULT_TENANT, { deviceNo: "DZ-N-009", name: "校验租户归属", type: "SOIL_SENSOR", status: "OFFLINE" });
    await repository.update(DEFAULT_TENANT, "device-x", { name: "改名" });
    // create 走 INSERT，租户写在 VALUES 的参数里而不是 WHERE
    const scoped = calls.filter((call) => !call.query.includes("INSERT INTO devices"));
    expect(scoped).toHaveLength(5);
    // 占位符序号从语句里现取：update 的 SET 子句在前，租户不在 $1
    expect(
      scoped.map((call) => {
        const placeholder = /tenant_id = \$(\d+)/.exec(call.query)?.[1];
        return placeholder === undefined ? undefined : call.params[Number(placeholder) - 1];
      }),
    ).toEqual(scoped.map(() => DEFAULT_TENANT));
    expect(calls.find((call) => call.query.includes("INSERT INTO devices"))!.params[1]).toBe(DEFAULT_TENANT);
  });

  it("查不到时返回 null 而不是空对象", async () => {
    const { client } = makeClient();
    const repository = new SqlDeviceRepository(client);
    expect(await repository.find(DEFAULT_TENANT, "device-missing")).toBeNull();
    expect(await repository.findByDeviceNo(DEFAULT_TENANT, "DZ-MISSING")).toBeNull();
  });
});
