import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import type { FertilizationFinishedPayload, IrrigationFinishedPayload } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createDecisionEventConsumer } from "../src/consumer.js";
import { InMemoryExecutionRepository } from "../src/execution.repository.js";
import { createDecisionHttpServer } from "../src/http.js";
import type { PrescriptionRecord } from "../src/prescription.repository.js";
import { InMemoryPrescriptionRepository } from "../src/prescription.repository.js";

/**
 * 处方执行回流的消费契约。
 *
 * 处方发出去只是建议，DONE 回执带回来的用水量与投肥量才是执行事实。
 * 这里锁三件事：来源处方能对上、同一条指令重投不重复记账、人工指令没有处方就不回流。
 * 用量字段一律照搬事件载荷并保留来源标记——决策侧不替设备测量，也不替它编一个数。
 */

const PLOT = "511723-000001-01-00001-0000-5";

function prescriptionRecord(id: string, plotCode = PLOT): PrescriptionRecord {
  return {
    id,
    plotCode,
    plotName: "东区一号田",
    status: "RECOMMENDED",
    soilMoisture: 24.6,
    growthStage: "分蘖期",
    inputs: {},
    matchedRules: [{ id: "rule-soil-dry", name: "土壤含水率低于阈值补灌", expression: "soilMoisture < 30", action: { type: "IRRIGATION" } }] satisfies PrescriptionRecord["matchedRules"],
    actions: [{ materialCode: "water", dosage: 25, windowStart: "2026-11-12T01:00:00.000Z", windowEnd: "2026-11-12T05:00:00.000Z" }],
    generatedAt: "2026-11-12T00:00:00.000Z",
    issuedAt: "2026-11-12T00:00:00.000Z",
  };
}

function irrigation(overrides: Partial<IrrigationFinishedPayload> = {}): IrrigationFinishedPayload {
  return {
    commandId: "cmd-irri-1",
    parcelId: PLOT,
    deviceId: "device-irri-001",
    waterVolume: 133.33,
    waterVolumeSource: "PLAN",
    durationMin: 40,
    durationSource: "RUNTIME",
    finishedAt: "2026-11-12T02:00:00.000Z",
    prescriptionId: "presc-1",
    ...overrides,
  };
}

function fertilization(overrides: Partial<FertilizationFinishedPayload> = {}): FertilizationFinishedPayload {
  return {
    commandId: "cmd-fert-1",
    parcelId: PLOT,
    deviceId: "device-irri-001",
    fertilizerKg: 150,
    fertilizerSource: "PLAN",
    durationMin: 35,
    durationSource: "RUNTIME",
    finishedAt: "2026-11-12T04:00:00.000Z",
    prescriptionId: "presc-1",
    ...overrides,
  };
}

function setup(prescriptionIds = ["presc-1"]) {
  const store = new InMemoryEventLogStore();
  const executions = new InMemoryExecutionRepository();
  const prescriptions = new InMemoryPrescriptionRepository(prescriptionIds.map((id) => prescriptionRecord(id)));
  const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "control-finished", producer: "control" });
  const failures: Array<{ topic: string; message: string; attempt: number }> = [];
  const { consumer } = createDecisionEventConsumer(executions, prescriptions, store, {
    pollIntervalMs: 20,
    onError: (topic, _eventId, error, attempt) => failures.push({ topic, message: error.message, attempt }),
  });
  return { store, executions, prescriptions, publisher, consumer, failures };
}

