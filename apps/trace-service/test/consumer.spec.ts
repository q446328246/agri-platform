import { EventTopic } from "@agri/contracts";
import type { PrescriptionIssuedPayload } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createTraceEventConsumer } from "../src/consumer.js";
import { InMemoryTraceRepository } from "../src/repository.js";

/**
 * 生产档案消费的契约测试。
 * 验证处方事件能写入追溯档案，且同一事件重放不会重复建档。
 */

const payload: PrescriptionIssuedPayload = {
  parcelId: "P-1",
  seasonId: "S-1",
  planType: "fertilization",
  items: [{ materialCode: "fert-urea", dosage: 12, windowStart: "2026-11-05T02:00:00.000Z", windowEnd: "2026-11-05T06:00:00.000Z" }],
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
});
