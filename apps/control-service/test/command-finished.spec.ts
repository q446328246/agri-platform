import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { EventTopic } from "@agri/contracts";
import type { FertilizationFinishedPayload, IrrigationFinishedPayload } from "@agri/contracts";
import type { Tx } from "@agri/db";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";

import { buildIrrigationPlan, waterVolumeOf } from "../src/command-spec.js";
import { buildFinishedEvent, resolveDurationMin, resolveFertilizerKg, resolveWaterVolume } from "../src/command-finished.js";
import { InMemoryControlCommandRepository } from "../src/control.repository.js";
import type { ControlCommand, ControlCommandRepository } from "../src/control.repository.js";
import { createControlHttpServer } from "../src/http.js";

/**
 * DONE 回执 → `control.*.finished` 事件。
 *
 * 平台不替设备测量：用水量、投肥量与时长要么来自设备实测，要么由指令自己的分区参数与时间戳现算，
 * 因此用例断言的是「来源标记 + 与方案同一口径」，不写死任何由几何或时间推导出来的数字。
 */

/** 分区参数与配比：施肥总量由这两组数字现算，用例里不预先算好写死 */
const ZONES = [
  { zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 },
  { zoneCode: "ZONE-02", areaMu: 6.5, targetMm: 15 },
];
const RECIPE = { nitrogen: 8, phosphorus: 4, potassium: 3 };

