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

  it("分层土壤：按深度分别保留最新读数，历史可按地块与深度筛选", async () => {
    await withServer(async (base) => {
      const plot = "511723-000001-01-00001-0000-5";
      // 同一设备同一指标，浅层 20cm 与深层 60cm 各上报两次，最新值应分别保留
      for (const depthCm of [20, 60]) {
        await send(base, "POST", "/api/v1/telemetry/report", { deviceId: "device-soil-009", plotCode: plot, metric: "soilMoisture", value: 35, unit: "%", recordedAt: "2026-11-01T01:00:00Z", depthCm });
        await send(base, "POST", "/api/v1/telemetry/report", { deviceId: "device-soil-009", plotCode: plot, metric: "soilMoisture", value: depthCm === 20 ? 22 : 48, unit: "%", recordedAt: "2026-11-01T02:00:00Z", depthCm });
      }

      const latest = await send(base, "GET", "/api/v1/telemetry/latest?deviceId=device-soil-009");
      expect(latest.body.data).toHaveLength(2);
      const shallow = latest.body.data.find((row: { depthCm?: number }) => row.depthCm === 20);
      const deep = latest.body.data.find((row: { depthCm?: number }) => row.depthCm === 60);
      expect(shallow.value).toBe(22);
      expect(deep.value).toBe(48);

      const onlyDeep = await send(base, "GET", "/api/v1/telemetry/latest?deviceId=device-soil-009&depthCm=60");
      expect(onlyDeep.body.data).toHaveLength(1);
      expect(onlyDeep.body.data[0].depthCm).toBe(60);

      const historyDeep = await send(base, "GET", `/api/v1/telemetry/history?plotCode=${encodeURIComponent(plot)}&metric=soilMoisture&depthCm=60`);
      expect(historyDeep.body.data).toHaveLength(2);
      expect(historyDeep.body.data.every((row: { depthCm?: number }) => row.depthCm === 60)).toBe(true);

      const seriesShallow = await send(base, "GET", `/api/v1/telemetry/history/series?deviceId=device-soil-009&metric=soilMoisture&depthCm=20`);
      expect(seriesShallow.body.data.map((point: { value: number }) => point.value)).toEqual([35, 22]);

      const badDepth = await send(base, "POST", "/api/v1/telemetry/report", { deviceId: "device-soil-009", metric: "soilMoisture", value: 30, depthCm: -5 });
      expect(badDepth.status).toBe(400);
      const fractionalDepth = await send(base, "POST", "/api/v1/telemetry/report", { deviceId: "device-soil-009", metric: "soilMoisture", value: 30, depthCm: 20.5 });
      expect(fractionalDepth.status).toBe(400);
    });
  });
});
