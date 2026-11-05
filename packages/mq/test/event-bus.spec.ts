import { EventTopic } from "@agri/contracts";
import type { DomainEvent } from "@agri/contracts";
import { describe, expect, it } from "vitest";

import {
  EventDispatcher,
  EventLogConsumer,
  EventLogPublisher,
  IdempotencyGuard,
  InMemoryEventLogStore,
  InMemoryIdempotencyStore,
  InMemoryOutboxStore,
  OutboxService,
} from "../src/index.js";

/**
 * 事件日志传输的契约测试。
 *
 * 本地消息表保证「不丢」，事件日志游标负责「跨进程送达」，
 * 两者之间的重复由分发器幂等兜住，因此这里同时覆盖三条路径。
 */

function dispatcher(): EventDispatcher {
  return new EventDispatcher({
    idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore()),
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, deadLetterAfterMaxAttempts: true },
  });
}

describe("事件日志传输", () => {
  it("中继写入日志后消费者按游标消费，提交位点后不再重复拉取", async () => {
    const store = new InMemoryEventLogStore();
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "relay", producer: "decision" });
    const outbox = new OutboxService(new InMemoryOutboxStore(), publisher, { tenantId: "tenant-demo", traceId: "relay", producer: "decision" });

    const record = await outbox.enqueue({}, EventTopic.DecisionPrescriptionIssued, {
      parcelId: "P-511723-00001",
      seasonId: "",
      planType: "irrigation",
      items: [],
    });
    expect(await outbox.relayOnce()).toBe(1);
    expect(store.all()).toHaveLength(1);
    // 中继还原的是完整信封，事件标识与本地消息表记录一致
    expect(store.all()[0]?.event.eventId).toBe(record.id);
    expect(store.all()[0]?.event.producer).toBe("decision");

    const received: DomainEvent[] = [];
    const consumer = new EventLogConsumer({
      group: "message-service",
      store,
      dispatcher: dispatcher(),
      topics: [EventTopic.DecisionPrescriptionIssued],
    });
    consumer.subscribe(EventTopic.DecisionPrescriptionIssued, async (event) => {
      received.push(event as DomainEvent);
    });

    expect(await consumer.pollOnce()).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.tenantId).toBe("tenant-demo");

    expect(await consumer.pollOnce()).toBe(0);
    expect(received).toHaveLength(1);
    expect(await store.readOffset("message-service", EventTopic.DecisionPrescriptionIssued)).toBe(1);
  });

  it("同一事件重复入队只保留一条日志记录", async () => {
    const store = new InMemoryEventLogStore();
    const event: DomainEvent = {
      eventId: "01J0DUP000000000000000000",
      topic: EventTopic.TelemetryThresholdBreached,
      version: 1,
      occurredAt: "2026-11-05T00:00:00.000Z",
      producer: "telemetry",
      tenantId: "tenant-demo",
      traceId: "trace-1",
      payload: { parcelId: "P-1", metric: "soilMoisture", value: 18, threshold: 30, direction: "below", occurredAt: "2026-11-05T00:00:00.000Z" },
    };
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "relay", producer: "telemetry" });

    expect(await publisher.publishEnvelope(event)).toMatchObject({ offset: "1", eventId: event.eventId });
    expect(await publisher.publishEnvelope(event)).toMatchObject({ offset: "1", eventId: event.eventId });
    expect(store.all()).toHaveLength(1);
  });

  it("处理器失败时按分发器策略重试，成功后位点才前进", async () => {
    const store = new InMemoryEventLogStore();
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "relay", producer: "telemetry" });
    await publisher.publish(EventTopic.TelemetryThresholdBreached, {
      parcelId: "P-2",
      metric: "soilMoisture",
      value: 12,
      threshold: 30,
      direction: "below",
      occurredAt: "2026-11-05T00:00:00.000Z",
    });

    let attempts = 0;
    const consumer = new EventLogConsumer({
      group: "message-service",
      store,
      dispatcher: dispatcher(),
      topics: [EventTopic.TelemetryThresholdBreached],
    });
    consumer.subscribe(EventTopic.TelemetryThresholdBreached, async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("下游暂时不可用");
    });

    expect(await consumer.pollOnce()).toBe(1);
    expect(attempts).toBe(2);
    expect(await store.readOffset("message-service", EventTopic.TelemetryThresholdBreached)).toBe(1);
  });

  it("消费者重启后从已提交位点继续，不重复消费历史事件", async () => {
    const store = new InMemoryEventLogStore();
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "relay", producer: "decision" });
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, { parcelId: "P-3", seasonId: "", planType: "irrigation", items: [] });

    const first: DomainEvent[] = [];
    const consumerA = new EventLogConsumer({
      group: "message-service",
      store,
      dispatcher: dispatcher(),
      topics: [EventTopic.DecisionPrescriptionIssued],
    });
    consumerA.subscribe(EventTopic.DecisionPrescriptionIssued, async (event) => {
      first.push(event as DomainEvent);
    });
    await consumerA.pollOnce();
    expect(first).toHaveLength(1);

    await publisher.publish(EventTopic.DecisionPrescriptionIssued, { parcelId: "P-4", seasonId: "", planType: "irrigation", items: [] });

    const second: DomainEvent[] = [];
    const consumerB = new EventLogConsumer({
      group: "message-service",
      store,
      dispatcher: dispatcher(),
      topics: [EventTopic.DecisionPrescriptionIssued],
    });
    consumerB.subscribe(EventTopic.DecisionPrescriptionIssued, async (event) => {
      second.push(event as DomainEvent);
    });
    await consumerB.pollOnce();
    expect(second).toHaveLength(1);
    expect((second[0]?.payload as { parcelId: string }).parcelId).toBe("P-4");
  });
});
