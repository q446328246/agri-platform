import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createTelemetryHttpServer } from "../src/http.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "../src/reading.repository.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const readings = new InMemoryReadingRepository();
  const alerts = new InMemoryAlertRepository();
  const server = createTelemetryHttpServer({ readings, alerts });
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
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}

describe("遥测服务 HTTP 接口", () => {
  it("上报读数、按阈值生成告警并保留历史", async () => {
    await withServer(async (base) => {
      const times = ["2026-11-01T01:00:00Z", "2026-11-01T02:00:00Z", "2026-11-01T03:00:00Z"];
      for (let i = 0; i < times.length; i += 1) {
        const value = i === times.length - 1 ? 18 : 42;
        const reported = await send(base, "POST", "/api/v1/telemetry/report", {
          deviceId: "device-soil-003",
          plotCode: "511723-000001-01-00001-0000-5",
          metric: "soilMoisture",
          value,
          unit: "%",
          recordedAt: times[i],
        });
        expect(reported.status).toBe(201);
        const alert = reported.body.data.alert;
        expect(alert === null).toBe(i !== times.length - 1);
      }

      const latest = await send(base, "GET", "/api/v1/telemetry/latest?deviceId=device-soil-003");
      expect(latest.body.data).toHaveLength(1);
      expect(latest.body.data[0].value).toBe(18);

      const history = await send(base, "GET", "/api/v1/telemetry/history?deviceId=device-soil-003&metric=soilMoisture&from=2026-11-01T01:30:00Z&to=2026-11-01T02:30:00Z");
      expect(history.body.data).toHaveLength(1);
      expect(history.body.data[0].recordedAt).toBe("2026-11-01T02:00:00Z");

      const series = await send(base, "GET", "/api/v1/telemetry/history/series?deviceId=device-soil-003&metric=soilMoisture");
      expect(series.body.data.map((point: { value: number }) => point.value)).toEqual([42, 42, 18]);

      const alerts = await send(base, "GET", "/api/v1/telemetry/alerts");
      expect(alerts.body.data).toHaveLength(1);
      expect(alerts.body.data[0].level).toBe("WARNING");

      const handled = await send(base, "POST", `/api/v1/telemetry/alerts/${alerts.body.data[0].id as string}/handle`);
      expect(handled.status).toBe(200);
      const pendingAfter = await send(base, "GET", "/api/v1/telemetry/alerts");
      expect(pendingAfter.body.data).toHaveLength(0);

      const invalid = await send(base, "POST", "/api/v1/telemetry/report", { metric: "soilMoisture", value: 1 });
      expect(invalid.status).toBe(400);
    });
  });
});
