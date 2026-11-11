import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createTelemetryHttpServer } from "../src/http.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "../src/reading.repository.js";

/**
 * 地块分级阈值（开发方案 6.1）：同一指标在同一地块可配「提示—预警—告警」三级，
 * 地块专属优先于全局，一次上报命中多级只按最严重一级生成一条告警。
 */

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createTelemetryHttpServer({ readings: new InMemoryReadingRepository(), alerts: new InMemoryAlertRepository() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function send(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}

function report(base: string, plotCode: string, value: number, recordedAt: string) {
  return send(base, "POST", "/api/v1/telemetry/report", { deviceId: "device-soil-009", plotCode, metric: "soilMoisture", value, unit: "%", recordedAt });
}

describe("地块分级阈值", () => {
  it("同一地块三级阈值按最严重命中级生成一条告警", async () => {
    await withServer(async (base) => {
      const plot = "P-TIER-1";
      for (const [level, threshold] of [["INFO", 40], ["WARNING", 30], ["CRITICAL", 20]] as const) {
        const created = await send(base, "POST", "/api/v1/telemetry/rules", { metric: "soilMoisture", plotCode: plot, direction: "below", threshold, level, message: `土壤湿度${level}` });
        expect(created.status).toBe(200);
        expect(created.body.data.plotCode).toBe(plot);
      }
      // 25 命中 INFO 与 WARNING，取最严重的 WARNING
      const warn = await report(base, plot, 25, "2026-11-01T01:00:00Z");
      expect(warn.body.data.alert).toMatchObject({ level: "WARNING", message: "土壤湿度WARNING" });
      // 15 命中三级，取 CRITICAL
      const crit = await report(base, plot, 15, "2026-11-01T02:00:00Z");
      expect(crit.body.data.alert).toMatchObject({ level: "CRITICAL", message: "土壤湿度CRITICAL" });
      // 35 只命中 INFO
      const info = await report(base, plot, 35, "2026-11-01T03:00:00Z");
      expect(info.body.data.alert).toMatchObject({ level: "INFO", message: "土壤湿度INFO" });
      // 45 不越限，无告警
      const ok = await report(base, plot, 45, "2026-11-01T04:00:00Z");
      expect(ok.body.data.alert).toBeNull();
    });
  });

  it("地块专属规则优先于全局，未配置地块回落全局", async () => {
    await withServer(async (base) => {
      // 全局默认 soilMoisture below 30 WARNING；给 P-OVERRIDE 配 below 50 CRITICAL
      await send(base, "POST", "/api/v1/telemetry/rules", { metric: "soilMoisture", plotCode: "P-OVERRIDE", direction: "below", threshold: 50, level: "CRITICAL", message: "地块专属告警" });
      const overridden = await report(base, "P-OVERRIDE", 40, "2026-11-01T01:00:00Z");
      expect(overridden.body.data.alert).toMatchObject({ level: "CRITICAL", message: "地块专属告警" });
      // 其它地块仍走全局：25 < 30 → WARNING
      const fallback = await report(base, "P-OTHER", 25, "2026-11-01T02:00:00Z");
      expect(fallback.body.data.alert).toMatchObject({ level: "WARNING", message: "土壤含水率低于灌溉阈值" });
    });
  });

  it("按地块筛选规则含全局兜底，删除只移除指定地块的指定级", async () => {
    await withServer(async (base) => {
      await send(base, "POST", "/api/v1/telemetry/rules", { metric: "soilMoisture", plotCode: "P-DEL", direction: "below", threshold: 20, level: "CRITICAL", message: "x" });
      const filtered = await send(base, "GET", "/api/v1/telemetry/rules?plotCode=P-DEL");
      expect(filtered.body.data).toHaveLength(8); // 全局 7 + 地块 1
      expect(filtered.body.data.some((rule: { plotCode: string; level: string }) => rule.plotCode === "P-DEL" && rule.level === "CRITICAL")).toBe(true);

      const removed = await send(base, "DELETE", "/api/v1/telemetry/rules/soilMoisture?plotCode=P-DEL&level=CRITICAL");
      expect(removed.status).toBe(200);
      const after = await send(base, "GET", "/api/v1/telemetry/rules?plotCode=P-DEL");
      expect(after.body.data).toHaveLength(7);
      // 全局规则不受影响
      const all = await send(base, "GET", "/api/v1/telemetry/rules");
      expect(all.body.data).toHaveLength(7);
    });
  });
});