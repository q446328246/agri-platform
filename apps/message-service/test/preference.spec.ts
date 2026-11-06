import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createMessageEventConsumer } from "../src/consumer.js";
import { createMessageHttpServer } from "../src/http.js";
import { InMemoryMessageRepository } from "../src/message.repository.js";
import {
  InMemoryMessagePreferenceRepository,
  SqlMessagePreferenceRepository,
} from "../src/preference.repository.js";

/**
 * 订阅偏好与去重键的行为测试。
 * 偏好决定「要不要落库」，去重键决定「同一窗口内落几条」，两者串起来
 * 才是消息中心承诺的「按订阅过滤 + 不刷屏」。
 */

const TENANT = "tenant-demo";

function setup() {
  const store = new InMemoryEventLogStore();
  const messages = new InMemoryMessageRepository();
  const preferences = new InMemoryMessagePreferenceRepository();
  const publisher = new EventLogPublisher(store, { tenantId: TENANT, traceId: "telemetry", producer: "telemetry" });
  const { consumer } = createMessageEventConsumer(messages, store, { preferences, pollIntervalMs: 20 });
  return { store, messages, preferences, publisher, consumer };
}

const breached = (overrides: Record<string, unknown> = {}) => ({
  parcelId: "P-1",
  metric: "soilMoisture",
  value: 18,
  threshold: 30,
  direction: "below",
  occurredAt: "2026-11-05T01:00:00.000Z",
  ...overrides,
});

describe("订阅偏好过滤", () => {
  it("关闭订阅后不生成消息，重新开启后恢复", async () => {
    const { messages, preferences, publisher, consumer } = setup();
    await preferences.upsert({ tenantId: TENANT, topic: EventTopic.TelemetryThresholdBreached, enabled: false, minLevel: "INFO", updatedAt: "" });

    await publisher.publish(EventTopic.TelemetryThresholdBreached, breached());
    await consumer.pollOnce();
    expect(messages.all()).toHaveLength(0);

    await preferences.upsert({ tenantId: TENANT, topic: EventTopic.TelemetryThresholdBreached, enabled: true, minLevel: "INFO", updatedAt: "" });
    await publisher.publish(EventTopic.TelemetryThresholdBreached, breached({ occurredAt: "2026-11-05T02:00:00.000Z" }));
    await consumer.pollOnce();
    expect(messages.all()).toHaveLength(1);
  });

  it("最低级别过滤：普通越限被拦，严重越限仍通知", async () => {
    const { messages, preferences, publisher, consumer } = setup();
    await preferences.upsert({ tenantId: TENANT, topic: EventTopic.TelemetryThresholdBreached, enabled: true, minLevel: "CRITICAL", updatedAt: "" });

    await publisher.publish(EventTopic.TelemetryThresholdBreached, breached());
    await consumer.pollOnce();
    expect(messages.all()).toHaveLength(0);

    await publisher.publish(EventTopic.TelemetryThresholdBreached, breached({ metric: "windSpeed", direction: "above", value: 12, threshold: 10, occurredAt: "2026-11-05T03:00:00.000Z" }));
    await consumer.pollOnce();
    expect(messages.all()).toHaveLength(1);
    expect(messages.all()[0]?.level).toBe("CRITICAL");
  });
});

describe("消息去重键", () => {
  it("同地块同指标同一小时只保留一条告警，跨小时再生成", async () => {
    const { messages, publisher, consumer } = setup();
    await publisher.publish(EventTopic.TelemetryThresholdBreached, breached({ occurredAt: "2026-11-05T01:05:00.000Z" }));
    await publisher.publish(EventTopic.TelemetryThresholdBreached, breached({ value: 16, occurredAt: "2026-11-05T01:45:00.000Z" }));
    await consumer.pollOnce();
    expect(messages.all()).toHaveLength(1);
    expect(messages.all()[0]?.dedupeKey).toContain("2026-11-05T01");

    await publisher.publish(EventTopic.TelemetryThresholdBreached, breached({ occurredAt: "2026-11-05T02:00:00.000Z" }));
    await consumer.pollOnce();
    expect(messages.all()).toHaveLength(2);
  });

  it("每份处方按来源事件分别通知", async () => {
    const { messages, publisher, consumer } = setup();
    const payload = { parcelId: "P-2", seasonId: "2026", planType: "irrigation", items: [] };
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, payload);
    await publisher.publish(EventTopic.DecisionPrescriptionIssued, payload);
    await consumer.pollOnce();
    expect(messages.all()).toHaveLength(2);
  });
});

