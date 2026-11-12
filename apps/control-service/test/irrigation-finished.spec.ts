import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { EventTopic } from "@agri/contracts";
import type { IrrigationFinishedPayload } from "@agri/contracts";
import type { Tx } from "@agri/db";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";

import { waterVolumeOf } from "../src/command-spec.js";
import { InMemoryControlCommandRepository } from "../src/control.repository.js";
import type { ControlCommand, ControlCommandRepository } from "../src/control.repository.js";
import { createControlHttpServer } from "../src/http.js";
import { buildIrrigationFinished, resolveDurationMin, resolveWaterVolume } from "../src/irrigation-finished.js";

/**
 * 灌溉 DONE 回执 → `control.irrigation.finished` 事件。
 *
 * 平台不替设备测量：用水量与时长要么来自设备实测，要么由指令自己的分区参数与时间戳现算，
 * 因此用例断言的是「来源标记 + 与方案同一口径」，不写死任何由几何或时间推导出来的数字。
 */

const MINUTE = 60_000;

function command(overrides: Partial<ControlCommand> = {}): ControlCommand {
  return {
    id: "cmd-irri-1",
    tenantId: "tenant-demo",
    deviceId: "device-irri-001",
    plotCode: "511723-000001-01-00001-0000-5",
    operatorId: "user-admin",
    confirmedAt: "2026-11-12T00:00:00.000Z",
    type: "IRRIGATION",
    parameters: { zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }, { zoneCode: "ZONE-02", areaMu: 6.5, targetMm: 15 }] },
    status: "SENT",
    origin: "MANUAL",
    reason: "土壤含水率低于下限",
    version: 2,
    createdAt: "2026-11-12T00:00:00.000Z",
    sentAt: "2026-11-12T00:01:00.000Z",
    ...overrides,
  };
}

const finishedAt = "2026-11-12T01:01:00.000Z";

describe("灌溉完成事件载荷", () => {
  it("设备实测值优先于任何推算，来源标记为 DEVICE", () => {
    const water = resolveWaterVolume(command(), { waterVolumeM3: 200 });
    expect(water).toEqual({ waterVolume: 200, waterVolumeSource: "DEVICE" });
    expect(resolveDurationMin(command(), finishedAt, { durationMin: 30 })).toEqual({ durationMin: 30, durationSource: "DEVICE" });
  });

  it("设备没报量时按指令分区参数现算方案总量，来源标记为 PLAN", () => {
    const expected = Number((waterVolumeOf(10, 20) + waterVolumeOf(6.5, 15)).toFixed(2));
    expect(resolveWaterVolume(command())).toEqual({ waterVolume: expected, waterVolumeSource: "PLAN" });
  });

  it("阈值自动指令没有分区：宁缺不造，用水量直接缺省", () => {
    // 自动指令只带网格信息，硬凑一个用水量会让下游的用水统计全歪
    expect(resolveWaterVolume(command({ parameters: { gridCount: 12, targetMm: 20 } }))).toBeUndefined();
    expect(resolveWaterVolume(command({ parameters: { zones: [] } }))).toBeUndefined();
    // 历史脏参数（面积缺失）不该把结单带崩，也不该编一个数
    expect(resolveWaterVolume(command({ parameters: { zones: [{ zoneCode: "ZONE-01", targetMm: 20 }] } }))).toBeUndefined();
  });

  it("时长起点取最后一次状态推进时间，没有回执时刻时退到入队时间", () => {
    const acked = command({ status: "ACKED", ackedAt: "2026-11-12T00:40:00.000Z" });
    expect(resolveDurationMin(acked, finishedAt)).toEqual({ durationMin: 21, durationSource: "RUNTIME" });
    // 只有入队时间的历史行：时长是上界，来源仍是 RUNTIME 而不是设备实测
    const queued = command({ status: "QUEUED", sentAt: undefined, createdAt: "2026-11-12T00:21:00.000Z" });
    expect(resolveDurationMin(queued, finishedAt)).toEqual({ durationMin: 40, durationSource: "RUNTIME" });
    // 时间列损坏时不给负数，按 0 处理并标明是推算
    expect(resolveDurationMin(command({ sentAt: "" , createdAt: "not-a-date" }), finishedAt)).toEqual({ durationMin: 0, durationSource: "RUNTIME" });
  });

  it("载荷带指令、地块与设备标识，字段与派生结果一致", () => {
    const payload = buildIrrigationFinished(command(), finishedAt);
    expect(payload).toMatchObject({
      commandId: "cmd-irri-1",
      parcelId: "511723-000001-01-00001-0000-5",
      deviceId: "device-irri-001",
      finishedAt,
      waterVolumeSource: "PLAN",
      durationSource: "RUNTIME",
    });
    expect(payload.waterVolume).toBe(Number((waterVolumeOf(10, 20) + waterVolumeOf(6.5, 15)).toFixed(2)));
    // 无分区也无上报时，载荷干脆不带用水量字段
    const unmeasured = buildIrrigationFinished(command({ parameters: {} }), finishedAt);
    expect("waterVolume" in unmeasured).toBe(false);
    expect("waterVolumeSource" in unmeasured).toBe(false);
  });
});

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

/** 消息表与事务句柄成对装配：内存消息表不真的走事务，给个空句柄即可 */
const fakeTx = { $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0 } as unknown as Tx;