describe("处方执行回流消费", () => {
  it("灌溉结单回流到来源处方，用量与来源照搬事件载荷", async () => {
    const { executions, publisher, consumer } = setup();

    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation());
    expect(await consumer.pollOnce()).toBe(1);

    const rows = executions.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prescriptionId: "presc-1",
      commandId: "cmd-irri-1",
      plotCode: PLOT,
      planType: "irrigation",
      deviceId: "device-irri-001",
      waterVolume: 133.33,
      waterVolumeSource: "PLAN",
      durationMin: 40,
      durationSource: "RUNTIME",
      finishedAt: "2026-11-12T02:00:00.000Z",
    });
    // 施肥那本账不能被灌溉事件写进去
    expect(rows[0]?.fertilizerKg).toBeUndefined();
  });

  it("施肥结单另记一条，两条主题的处方动作类型各归各", async () => {
    const { executions, publisher, consumer } = setup();

    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation());
    await publisher.publish(EventTopic.ControlFertilizationFinished, fertilization());
    expect(await consumer.pollOnce()).toBe(2);

    const byType = new Map(executions.all().map((row) => [row.planType, row]));
    expect([...byType.keys()].sort()).toEqual(["fertilization", "irrigation"]);
    expect(byType.get("fertilization")).toMatchObject({ commandId: "cmd-fert-1", fertilizerKg: 150, fertilizerSource: "PLAN" });
    expect(byType.get("fertilization")?.waterVolume).toBeUndefined();
  });

  it("人工下发的指令没有处方标识，跳过而不是硬凑一条", async () => {
    const { executions, publisher, consumer, failures } = setup();

    // 不带处方标识的载荷等价于控制页人工下发的指令
    const manual: IrrigationFinishedPayload = { ...irrigation({ commandId: "cmd-manual-1" }) };
    delete manual.prescriptionId;
    await publisher.publish(EventTopic.ControlIrrigationFinished, manual);
    expect(await consumer.pollOnce()).toBe(1);

    expect(executions.all()).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });

  it("同一条指令重投只记一次，首次留痕不被覆盖", async () => {
    const { executions, publisher, consumer } = setup();

    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation());
    expect(await consumer.pollOnce()).toBe(1);
    // 中继重试会换事件标识，但结的还是同一条指令的单，且时长口径可能已变化
    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation({ durationMin: 99, waterVolumeSource: "DEVICE" }));
    expect(await consumer.pollOnce()).toBe(1);

    const rows = executions.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ durationMin: 40, waterVolumeSource: "PLAN" });
  });

  it("设备没报且方案推不出用量时留空两个字段，不留来源", async () => {
    const { executions, publisher, consumer } = setup();

    const unmeasured: IrrigationFinishedPayload = {
      commandId: "cmd-irri-2",
      parcelId: PLOT,
      deviceId: "device-irri-002",
      durationMin: 12,
      durationSource: "RUNTIME",
      finishedAt: "2026-11-12T03:00:00.000Z",
      prescriptionId: "presc-1",
    };
    await publisher.publish(EventTopic.ControlIrrigationFinished, unmeasured);
    expect(await consumer.pollOnce()).toBe(1);

    const row = executions.all()[0];
    expect(row).toBeDefined();
    expect("waterVolume" in row!).toBe(false);
    expect("waterVolumeSource" in row!).toBe(false);
  });

  it("地块编码以处方留痕为准，指令参数改了也不跟着漂", async () => {
    const { executions, publisher, consumer } = setup();

    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation({ parcelId: "P-OTHER" }));
    await consumer.pollOnce();

    expect(executions.all()[0]?.plotCode).toBe(PLOT);
  });

  it("处方不存在时失败并留下原因，不写一条指向空处方的记录", async () => {
    const { executions, publisher, consumer, failures } = setup();

    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation({ prescriptionId: "presc-missing" }));
    expect(await consumer.pollOnce()).toBe(1);

    expect(executions.all()).toHaveLength(0);
    // 分发器按 maxAttempts 重试，每次失败都回调；断言重试次数从 1 连续排开，不把阈值抄进用例
    expect(failures.map((failure) => failure.attempt)).toEqual(failures.map((_, index) => index + 1));
    expect(new Set(failures.map((failure) => failure.topic))).toEqual(new Set([EventTopic.ControlIrrigationFinished]));
    expect(failures.every((failure) => failure.message.includes("presc-missing"))).toBe(true);
  });

  it("载荷字段非法同样失败，脏数据不进留痕", async () => {
    const { executions, publisher, consumer, failures } = setup();

    await publisher.publish(EventTopic.ControlFertilizationFinished, { ...fertilization(), durationMin: -1 });
    await publisher.publish(EventTopic.ControlFertilizationFinished, { ...fertilization(), commandId: "cmd-fert-2", fertilizerKg: Number.NaN });
    expect(await consumer.pollOnce()).toBe(2);

    expect(executions.all()).toHaveLength(0);
    expect(failures.map((failure) => failure.message)).toContain("结单事件作业时长非法");
    expect(failures.map((failure) => failure.message)).toContain("结单事件 fertilizerKg 非法");
  });

  it("轮询位点按主题推进：第二次轮询不重复处理已回流的事件", async () => {
    const { executions, publisher, consumer } = setup();

    await publisher.publish(EventTopic.ControlFertilizationFinished, fertilization());
    expect(await consumer.pollOnce()).toBe(1);
    expect(await consumer.pollOnce()).toBe(0);
    expect(executions.all()).toHaveLength(1);
  });

  it("多条处方共存时按处方查询各自执行了几次", async () => {
    const { executions, publisher, consumer } = setup(["presc-1", "presc-2"]);

    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation({ commandId: "cmd-a" }));
    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation({ commandId: "cmd-b", prescriptionId: "presc-2" }));
    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation({ commandId: "cmd-c", prescriptionId: "presc-2" }));
    await consumer.pollOnce();

    expect(await executions.list({ prescriptionId: "presc-1" })).toHaveLength(1);
    expect((await executions.list({ prescriptionId: "presc-2" })).map((row) => row.commandId).sort()).toEqual(["cmd-b", "cmd-c"]);
    expect(await executions.findByCommandId("cmd-b")).toMatchObject({ prescriptionId: "presc-2" });
    // 记录标识由 ULID 现生成，同批写入互不撞主键
    expect(new Set(executions.all().map((row) => row.id)).size).toBe(executions.all().length);
  });

  it("执行回流后从接口分页查得到，处方与地块过滤各走各的", async () => {
    const store = new InMemoryEventLogStore();
    const executions = new InMemoryExecutionRepository();
    const prescriptions = new InMemoryPrescriptionRepository([prescriptionRecord("presc-1"), prescriptionRecord("presc-2", "P-OTHER")]);
    const { consumer } = createDecisionEventConsumer(executions, prescriptions, store, { pollIntervalMs: 20 });
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "control-finished", producer: "control" });
    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation({ commandId: "cmd-http-1" }));
    await publisher.publish(EventTopic.ControlFertilizationFinished, fertilization({ commandId: "cmd-http-2", prescriptionId: "presc-2" }));
    expect(await consumer.pollOnce()).toBe(2);

    const server = createDecisionHttpServer({ prescriptions, executions });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const all = await fetch(`${base}/api/v1/decision/executions`);
      expect(all.status).toBe(200);
      const body = await all.json();
      expect(body.data.total).toBe(2);
      expect(body.data.items.map((row: { commandId: string }) => row.commandId).sort()).toEqual(["cmd-http-1", "cmd-http-2"]);

      const onePlot = await fetch(`${base}/api/v1/decision/executions?plotCode=P-OTHER`);
      const plotBody = await onePlot.json();
      expect(plotBody.data.items.map((row: { commandId: string }) => row.commandId)).toEqual(["cmd-http-2"]);

      const onePrescription = await fetch(`${base}/api/v1/decision/executions?prescriptionId=presc-1`);
      const rxBody = await onePrescription.json();
      expect(rxBody.data.items[0]).toMatchObject({ commandId: "cmd-http-1", planType: "irrigation", waterVolume: 133.33 });

      const unknown = await fetch(`${base}/api/v1/decision/executions?prescriptionId=presc-none`);
      expect((await unknown.json()).data.total).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