describe("订阅偏好 HTTP 接口", () => {
  async function withServer(run: (base: string) => Promise<void>): Promise<void> {
    const preferences = new InMemoryMessagePreferenceRepository();
    const server = createMessageHttpServer({ preferences });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
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

  it("未配置时返回模板目录默认值，更新后反映已保存配置", async () => {
    await withServer(async (base) => {
      const initial = await send(base, "GET", "/api/v1/messages/preferences");
      expect(initial.status).toBe(200);
      expect(initial.body.data.items).toHaveLength(3);
      expect(initial.body.data.items.map((item: { topic: string }) => item.topic)).toContain(EventTopic.TelemetryPestDetected);
      expect(initial.body.data.items[0]).toMatchObject({ enabled: true, minLevel: "INFO" });
      expect(initial.body.data.items[0]?.label).toBeTruthy();

      const updated = await send(base, "PUT", `/api/v1/messages/preferences/${encodeURIComponent(EventTopic.TelemetryThresholdBreached)}`, { enabled: false, minLevel: "WARNING" });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({ enabled: false, minLevel: "WARNING", type: "ALERT" });

      const after = await send(base, "GET", "/api/v1/messages/preferences");
      const threshold = after.body.data.items.find((item: { topic: string }) => item.topic === EventTopic.TelemetryThresholdBreached);
      expect(threshold).toMatchObject({ enabled: false, minLevel: "WARNING" });

      const unknown = await send(base, "PUT", "/api/v1/messages/preferences/unknown.topic.value", { enabled: false });
      expect(unknown.status).toBe(404);

      const invalid = await send(base, "PUT", `/api/v1/messages/preferences/${encodeURIComponent(EventTopic.TelemetryThresholdBreached)}`, { minLevel: "DEBUG" });
      expect(invalid.status).toBe(400);
    });
  });
});

describe("订阅偏好 SQL 仓储", () => {
  it("读写使用租户与主题参数，时间列转 ISO", async () => {
    const statements: string[] = [];
    const client: PrismaClientLike = {
      async $connect() {},
      async $disconnect() {},
      async $transaction<R>(handler: (tx: Tx) => Promise<R>) {
        return handler({} as Tx);
      },
      async $queryRawUnsafe<T>(query: string) {
        statements.push(query);
        return [
          { tenant_id: TENANT, topic: EventTopic.DecisionPrescriptionIssued, enabled: false, min_level: "WARNING", updated_at: new Date("2026-11-05T01:00:00.000Z") },
        ] as T;
      },
      async $executeRawUnsafe() {
        return 1;
      },
    };
    const repository = new SqlMessagePreferenceRepository(client);
    const found = await repository.find(TENANT, EventTopic.DecisionPrescriptionIssued);
    expect(found).toMatchObject({ tenantId: TENANT, enabled: false, minLevel: "WARNING", updatedAt: "2026-11-05T01:00:00.000Z" });

    await repository.upsert({ tenantId: TENANT, topic: EventTopic.DecisionPrescriptionIssued, enabled: true, minLevel: "INFO", updatedAt: "" });
    expect(statements[0]).toContain("tenant_id = $1 AND topic = $2");
    expect(statements[1]).toContain("ON CONFLICT (tenant_id, topic) DO UPDATE");
  });
});