function makeRelay() {
  const store = new InMemoryOutboxStore();
  const publisher = new InMemoryEventPublisher();
  // 默认上下文故意与指令归属不同，用来验证事件跟着行内租户走而不是进程配置
  const outbox = new OutboxService(store, publisher, { tenantId: "tenant-boot", traceId: "boot", producer: "control" });
  return { store, publisher, outbox, withTransaction: async (run: (tx: Tx) => Promise<unknown>) => await run(fakeTx) };
}

async function postReceipt(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/v1/control/device/receipt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("DONE 回执结单时回流灌溉完成事件", () => {
  it("灌溉指令结单：状态与待投递事件同事务写入，用水量按方案现算", async () => {
    const repository = new InMemoryControlCommandRepository([command()]);
    const { store, publisher, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    const response = await postReceipt(base, { commandId: "cmd-irri-1", status: "DONE", at: finishedAt });
    expect(response.status).toBe(200);
    expect((await repository.find("tenant-demo", "cmd-irri-1"))?.status).toBe("DONE");

    const pending = store.all().filter((record) => record.topic === EventTopic.ControlIrrigationFinished);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tenantId: "tenant-demo", producer: "control", traceId: "control-irrigation:cmd-irri-1" });
    const payload = pending[0]?.payload as IrrigationFinishedPayload;
    expect(payload).toMatchObject({ commandId: "cmd-irri-1", parcelId: "511723-000001-01-00001-0000-5", deviceId: "device-irri-001", finishedAt });
    expect(payload.waterVolume).toBe(Number((waterVolumeOf(10, 20) + waterVolumeOf(6.5, 15)).toFixed(2)));

    // 待投递记录可被中继正常捞出并投递，消费方于是拿到同一条事件
    expect(pending[0]?.publishedAt).toBeUndefined();
    expect(await outbox.relayOnce()).toBe(1);
    expect(publisher.published.filter((item) => item.topic === EventTopic.ControlIrrigationFinished)).toHaveLength(1);
    expect(store.all()[0]?.publishedAt).toBeDefined();
  });

  it("重复 DONE 不再推第二条事件", async () => {
    const repository = new InMemoryControlCommandRepository([command({ status: "DONE", finishedAt })]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    expect((await postReceipt(base, { commandId: "cmd-irri-1", status: "DONE", at: finishedAt })).status).toBe(200);
    expect(store.all().filter((record) => record.topic === EventTopic.ControlIrrigationFinished)).toHaveLength(0);
  });

  it("设备上报的实测用水量原样进事件，不被方案值覆盖", async () => {
    const repository = new InMemoryControlCommandRepository([command()]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    await postReceipt(base, { commandId: "cmd-irri-1", status: "DONE", at: finishedAt, result: { waterVolumeM3: 173.4, durationMin: 47 } });
    const payload = store.all()[0]?.payload as IrrigationFinishedPayload;
    expect(payload).toMatchObject({ waterVolume: 173.4, waterVolumeSource: "DEVICE", durationMin: 47, durationSource: "DEVICE" });
  });

  it("施肥与急停的 DONE 不推灌溉完成事件", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-fert", type: "FERTILIZATION" }),
      command({ id: "cmd-estop", type: "ESTOP", parameters: {} }),
    ]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    expect((await postReceipt(base, { commandId: "cmd-fert", status: "DONE", at: finishedAt })).status).toBe(200);
    expect((await repository.find("tenant-demo", "cmd-fert"))?.status).toBe("DONE");
    const estop = await postReceipt(base, { commandId: "cmd-estop", status: "DONE", at: finishedAt, result: { confirmed: true } });
    expect(estop.status).toBe(200);

    expect(store.all()).toHaveLength(0);
  });

  it("ACKED 回执不推事件；没有消息表时结单照常但不假装闭环", async () => {
    const repository = new InMemoryControlCommandRepository([command()]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));
    expect((await postReceipt(base, { commandId: "cmd-irri-1", status: "ACKED", at: finishedAt })).status).toBe(200);
    expect(store.all()).toHaveLength(0);

    const plain = new InMemoryControlCommandRepository([command({ id: "cmd-no-outbox" })]);
    const plainBase = await start(createControlHttpServer(plain));
    expect((await postReceipt(plainBase, { commandId: "cmd-no-outbox", status: "DONE", at: finishedAt })).status).toBe(200);
    expect((await plain.find("tenant-demo", "cmd-no-outbox"))?.status).toBe("DONE");
  });

  it("只给消息表不给事务句柄时拒绝装配：状态改了事件却没落库是最坏情况", () => {
    const { outbox } = makeRelay();
    expect(() => createControlHttpServer(new InMemoryControlCommandRepository(), { outbox })).toThrow("必须配置事务句柄");
  });

  it("跃迁被并发回执抢走时返回 409，且不留下待投递事件", async () => {
    const repository = new InMemoryControlCommandRepository([command()]);
    // 网关与人工回填同时到达：仓储按 version 只认第一次，这里模拟第二次落空
    const racing = {
      find: (tenantId: string, id: string) => repository.find(tenantId, id),
      transition: async () => null,
    } as unknown as ControlCommandRepository;
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(racing, { outbox, withTransaction }));

    const conflict = await postReceipt(base, { commandId: "cmd-irri-1", status: "DONE", at: finishedAt });
    expect(conflict.status).toBe(409);
    expect(store.all()).toHaveLength(0);
    expect((await repository.find("tenant-demo", "cmd-irri-1"))?.status).toBe("SENT");
  });
});
