import "reflect-metadata";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createTelemetryHttpServer } from "../../telemetry-service/src/http.js";
import { InMemoryPestEventRepository } from "../../telemetry-service/src/pest.repository.js";
import { createMessageEventConsumer } from "../src/consumer.js";
import { InMemoryMessageRepository } from "../src/message.repository.js";

/**
 * 虫情闭环：识别结果上报 → 事件日志 → 消息中心。
 *
 * 视频 AI 与田间核查都先落到遥测服务的虫情表，再统一发布 TelemetryPestDetected，
 * 因此这里用同一个入口验证「识别一次只产生一条消息」，
 * 并确认发生等级决定消息是告警还是通知。
 */

const PLOT = "P-PEST-0001";
const TENANT = "tenant-demo";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function call(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json", "x-tenant-id": TENANT },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

describe("虫情识别驱动消息中心", () => {
  it("严重识别生成告警消息，轻微识别生成通知", async () => {
    const store = new InMemoryEventLogStore();
    const messages = new InMemoryMessageRepository();
    const telemetry = createTelemetryHttpServer({
      pests: new InMemoryPestEventRepository(),
      publisher: new EventLogPublisher(store, { tenantId: TENANT, traceId: "telemetry", producer: "telemetry" }),
      publishEvents: true,
      tenantId: TENANT,
    });
    const { consumer } = createMessageEventConsumer(messages, store, { pollIntervalMs: 20 });
    const base = await listen(telemetry);
    try {
      const severe = await call(base, "POST", "/api/v1/telemetry/pest-events", {
        plotCode: PLOT,
        deviceId: "camera-001",
        pestType: "稻飞虱",
        level: 3,
        confidence: 0.94,
        detectedAt: "2026-11-05T03:00:00.000Z",
      });
      expect(severe.status).toBe(201);

      const slight = await call(base, "POST", "/api/v1/telemetry/pest-events", {
        plotCode: PLOT,
        deviceId: "camera-002",
        pestType: "二化螟",
        level: 1,
        confidence: 0.61,
        detectedAt: "2026-11-05T04:00:00.000Z",
      });
      expect(slight.status).toBe(201);

      expect(await consumer.pollOnce()).toBe(2);
      const rows = messages.all();
      expect(rows).toHaveLength(2);

      const alert = rows.find((row) => row.level === "CRITICAL");
      expect(alert).toMatchObject({ type: "ALERT", plotCode: PLOT });
      expect(alert?.title).toContain("严重");
      expect(alert?.content).toContain("稻飞虱");

      const notice = rows.find((row) => row.level === "INFO");
      expect(notice).toMatchObject({ type: "NOTICE", plotCode: PLOT });
      expect(notice?.title).toContain("轻微");

      // 位点提交后重复轮询不产生重复消息
      expect(await consumer.pollOnce()).toBe(0);
      expect(messages.all()).toHaveLength(2);
    } finally {
      await close(telemetry);
    }
  });
});
