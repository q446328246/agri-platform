import { EventTopic } from "@agri/contracts";
import type { PrescriptionIssuedPayload, ThresholdBreachedPayload } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createControlEventConsumer } from "../src/consumer.js";
import { InMemoryControlCommandRepository } from "../src/control.repository.js";

/**
 * 控制指令消费的契约测试。
 * 事件日志与分发器均使用内存实现，覆盖「事件能否转成可执行水肥指令」
 * 以及「不该自动下发的场景不生成指令」两处关键判断。
 */

const TENANT = "tenant-demo";

function setup() {
  const store = new InMemoryEventLogStore();
  const commands = new InMemoryControlCommandRepository();
  const publisher = new EventLogPublisher(store, { tenantId: TENANT, traceId: "telemetry", producer: "telemetry" });
  const { dispatcher, consumer } = createControlEventConsumer(commands, store, { pollIntervalMs: 20 });
  return { store, commands, publisher, dispatcher, consumer };
}

const threshold: ThresholdBreachedPayload = {
  parcelId: "P-1",
  metric: "soilMoisture",
  value: 18,
  threshold: 30,
  direction: "below",
  occurredAt: "2026-11-05T01:00:00.000Z",
};

const prescription: PrescriptionIssuedPayload = {
  parcelId: "P-1",
  seasonId: "S-1",
  planType: "irrigation",
  items: [{ materialCode: "water-01", dosage: 18, windowStart: "2026-11-05T02:00:00.000Z", windowEnd: "2026-11-05T06:00:00.000Z" }],
};

describe("控制指令事件消费", () => {
  it("土壤含水率低于下限时生成自动补灌指令", async () => {
    const { commands, publisher, consumer } = setup();
    await publisher.publish(EventTopic.TelemetryThresholdBreached, threshold);
    await consumer.pollOnce();

    expect(commands.all()).toHaveLength(1);
    // 归属跟着事件信封走，不是进程默认租户写死的
    expect(commands.all()[0]).toMatchObject({
      tenantId: TENANT,
      type: "IRRIGATION",
      origin: "EVENT",
      status: "QUEUED",
      operatorId: "system:event",
      plotCode: "P-1",
      deviceId: "auto-P-1",
    });
    expect(commands.all()[0]?.reason).toContain("低于阈值");
    expect(commands.all()[0]?.sourceEventId).toBeTruthy();
  });

  it("非缺水越限不自动下令，避免误动作", async () => {
    const { commands, publisher, consumer } = setup();
    await publisher.publish(EventTopic.TelemetryThresholdBreached, { ...threshold, metric: "airTemperature", direction: "above", value: 41 });
    await consumer.pollOnce();
    expect(commands.all()).toHaveLength(0);
  });

  it("灌溉与施肥处方转成对应水肥指令，植保处方不自动下发", async () => {
    const { commands, publisher, consumer } = setup();
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, prescription);
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, { ...prescription, planType: "fertilization" });
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, { ...prescription, planType: "pesticide" });
    await consumer.pollOnce();

    const types = commands.all().map((command) => command.type).sort();
    expect(types).toEqual(["FERTILIZATION", "IRRIGATION"]);
    expect(commands.all().every((command) => command.origin === "EVENT" && command.parameters.source === "prescription")).toBe(true);
  });

  it("同一事件重复分发只生成一条指令", async () => {
    const { store, commands, publisher, consumer, dispatcher } = setup();
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, prescription);
    await consumer.pollOnce();
    const event = store.all()[0]?.event;
    expect(event).toBeDefined();
    await dispatcher.dispatch(event!);
    expect(commands.all()).toHaveLength(1);
  });
});
