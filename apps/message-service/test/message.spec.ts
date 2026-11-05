import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import type { DomainEvent } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createMessageEventConsumer } from "../src/consumer.js";
import { createMessageHttpServer } from "../src/http.js";
import { InMemoryMessageRepository } from "../src/message.repository.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const messages = new InMemoryMessageRepository();
  const server = createMessageHttpServer({ messages });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function send(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

describe("消息中心 HTTP 接口", () => {
  it("创建、分页、未读统计与标记已读", async () => {
    await withServer(async (base) => {
      const created = await send(base, "POST", "/api/v1/messages", { type: "ALERT", title: "水泵告警", content: "3 号水泵离线", level: "WARNING", plotCode: "P-1" });
      expect(created.status).toBe(201);
      expect(created.body.data.type).toBe("ALERT");
      expect(created.body.data.read).toBe(false);

      await send(base, "POST", "/api/v1/messages", { title: "春耕计划已发布", type: "NOTICE" });

      const list = await send(base, "GET", "/api/v1/messages?page=1&size=10");
      expect(list.body.data.total).toBe(2);
      expect(list.body.data.items[0]?.title).toBe("春耕计划已发布");

      const alerts = await send(base, "GET", "/api/v1/messages?type=ALERT");
      expect(alerts.body.data.total).toBe(1);

      const unread = await send(base, "GET", "/api/v1/messages/unread-count");
      expect(unread.body.data.unread).toBe(2);

      const read = await send(base, "POST", `/api/v1/messages/${created.body.data.id as string}/read`);
      expect(read.status).toBe(200);
      expect(read.body.data.read).toBe(true);

      const unreadAfter = await send(base, "GET", "/api/v1/messages/unread-count");
      expect(unreadAfter.body.data.unread).toBe(1);

      const unreadOnly = await send(base, "GET", "/api/v1/messages?read=false");
      expect(unreadOnly.body.data.total).toBe(1);

      const missing = await send(base, "POST", "/api/v1/messages/not-exist/read");
      expect(missing.status).toBe(404);

      const invalid = await send(base, "POST", "/api/v1/messages", { title: "  " });
      expect(invalid.status).toBe(400);
    });
  });
});

describe("消息中心事件消费", () => {
  it("越限与处方事件分别生成告警与通知，同一事件只生成一条消息", async () => {
    const store = new InMemoryEventLogStore();
    const messages = new InMemoryMessageRepository();
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "telemetry", producer: "telemetry" });
    const { dispatcher, consumer } = createMessageEventConsumer(messages, store, { pollIntervalMs: 50 });

    const breached = await publisher.publish(EventTopic.TelemetryThresholdBreached, {
      parcelId: "P-511723-00001",
      metric: "soilMoisture",
      value: 18,
      threshold: 30,
      direction: "below",
      occurredAt: "2026-11-05T01:00:00.000Z",
    });
    const issued = await publisher.publish(EventTopic.DecisionPrescriptionIssued, {
      parcelId: "P-511723-00001",
      seasonId: "2026",
      planType: "irrigation",
      items: [{ materialCode: "water", dosage: 18, windowStart: "2026-11-05T02:00:00.000Z", windowEnd: "2026-11-05T06:00:00.000Z" }],
    });

    expect(await consumer.pollOnce()).toBe(2);
    const rows = messages.all();
    expect(rows).toHaveLength(2);

    const alert = rows.find((row) => row.type === "ALERT");
    expect(alert?.level).toBe("WARNING");
    expect(alert?.title).toContain("土壤含水率越限");
    expect(alert?.plotCode).toBe("P-511723-00001");
    expect(alert?.sourceEventId).toBe(breached.eventId);

    const notice = rows.find((row) => row.type === "NOTICE");
    expect(notice?.level).toBe("INFO");
    expect(notice?.title).toContain("灌溉处方已生成");
    expect(notice?.content).toContain("1 项作业建议");
    expect(notice?.sourceEventId).toBe(issued.eventId);

    // 重复投递同一事件：分发器幂等拦截，仓储唯一约束再兜一层
    const replay: DomainEvent = {
      eventId: breached.eventId,
      topic: EventTopic.TelemetryThresholdBreached,
      version: 1,
      occurredAt: "2026-11-05T01:00:00.000Z",
      producer: "telemetry",
      tenantId: "tenant-demo",
      traceId: "trace-replay",
      payload: { parcelId: "P-511723-00001", metric: "soilMoisture", value: 18, threshold: 30, direction: "below", occurredAt: "2026-11-05T01:00:00.000Z" },
    };
    await dispatcher.dispatch(replay);
    expect(messages.all()).toHaveLength(2);

    const duplicated = await messages.create({ ...rows[0]!, id: "msg-dup", sourceEventId: breached.eventId });
    expect(duplicated).toBeNull();
    expect(messages.all()).toHaveLength(2);
    expect(await store.readOffset("message-service", EventTopic.DecisionPrescriptionIssued)).toBe(2);
  });

  it("风速越限按严重级别生成告警", async () => {
    const store = new InMemoryEventLogStore();
    const messages = new InMemoryMessageRepository();
    const publisher = new EventLogPublisher(store, { tenantId: "tenant-demo", traceId: "telemetry", producer: "telemetry" });
    const { consumer } = createMessageEventConsumer(messages, store);

    await publisher.publish(EventTopic.TelemetryThresholdBreached, {
      parcelId: "P-2",
      metric: "windSpeed",
      value: 12,
      threshold: 10,
      direction: "above",
      occurredAt: "2026-11-05T02:00:00.000Z",
    });
    await consumer.pollOnce();

    const alert = messages.all()[0];
    expect(alert?.level).toBe("CRITICAL");
    expect(alert?.content).toContain("高于上限");
  });
});
