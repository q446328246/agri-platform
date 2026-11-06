import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createTelemetryHttpServer } from "../src/http.js";
import { InMemoryPestEventRepository } from "../src/pest.repository.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "../src/reading.repository.js";

/**
 * 四情相关的接口验证：阈值规则可从接口维护、虫情上报一次完成
 * 「落库 → 告警 → 事件」三步，总览接口能一次取齐看板数据。
 */

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createTelemetryHttpServer({
    readings: new InMemoryReadingRepository(),
    alerts: new InMemoryAlertRepository(),
    pests: new InMemoryPestEventRepository(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function send(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

describe("四情监控接口", () => {
  it("返回默认阈值规则并按新规则生成告警", async () => {
    await withServer(async (base) => {
      const rules = await send(base, "GET", "/api/v1/telemetry/rules");
      expect(rules.status).toBe(200);
      expect(rules.body.data).toHaveLength(7);
      expect(rules.body.data.map((rule: { metric: string }) => rule.metric)).toContain("canopyCoverage");

      const created = await send(base, "POST", "/api/v1/telemetry/rules", {
        metric: "airHumidity",
        direction: "below",
        threshold: 40,
        level: "WARNING",
        message: "空气湿度低于适宜下限",
      });
      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({ metric: "airHumidity", direction: "below", threshold: 40 });

      const breached = await send(base, "POST", "/api/v1/telemetry/report", {
        deviceId: "device-weather-001",
        plotCode: "511723-000001-01-00001-0000-5",
        metric: "airHumidity",
        value: 35,
        unit: "%",
        recordedAt: "2026-11-05T02:00:00Z",
      });
      expect(breached.status).toBe(201);
      expect(breached.body.data.alert).toMatchObject({ level: "WARNING", message: "空气湿度低于适宜下限" });

      const badRule = await send(base, "POST", "/api/v1/telemetry/rules", { metric: "windSpeed", direction: "sideways", threshold: 1, level: "INFO", message: "x" });
      expect(badRule.status).toBe(400);
    });
  });

  it("虫情上报生成告警、可查询可处理", async () => {
    await withServer(async (base) => {
      const reported = await send(base, "POST", "/api/v1/telemetry/pest-events", {
        plotCode: "511723-000001-01-00001-0000-5",
        deviceId: "camera-001",
        pestType: "稻飞虱",
        level: 3,
        confidence: 0.92,
        imageFileId: "file-pest-001",
        detectedAt: "2026-11-05T03:10:00Z",
      });
      expect(reported.status).toBe(201);
      const event = reported.body.data.event;
      expect(event).toMatchObject({ pestType: "稻飞虱", level: 3, handled: false });
      expect(reported.body.data.alert).toMatchObject({ metric: "pestCount", level: "CRITICAL", plotCode: "511723-000001-01-00001-0000-5" });

      const pending = await send(base, "GET", "/api/v1/telemetry/pests?pendingOnly=true");
      expect(pending.body.data).toHaveLength(1);

      const overview = await send(base, "GET", "/api/v1/telemetry/overview");
      expect(overview.status).toBe(200);
      expect(overview.body.data.pests).toHaveLength(1);
      expect(overview.body.data.rules).toHaveLength(7);

      const handled = await send(base, "POST", `/api/v1/telemetry/pests/${event.id as string}/handle`);
      expect(handled.status).toBe(200);
      const afterHandle = await send(base, "GET", "/api/v1/telemetry/pests?pendingOnly=true");
      expect(afterHandle.body.data).toHaveLength(0);
    });
  });

  it("虫情等级与置信度非法时拒绝上报", async () => {
    await withServer(async (base) => {
      const badLevel = await send(base, "POST", "/api/v1/telemetry/pest-events", { pestType: "稻飞虱", level: 4, confidence: 0.9 });
      expect(badLevel.status).toBe(400);
      const badConfidence = await send(base, "POST", "/api/v1/telemetry/pest-events", { pestType: "稻飞虱", level: 2, confidence: 1.5 });
      expect(badConfidence.status).toBe(400);
    });
  });
});
