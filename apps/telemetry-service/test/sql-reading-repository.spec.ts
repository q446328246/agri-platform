import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import { SqlAlertRepository, SqlReadingRepository } from "../src/reading.repository.js";

const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlReadingRepository（真实库）", () => {
  it("写入读数、查询历史序列并维护告警", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const readings = new SqlReadingRepository(client);
    const alerts = new SqlAlertRepository(client);
    const device = `device-smoke-${Date.now()}`;
    try {
      await readings.create(undefined, { deviceId: device, plotCode: "P-1", metric: "soilMoisture", value: 42, unit: "%", recordedAt: "2026-11-01T01:00:00Z" });
      await readings.create(undefined, { deviceId: device, plotCode: "P-1", metric: "soilMoisture", value: 18, unit: "%", recordedAt: "2026-11-01T02:00:00Z" });
      const series = await readings.historySeries({ deviceId: device, metric: "soilMoisture" });
      expect(series.map((point) => point.value)).toEqual([42, 18]);
      const latest = await readings.latest(device);
      expect(latest).toHaveLength(1);
      expect(latest[0]?.value).toBe(18);

      const alert = await alerts.create(undefined, {
        id: `alert-${device}`,
        deviceId: device,
        plotCode: "P-1",
        level: "WARNING",
        metric: "soilMoisture",
        message: "冒烟告警",
        createdAt: "2026-11-01T02:00:00Z",
        handled: false,
      });
      expect((await alerts.pending()).some((item) => item.id === alert.id)).toBe(true);
      expect(await alerts.markHandled(alert.id)).toBe(true);
      expect((await alerts.pending()).some((item) => item.id === alert.id)).toBe(false);
    } finally {
      await client.$executeRawUnsafe(`DELETE FROM telemetry_alerts WHERE device_id = $1`, device);
      await client.$executeRawUnsafe(`DELETE FROM telemetry_readings WHERE device_id = $1`, device);
      await client.$disconnect();
    }
  });

  it("分层深度：最新读数按深度分区，历史可按地块与深度过滤", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const readings = new SqlReadingRepository(client);
    const device = `device-depth-${Date.now()}`;
    const plot = `P-DEPTH-${Date.now()}`;
    try {
      for (const depthCm of [20, 60]) {
        await readings.create(undefined, { deviceId: device, plotCode: plot, metric: "soilMoisture", value: 35, unit: "%", recordedAt: "2026-11-01T01:00:00Z", depthCm });
        await readings.create(undefined, { deviceId: device, plotCode: plot, metric: "soilMoisture", value: depthCm === 20 ? 22 : 48, unit: "%", recordedAt: "2026-11-01T02:00:00Z", depthCm });
      }
      const latest = await readings.latest(device);
      expect(latest).toHaveLength(2);
      expect(latest.find((row) => row.depthCm === 20)?.value).toBe(22);
      expect(latest.find((row) => row.depthCm === 60)?.value).toBe(48);

      const deepHistory = await readings.history({ plotCode: plot, metric: "soilMoisture", depthCm: 60 });
      expect(deepHistory).toHaveLength(2);
      expect(deepHistory.every((row) => row.depthCm === 60)).toBe(true);

      const shallowSeries = await readings.historySeries({ deviceId: device, metric: "soilMoisture", depthCm: 20 });
      expect(shallowSeries.map((point) => point.value)).toEqual([35, 22]);
    } finally {
      await client.$executeRawUnsafe(`DELETE FROM telemetry_readings WHERE device_id = $1`, device);
      await client.$disconnect();
    }
  });
});
