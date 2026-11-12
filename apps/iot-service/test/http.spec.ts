import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createIotHttpServer } from "../src/http.js";
import { DEFAULT_TENANT, InMemoryDeviceRepository, demoDevices } from "../src/device.repository.js";

/**
 * 设备台账接口验证：列表筛选与分页、新增设备的校验与编号在租户内唯一、
 * 租户之间互不可见、控制指令只接受本租户在册设备。
 * 默认用内存仓储，落库口径见 sql-device-repository.spec.ts。
 */

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

async function jsonOf(response: Response): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return response.json();
}

describe("iot HTTP API", () => {
  it("健康检查与台账列表返回统一响应，演示设备在册", async () => {
    const base = await start(createIotHttpServer());
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await jsonOf(health)).toMatchObject({ code: "OK", data: { service: "iot" } });

    const list = await fetch(`${base}/api/v1/devices`);
    const page = await jsonOf(list);
    expect(list.status).toBe(200);
    expect(page.data.total).toBe(demoDevices().length);
    expect(page.data.items.map((item: { deviceNo: string }) => item.deviceNo)).toContain("DZ-W-001");
  });

  it("关键词、类型、状态与地块筛选真实生效", async () => {
    const base = await start(createIotHttpServer());

    const keyword = await jsonOf(await fetch(`${base}/api/v1/devices?keyword=墒情`));
    expect(keyword.data.items.map((item: { deviceNo: string }) => item.deviceNo).sort()).toEqual(["DZ-S-003", "DZ-S-004"]);

    const byNo = await jsonOf(await fetch(`${base}/api/v1/devices?keyword=dz-v-00`));
    expect(byNo.data.total).toBe(2);

    const typed = await jsonOf(await fetch(`${base}/api/v1/devices?type=INSECT_LAMP`));
    expect(typed.data.total).toBe(2);

    const offline = await jsonOf(await fetch(`${base}/api/v1/devices?status=OFFLINE`));
    expect(offline.data.items.every((item: { status: string }) => item.status === "OFFLINE")).toBe(true);

    const onPlot = await jsonOf(await fetch(`${base}/api/v1/devices?plotCode=511723-000001-01-00001-0000-5`));
    expect(onPlot.data.total).toBe(2);

    const nothing = await jsonOf(await fetch(`${base}/api/v1/devices?keyword=不存在的设备`));
    expect(nothing.data).toMatchObject({ items: [], total: 0, pages: 0 });
  });

  it("分页字段真实生效，越界页返回空列表但不算错", async () => {
    const base = await start(createIotHttpServer());
    const first = await jsonOf(await fetch(`${base}/api/v1/devices?page=1&size=5`));
    expect(first.data).toMatchObject({ page: 1, size: 5, total: 12, pages: 3 });
    expect(first.data.items).toHaveLength(5);

    const last = await jsonOf(await fetch(`${base}/api/v1/devices?page=3&size=5`));
    expect(last.data.items).toHaveLength(2);

    const beyond = await jsonOf(await fetch(`${base}/api/v1/devices?page=9&size=5`));
    expect(beyond.data.items).toHaveLength(0);
    expect(beyond.data.total).toBe(12);
  });

  it("新增设备后列表与详情都能查到，且未上报时不伪造最后上报时间", async () => {
    const base = await start(createIotHttpServer());
    const created = await fetch(`${base}/api/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceNo: "DZ-X-100", name: "新区墒情站 X100", type: "SOIL_SENSOR", plotCode: "511723-000001-01-00001-0000-5" }),
    });
    expect(created.status).toBe(201);
    const device = await jsonOf(created);
    expect(device.code).toBe("OK");
    expect(device.data).toMatchObject({ deviceNo: "DZ-X-100", name: "新区墒情站 X100", type: "SOIL_SENSOR", status: "OFFLINE", plotCode: "511723-000001-01-00001-0000-5" });
    expect(device.data.lastSeenAt).toBeNull();

    const list = await jsonOf(await fetch(`${base}/api/v1/devices?keyword=X100`));
    expect(list.data.total).toBe(1);

    const detail = await jsonOf(await fetch(`${base}/api/v1/devices/${device.data.id}`));
    expect(detail.data.deviceNo).toBe("DZ-X-100");
  });

  it("必填缺失、类型非法与编号重复都会被拒绝", async () => {
    const base = await start(createIotHttpServer());
    const post = (body: unknown) => fetch(`${base}/api/v1/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const noName = await post({ deviceNo: "DZ-X-101", type: "SOIL_SENSOR" });
    expect(noName.status).toBe(400);
    expect((await jsonOf(noName)).message).toContain("名称");

    const noNumber = await post({ name: "缺编号", type: "SOIL_SENSOR" });
    expect(noNumber.status).toBe(400);

    const badType = await post({ deviceNo: "DZ-X-102", name: "非法类型", type: "TIME_MACHINE" });
    expect(badType.status).toBe(400);
    expect((await jsonOf(badType)).message).toContain("SOIL_SENSOR");

    const badStatus = await post({ deviceNo: "DZ-X-103", name: "非法状态", type: "SOIL_SENSOR", status: "SLEEPING" });
    expect(badStatus.status).toBe(400);

    const duplicated = await post({ deviceNo: "DZ-W-001", name: "撞号设备", type: "WEATHER_STATION" });
    expect(duplicated.status).toBe(409);
    expect((await jsonOf(duplicated)).message).toContain("DZ-W-001");

    const total = await jsonOf(await fetch(`${base}/api/v1/devices?size=200`));
    expect(total.data.total).toBe(demoDevices().length);
  });

  it("编辑台账只改传入字段，编号与最后上报时间保持不变", async () => {
    const base = await start(createIotHttpServer());
    const before = await jsonOf(await fetch(`${base}/api/v1/devices/device-soil-003`));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const put = (body: unknown) => fetch(`${base}/api/v1/devices/device-soil-003`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const renamed = await put({ name: "东区一号田墒情站（改造）", plotCode: "511723-000001-01-00002-0000-Z" });
    expect(renamed.status).toBe(200);
    const device = await jsonOf(renamed);
    expect(device.data).toMatchObject({
      deviceNo: "DZ-S-003",
      name: "东区一号田墒情站（改造）",
      type: "SOIL_SENSOR",
      status: "ONLINE",
      plotCode: "511723-000001-01-00002-0000-Z",
    });
    // 配置编辑不碰上报侧写入的字段，避免手工把没上报过的设备说成在线过
    expect(device.data.lastSeenAt).toBe(before.data.lastSeenAt);
    expect(device.data.createdAt).toBe(before.data.createdAt);
    expect(device.data.updatedAt).not.toBe(before.data.updatedAt);

    const onlyStatus = await jsonOf(await put({ status: "OFFLINE" }));
    expect(onlyStatus.data).toMatchObject({ name: "东区一号田墒情站（改造）", status: "OFFLINE", plotCode: "511723-000001-01-00002-0000-Z" });

    const unbound = await jsonOf(await put({ plotCode: "" }));
    expect(unbound.data.plotCode).toBeUndefined();

    const listed = await jsonOf(await fetch(`${base}/api/v1/devices?plotCode=511723-000001-01-00001-0000-5`));
    expect(listed.data.items.map((item: { deviceNo: string }) => item.deviceNo)).toEqual(["DZ-V-001"]);
    expect(listed.data.total).toBe(1);
  });

  it("非法类型、空名称、空请求体与不存在的设备都不会改动台账", async () => {
    const base = await start(createIotHttpServer());
    const put = (id: string, body: unknown) => fetch(`${base}/api/v1/devices/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const missing = await put("device-not-exist", { name: "改名" });
    expect(missing.status).toBe(404);

    const badType = await put("device-soil-003", { type: "TIME_MACHINE" });
    expect(badType.status).toBe(400);
    expect((await jsonOf(badType)).message).toContain("SOIL_SENSOR");

    const badStatus = await put("device-soil-003", { status: "SLEEPING" });
    expect(badStatus.status).toBe(400);

    const blankName = await put("device-soil-003", { name: "   " });
    expect(blankName.status).toBe(400);
    expect((await jsonOf(blankName)).message).toContain("名称");

    const empty = await put("device-soil-003", {});
    expect(empty.status).toBe(400);

    const untouched = await jsonOf(await fetch(`${base}/api/v1/devices/device-soil-003`));
    expect(untouched.data.name).toBe("东区一号田墒情站 S03");
  });

  it("控制指令只接受在册设备", async () => {
    const base = await start(createIotHttpServer());
    const command = JSON.stringify({ type: "CONFIGURE", parameters: {} });

    const missing = await fetch(`${base}/api/v1/devices/device-not-exist/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: command });
    expect(missing.status).toBe(404);

    const queued = await fetch(`${base}/api/v1/devices/device-soil-003/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: command });
    expect(queued.status).toBe(202);
    expect(await jsonOf(queued)).toMatchObject({ data: { deviceId: "device-soil-003", status: "QUEUED" } });
  });

  it("注入仓储时新增设备对同一仓储可见", async () => {
    const repository = new InMemoryDeviceRepository();
    const base = await start(createIotHttpServer({ devices: repository }));
    await fetch(`${base}/api/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceNo: "DZ-X-200", name: "仓储可见性校验", type: "IRRIGATION_PUMP" }),
    });
    expect(await repository.findByDeviceNo(DEFAULT_TENANT, "DZ-X-200")).toMatchObject({ name: "仓储可见性校验" });
  });

  it("台账按租户隔离：别家看不到设备，同型号编号也不撞", async () => {
    const base = await start(createIotHttpServer());
    const beta = { "x-tenant-id": "tenant-beta" };
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/v1/devices`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    // 演示租户的 12 台设备对 tenant-beta 不可见
    expect((await jsonOf(await fetch(`${base}/api/v1/devices`, { headers: beta }))).data).toMatchObject({ items: [], total: 0, pages: 0 });
    expect((await fetch(`${base}/api/v1/devices/device-soil-003`, { headers: beta })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/devices/device-soil-003/commands`, { method: "POST", headers: { "content-type": "application/json", ...beta }, body: JSON.stringify({ type: "CONFIGURE", parameters: {} }) })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/devices/device-soil-003`, { method: "PUT", headers: { "content-type": "application/json", ...beta }, body: JSON.stringify({ name: "越租户改名" }) })).status).toBe(404);

    // 出厂编号只在租户内唯一：beta 登记同型号设备不该撞演示租户的 DZ-W-001
    const sameNo = await post({ deviceNo: "DZ-W-001", name: "beta 气象站", type: "WEATHER_STATION" }, beta);
    expect(sameNo.status).toBe(201);
    const created = await jsonOf(sameNo);
    expect(created.data).toMatchObject({ deviceNo: "DZ-W-001", name: "beta 气象站" });
    expect((await post({ deviceNo: "DZ-W-001", name: "beta 撞号", type: "WEATHER_STATION" }, beta)).status).toBe(409);

    // 各看各的：演示租户仍是 12 台，beta 只有刚登记的一台
    expect((await jsonOf(await fetch(`${base}/api/v1/devices?size=200`))).data.total).toBe(demoDevices().length);
    const betaList = await jsonOf(await fetch(`${base}/api/v1/devices?size=200`, { headers: beta }));
    expect(betaList.data.items.map((item: { id: string }) => item.id)).toEqual([created.data.id]);

    const renamed = await fetch(`${base}/api/v1/devices/${created.data.id}`, { method: "PUT", headers: { "content-type": "application/json", ...beta }, body: JSON.stringify({ status: "ONLINE" }) });
    expect((await jsonOf(renamed)).data).toMatchObject({ id: created.data.id, status: "ONLINE" });
    expect((await fetch(`${base}/api/v1/devices/${created.data.id}`)).status).toBe(404);
  });
});

/**
 * 现场接入协议（迁移 038）：台账要能记住「网关怎么连这台设备」。
 * 校验口径全在 device-binding.ts，这里验的是接口把这些规则真实落住，且拒掉的请求不留半行台账。
 */
describe("设备现场接入绑定", () => {
  it("Modbus 建档缺省项按规范补齐，协议筛选只取现场设备", async () => {
    const base = await start(createIotHttpServer());
    const post = (body: unknown) => fetch(`${base}/api/v1/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await jsonOf(await post({
      deviceNo: "DZ-P-100",
      name: "联片灌溉泵站 P100",
      type: "IRRIGATION_PUMP",
      protocol: "MODBUS_TCP",
      binding: { host: "10.20.30.41", profile: "WATER_M3" },
    }));
    expect(created.data.protocol).toBe("MODBUS_TCP");
    // 端口/单元标识/超时都是可以从规范与剖面缺省推出的值，不该让人反复抄
    expect(created.data.binding).toEqual({ host: "10.20.30.41", port: 502, unitId: 1, profile: "WATER_M3", timeoutMs: 2000 });

    // 演示台账 12 台全是回调式，加上新建的这一台现场设备
    const field = await jsonOf(await fetch(`${base}/api/v1/devices?protocol=MODBUS_TCP&size=200`));
    expect(field.data.items.map((item: { deviceNo: string }) => item.deviceNo)).toEqual(["DZ-P-100"]);
    const callback = await jsonOf(await fetch(`${base}/api/v1/devices?protocol=HTTP&size=200`));
    expect(callback.data.total).toBe(demoDevices().length);
  });

  it("协议与绑定不配套、剖面未知或与类型不符都会被拒，台账不留半行", async () => {
    const base = await start(createIotHttpServer());
    const post = (body: unknown) => fetch(`${base}/api/v1/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const unknownProtocol = await post({ deviceNo: "DZ-X-110", name: "非法协议", type: "SOIL_SENSOR", protocol: "MODBUS_RTU" });
    expect(unknownProtocol.status).toBe(400);
    expect((await jsonOf(unknownProtocol)).message).toContain("MODBUS_TCP");

    const noBinding = await post({ deviceNo: "DZ-X-111", name: "缺绑定", type: "IRRIGATION_PUMP", protocol: "MODBUS_TCP" });
    expect(noBinding.status).toBe(400);
    expect((await jsonOf(noBinding)).message).toContain("绑定");

    const httpWithBinding = await post({ deviceNo: "DZ-X-112", name: "回调式带绑定", type: "SOIL_SENSOR", binding: { host: "10.0.0.1", profile: "SWITCH_ONLY" } });
    expect(httpWithBinding.status).toBe(400);
    expect((await jsonOf(httpWithBinding)).message).toContain("HTTP");

    const unknownProfile = await post({ deviceNo: "DZ-X-113", name: "未知剖面", type: "IRRIGATION_PUMP", protocol: "MODBUS_TCP", binding: { host: "10.0.0.1", profile: "TURBO_9000" } });
    expect(unknownProfile.status).toBe(400);
    expect((await jsonOf(unknownProfile)).message).toContain("WATER_M3");

    // 给墒情站配启停剖面等于对着表计下令，类型与剖面必须对得上
    const mismatched = await post({ deviceNo: "DZ-X-114", name: "类型不符", type: "SOIL_SENSOR", protocol: "MODBUS_TCP", binding: { host: "10.0.0.1", profile: "WATER_M3" } });
    expect(mismatched.status).toBe(400);
    expect((await jsonOf(mismatched)).message).toContain("SOIL_SENSOR");

    const badUnit = await post({ deviceNo: "DZ-X-115", name: "单元标识越界", type: "IRRIGATION_VALVE", protocol: "MODBUS_TCP", binding: { host: "10.0.0.1", unitId: 300, profile: "WATER_M3" } });
    expect(badUnit.status).toBe(400);

    const blankHost = await post({ deviceNo: "DZ-X-116", name: "空地址", type: "IRRIGATION_VALVE", protocol: "MODBUS_TCP", binding: { host: "  ", profile: "WATER_M3" } });
    expect(blankHost.status).toBe(400);

    const listed = await jsonOf(await fetch(`${base}/api/v1/devices?size=200`));
    expect(listed.data.total).toBe(demoDevices().length);
  });

  it("改协议必须同时给出配套绑定，改回回调式时绑定清空", async () => {
    const base = await start(createIotHttpServer());
    const put = (id: string, body: unknown) => fetch(`${base}/api/v1/devices/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const switched = await jsonOf(await put("device-pump-001", { protocol: "MODBUS_TCP", binding: { host: "10.20.30.42", port: 1502, unitId: 4, profile: "WATER_M3", timeoutMs: 5000 } }));
    expect(switched.data).toMatchObject({ deviceNo: "DZ-P-001", protocol: "MODBUS_TCP" });
    expect(switched.data.binding).toEqual({ host: "10.20.30.42", port: 1502, unitId: 4, profile: "WATER_M3", timeoutMs: 5000 });

    // 只改名称不动协议：绑定原样留着，不会因为编辑把现场接入抹掉
    const renamed = await jsonOf(await put("device-pump-001", { name: "联片灌溉泵站（已接总线）" }));
    expect(renamed.data.binding).toEqual(switched.data.binding);
    expect(renamed.data.protocol).toBe("MODBUS_TCP");

    // 在册绑定不改协议时也不必填一遍
    const bindingOnly = await jsonOf(await put("device-pump-001", { binding: { host: "10.20.30.99", profile: "WATER_M3" } }));
    expect(bindingOnly.data.binding.host).toBe("10.20.30.99");

    const bareSwitch = await put("device-pump-001", { protocol: "HTTP" });
    expect(bareSwitch.status).toBe(200);
    const backToCallback = await jsonOf(bareSwitch);
    expect(backToCallback.data.protocol).toBe("HTTP");
    expect(backToCallback.data.binding).toBeUndefined();

    const stillModbus = await jsonOf(await put("device-station-002", { protocol: "MODBUS_TCP" }));
    expect(stillModbus.message).toContain("绑定");
    // 被拒的这次不改协议
    expect((await jsonOf(await fetch(`${base}/api/v1/devices/device-station-002`))).data.protocol).toBe("HTTP");
  });
});
