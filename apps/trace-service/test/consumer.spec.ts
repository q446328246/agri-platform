import { EventTopic } from "@agri/contracts";
import type { FertilizationFinishedPayload, IrrigationFinishedPayload, PrescriptionIssuedPayload } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createTraceEventConsumer } from "../src/consumer.js";
import { InMemoryTraceRepository } from "../src/repository.js";

/**
 * 生产档案消费的契约测试。
 * 处方（建议）、灌溉与施肥结单（实际执行）都要入档，且同一事件重放不会重复建档。
 */

const payload: PrescriptionIssuedPayload = {
  parcelId: "P-1",
  seasonId: "S-1",
  planType: "fertilization",
  items: [{ materialCode: "fert-urea", dosage: 12, windowStart: "2026-11-05T02:00:00.000Z", windowEnd: "2026-11-05T06:00:00.000Z" }],
};

const irrigation: IrrigationFinishedPayload = {
  commandId: "cmd-irri-1",
  parcelId: "P-1",
  deviceId: "device-irri-001",
  waterVolume: 133.33,
  waterVolumeSource: "PLAN",
  durationMin: 40,
  durationSource: "RUNTIME",
  finishedAt: "2026-11-05T03:00:00.000Z",
};

const fertilization: FertilizationFinishedPayload = {
  commandId: "cmd-fert-1",
  parcelId: "P-1",
  deviceId: "device-irri-001",
  fertilizerKg: 150,
  fertilizerSource: "PLAN",
  durationMin: 35,
  durationSource: "RUNTIME",
  finishedAt: "2026-11-05T04:00:00.000Z",
};

function setup() {
  const store = new InMemoryEventLogStore();
  const records = new InMemoryTraceRepository();
  const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "decision", producer: "decision" });
  const { dispatcher, consumer } = createTraceEventConsumer(records, store, { pollIntervalMs: 20 });
  return { store, records, publisher, dispatcher, consumer };
}