function command(overrides: Partial<ControlCommand> = {}): ControlCommand {
  return {
    id: "cmd-irri-1",
    tenantId: "tenant-demo",
    deviceId: "device-irri-001",
    plotCode: "511723-000001-01-00001-0000-5",
    operatorId: "user-admin",
    confirmedAt: "2026-11-12T00:00:00.000Z",
    type: "IRRIGATION",
    parameters: { zones: ZONES },
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

describe("结单事件载荷", () => {
  it("设备实测值优先于任何推算，来源标记为 DEVICE", () => {
    const water = resolveWaterVolume(command(), { waterVolumeM3: 200 });
    expect(water).toEqual({ waterVolume: 200, waterVolumeSource: "DEVICE" });
    expect(resolveFertilizerKg(command({ type: "FERTILIZATION" }), { fertilizerKg: 145 })).toEqual({
      fertilizerKg: 145,
      fertilizerSource: "DEVICE",
    });
    expect(resolveDurationMin(command(), finishedAt, { durationMin: 30 })).toEqual({ durationMin: 30, durationSource: "DEVICE" });
  });

  it("设备没报量时按指令分区参数现算方案总量，来源标记为 PLAN", () => {
    const expected = Number((waterVolumeOf(10, 20) + waterVolumeOf(6.5, 15)).toFixed(2));
    expect(resolveWaterVolume(command())).toEqual({ waterVolume: expected, waterVolumeSource: "PLAN" });
    // 投肥总量与预演方案同一口径：配方千克/亩 × 分区面积合计
    expect(resolveFertilizerKg(command({ type: "FERTILIZATION", parameters: { zones: ZONES, recipe: RECIPE } }))).toEqual({
      fertilizerKg: buildIrrigationPlan({ zones: ZONES, recipe: RECIPE }).recipe?.totalKg,
      fertilizerSource: "PLAN",
    });
  });

  it("阈值自动指令没有分区：宁缺不造，用水量与投肥量直接缺省", () => {
    // 自动指令只带网格信息，硬凑一个用水量会让下游的用水统计全歪
    expect(resolveWaterVolume(command({ parameters: { gridCount: 12, targetMm: 20 } }))).toBeUndefined();
    expect(resolveWaterVolume(command({ parameters: { zones: [] } }))).toBeUndefined();
    // 处方自动指令带的是亩均用量，没有面积就乘不出总投肥量
    expect(resolveFertilizerKg(command({ type: "FERTILIZATION", parameters: { materialCode: "UREA", dosage: 8 } }))).toBeUndefined();
    expect(resolveFertilizerKg(command({ type: "FERTILIZATION", parameters: { zones: ZONES } }))).toBeUndefined();
    // 历史脏参数（面积缺失、配比越界）不该把结单带崩，也不该编一个数
    expect(resolveWaterVolume(command({ parameters: { zones: [{ zoneCode: "ZONE-01", targetMm: 20 }] } }))).toBeUndefined();
    expect(resolveFertilizerKg(command({ type: "FERTILIZATION", parameters: { zones: ZONES, recipe: { nitrogen: -1 } } }))).toBeUndefined();
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

  it("灌溉指令组装灌溉主题与载荷，字段与派生结果一致", () => {
    const finished = buildFinishedEvent(command(), finishedAt);
    expect(finished?.topic).toBe(EventTopic.ControlIrrigationFinished);
    const payload = finished?.payload as IrrigationFinishedPayload;
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
    const unmeasured = buildFinishedEvent(command({ parameters: {} }), finishedAt)?.payload as IrrigationFinishedPayload;
    expect("waterVolume" in unmeasured).toBe(false);
    expect("waterVolumeSource" in unmeasured).toBe(false);
  });

  it("施肥指令组装施肥主题与载荷，不带用水量字段", () => {
    const fertilizer = command({ id: "cmd-fert-1", type: "FERTILIZATION", parameters: { zones: ZONES, recipe: RECIPE } });
    const finished = buildFinishedEvent(fertilizer, finishedAt);
    expect(finished?.topic).toBe(EventTopic.ControlFertilizationFinished);
    const payload = finished?.payload as FertilizationFinishedPayload;
    expect(payload).toMatchObject({
      commandId: "cmd-fert-1",
      parcelId: "511723-000001-01-00001-0000-5",
      deviceId: "device-irri-001",
      finishedAt,
      fertilizerSource: "PLAN",
      durationSource: "RUNTIME",
    });
    expect(payload.fertilizerKg).toBe(buildIrrigationPlan({ zones: ZONES, recipe: RECIPE }).recipe?.totalKg);
    // 施肥载荷口径是肥料千克数，绝不带用水量，免得下游把两本账加成一本
    expect("waterVolume" in payload).toBe(false);
    // 既没配方也没面积：载荷干脆不带投肥量字段，而不是填一个 0
    const unfurnished = buildFinishedEvent(command({ type: "FERTILIZATION", parameters: {} }), finishedAt)?.payload as FertilizationFinishedPayload;
    expect("fertilizerKg" in unfurnished).toBe(false);
    expect("fertilizerSource" in unfurnished).toBe(false);
  });

  it("播种、除草、急停没有可核对的作业量，不组结单事件", () => {
    expect(buildFinishedEvent(command({ type: "SEEDING" }), finishedAt)).toBeUndefined();
    expect(buildFinishedEvent(command({ type: "WEEDING" }), finishedAt)).toBeUndefined();
    expect(buildFinishedEvent(command({ type: "ESTOP", parameters: {} }), finishedAt)).toBeUndefined();
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

describe("DONE 回执结单时回流作业完成事件", () => {
  it("灌溉指令结单：状态与待投递事件同事务写入，用水量按方案现算", async () => {
    const repository = new InMemoryControlCommandRepository([command()]);
    const { store, publisher, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    const response = await postReceipt(base, { commandId: "cmd-irri-1", status: "DONE", at: finishedAt });
    expect(response.status).toBe(200);
    expect((await repository.find("tenant-demo", "cmd-irri-1"))?.status).toBe("DONE");

    const pending = store.all().filter((record) => record.topic === EventTopic.ControlIrrigationFinished);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tenantId: "tenant-demo", producer: "control", traceId: "control-finished:cmd-irri-1" });
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

  it("施肥指令结单：推施肥主题事件，用水主题一条也不留", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-fert-1", type: "FERTILIZATION", parameters: { zones: ZONES, recipe: RECIPE } }),
    ]);
    const { store, publisher, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    expect((await postReceipt(base, { commandId: "cmd-fert-1", status: "DONE", at: finishedAt })).status).toBe(200);
    expect(store.all().filter((record) => record.topic === EventTopic.ControlIrrigationFinished)).toHaveLength(0);
    const pending = store.all().filter((record) => record.topic === EventTopic.ControlFertilizationFinished);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tenantId: "tenant-demo", producer: "control", traceId: "control-finished:cmd-fert-1" });
    const payload = pending[0]?.payload as FertilizationFinishedPayload;
    expect(payload.fertilizerKg).toBe(buildIrrigationPlan({ zones: ZONES, recipe: RECIPE }).recipe?.totalKg);
    expect(payload.fertilizerSource).toBe("PLAN");
    expect(await outbox.relayOnce()).toBe(1);
    expect(publisher.published.filter((item) => item.topic === EventTopic.ControlFertilizationFinished)).toHaveLength(1);
  });

  it("设备实测的投肥量原样进事件，不被配方推算值覆盖", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-fert-1", type: "FERTILIZATION", parameters: { zones: ZONES, recipe: RECIPE } }),
    ]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    await postReceipt(base, { commandId: "cmd-fert-1", status: "DONE", at: finishedAt, result: { fertilizerKg: 128.5 } });
    const payload = store.all()[0]?.payload as FertilizationFinishedPayload;
    expect(payload).toMatchObject({ fertilizerKg: 128.5, fertilizerSource: "DEVICE" });
  });

  it("处方自动施肥指令没有分区与配比：结单照发事件，投肥量留空但带出处方标识", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-fert-auto", type: "FERTILIZATION", origin: "EVENT", parameters: { source: "prescription", prescriptionId: "rx-auto-1", materialCode: "UREA", dosage: 8 } }),
    ]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    expect((await postReceipt(base, { commandId: "cmd-fert-auto", status: "DONE", at: finishedAt })).status).toBe(200);
    const payload = store.all()[0]?.payload as FertilizationFinishedPayload;
    expect(payload).toMatchObject({ commandId: "cmd-fert-auto", durationSource: "RUNTIME", prescriptionId: "rx-auto-1" });
    expect("fertilizerKg" in payload).toBe(false);
  });

  it("人工指令没有处方标识：载荷不带该字段，决策侧据此跳过回流", async () => {
    const repository = new InMemoryControlCommandRepository([command({ id: "cmd-manual" })]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    await postReceipt(base, { commandId: "cmd-manual", status: "DONE", at: finishedAt });
    const payload = store.all()[0]?.payload as IrrigationFinishedPayload;
    expect("prescriptionId" in payload).toBe(false);
  });

  it("参数里的处方标识空白或类型不对时按没有处方处理", () => {
    const blank = buildFinishedEvent(command({ parameters: { zones: ZONES, prescriptionId: "  " } }), finishedAt)?.payload as IrrigationFinishedPayload;
    expect("prescriptionId" in blank).toBe(false);
    const dirty = buildFinishedEvent(command({ parameters: { zones: ZONES, prescriptionId: 123 } }), finishedAt)?.payload as IrrigationFinishedPayload;
    expect("prescriptionId" in dirty).toBe(false);
    const kept = buildFinishedEvent(command({ parameters: { zones: ZONES, prescriptionId: " rx-1 " } }), finishedAt)?.payload as IrrigationFinishedPayload;
    expect(kept.prescriptionId).toBe("rx-1");
  });

  it("急停与播种的 DONE 不推任何结单事件", async () => {
    const repository = new InMemoryControlCommandRepository([
      command({ id: "cmd-estop", type: "ESTOP", parameters: {} }),
      command({ id: "cmd-seed", type: "SEEDING", parameters: {} }),
    ]);
    const { store, outbox, withTransaction } = makeRelay();
    const base = await start(createControlHttpServer(repository, { outbox, withTransaction }));

    expect((await postReceipt(base, { commandId: "cmd-estop", status: "DONE", at: finishedAt, result: { confirmed: true } })).status).toBe(200);
    expect((await postReceipt(base, { commandId: "cmd-seed", status: "DONE", at: finishedAt })).status).toBe(200);

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