describe("生产档案事件消费", () => {
  it("处方生成后写入生产档案并保留下发方标识", async () => {
    const { records, publisher, consumer } = setup();
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, payload);
    await consumer.pollOnce();

    const list = await records.list("P-1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ event: "PRESCRIPTION_ISSUED", plotCode: "P-1", operator: "event:decision" });
    expect(list[0]?.detail).toContain("施肥处方");
    expect(list[0]?.detail).toContain("fert-urea");
  });

  it("同一事件重复分发只保留一条档案", async () => {
    const { store, records, publisher, consumer, dispatcher } = setup();
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, payload);
    await consumer.pollOnce();
    const event = store.all()[0]?.event;
    expect(event).toBeDefined();
    await dispatcher.dispatch(event!);
    expect(await records.list("P-1")).toHaveLength(1);
  });

  it("灌溉结单入档，档案时间取结单时刻并标注数值来源", async () => {
    const { store, records, dispatcher, consumer } = setup();
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "control-finished:cmd-irri-1", producer: "control" });
    await publisher.publish(EventTopic.ControlIrrigationFinished, irrigation);
    expect(await consumer.pollOnce()).toBe(1);

    const list = await records.list("P-1", "IRRIGATION_FINISHED");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      traceCode: "TR-IRR-cmd-irri-1",
      plotCode: "P-1",
      operator: "event:control",
      createdAt: "2026-11-05T03:00:00.000Z",
    });
    expect(list[0]?.detail).toContain("cmd-irri-1");
    expect(list[0]?.detail).toContain("用水 133.33 立方米（按分区方案推算）");
    expect(list[0]?.detail).toContain("历时 40 分钟（按回执时间推算）");
  });

  it("同一条指令换 eventId 重投也不重复建档", async () => {
    const { store, records, consumer } = setup();
    const first = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "t1", producer: "control" });
    const second = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "t2", producer: "control" });
    await first.publish(EventTopic.ControlIrrigationFinished, irrigation);
    await consumer.pollOnce();
    await second.publish(EventTopic.ControlIrrigationFinished, irrigation);
    await consumer.pollOnce();

    expect(store.all()).toHaveLength(2);
    expect(await records.list("P-1", "IRRIGATION_FINISHED")).toHaveLength(1);
  });

  it("施肥结单入档：与灌溉分事件编码，投肥量与来源都写进详情", async () => {
    const { store, records, consumer } = setup();
    await new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "control-finished:cmd-fert-1", producer: "control" })
      .publish(EventTopic.ControlFertilizationFinished, fertilization);
    expect(await consumer.pollOnce()).toBe(1);

    const list = await records.list("P-1", "FERTILIZATION_FINISHED");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      traceCode: "TR-FERT-cmd-fert-1",
      plotCode: "P-1",
      operator: "event:control",
      createdAt: "2026-11-05T04:00:00.000Z",
    });
    expect(list[0]?.detail).toContain("施氮磷钾合计 150 千克（按配方与面积推算）");
    expect(list[0]?.detail).toContain("历时 35 分钟（按回执时间推算）");
    // 施肥结单不会顺手补一条灌溉档案：两本账各自的事件编码，混了就把用水统计污染了
    expect(await records.list("P-1", "IRRIGATION_FINISHED")).toHaveLength(0);
  });

  it("设备实测的投肥量按实测口径入档，未上报时直说未上报", async () => {
    const { store, records, consumer } = setup();
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "t", producer: "control" });
    await publisher.publish(EventTopic.ControlFertilizationFinished, { ...fertilization, commandId: "cmd-fert-2", fertilizerSource: "DEVICE" });
    // 设备没报、参数也推不出来的自动指令：载荷干脆不带投肥量字段
    const unmeasured: FertilizationFinishedPayload = {
      commandId: "cmd-fert-3",
      parcelId: "P-1",
      deviceId: "device-irri-001",
      durationMin: fertilization.durationMin,
      durationSource: "RUNTIME",
      finishedAt: fertilization.finishedAt,
    };
    await publisher.publish(EventTopic.ControlFertilizationFinished, unmeasured);
    await consumer.pollOnce();

    const measured = await records.list("P-1", "FERTILIZATION_FINISHED");
    expect(measured).toHaveLength(2);
    expect(measured.find((record) => record.traceCode === "TR-FERT-cmd-fert-2")?.detail).toContain("（设备实测）");
    expect(measured.find((record) => record.traceCode === "TR-FERT-cmd-fert-3")?.detail).toContain("施肥量未上报");
  });

  it("同一条施肥指令重投不重复建档", async () => {
    const { store, records, consumer } = setup();
    await new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "t1", producer: "control" })
      .publish(EventTopic.ControlFertilizationFinished, fertilization);
    await consumer.pollOnce();
    await new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "t2", producer: "control" })
      .publish(EventTopic.ControlFertilizationFinished, fertilization);
    await consumer.pollOnce();

    expect(store.all()).toHaveLength(2);
    expect(await records.list("P-1", "FERTILIZATION_FINISHED")).toHaveLength(1);
  });

  it("先建议后执行：处方与结单在链条上是两条独立档案", async () => {
    const { store, records, publisher, consumer } = setup();
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, payload);
    await consumer.pollOnce();
    await new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "t", producer: "control" })
      .publish(EventTopic.ControlIrrigationFinished, { ...irrigation, commandId: "cmd-irri-2" });
    await consumer.pollOnce();

    const list = await records.list("P-1");
    expect(list.map((record) => record.event).sort()).toEqual(["IRRIGATION_FINISHED", "PRESCRIPTION_ISSUED"]);
    // 结单档案的时间是设备结单时刻，比处方下发时刻更贴近实际作业
    expect(list.find((record) => record.event === "IRRIGATION_FINISHED")?.createdAt).toBe(irrigation.finishedAt);
  });
});
