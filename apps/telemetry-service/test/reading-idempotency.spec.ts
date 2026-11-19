import { describe, expect, it } from "vitest";

import { InMemoryReadingRepository } from "../src/reading.repository.js";

/**
 * 遥测幂等落库（A2）：设备侧 MQTT QoS 1/2 重投与断网补传会重复上报，
 * 同 (deviceId, metric, depthCm, recordedAt) 只应保留一条，且不重复触发告警。
 *
 * 这里验证内存实现（SQL 实现依赖真实库，见 sql-reading-repository.spec.ts）。
 */

describe("遥测幂等落库（A2）", () => {
  it("同键重复上报只保留一条，返回既有读数且 inserted=false", async () => {
    const readings = new InMemoryReadingRepository();
    const input = { deviceId: "DEV-001", plotCode: "P-1", metric: "soilMoisture", value: 42, unit: "%", recordedAt: "2026-11-19T01:00:00Z" };

    const first = await readings.createIdempotent(undefined, input);
    expect(first.inserted).toBe(true);

    // 重复上报即使数值变了也不覆盖既有读数
    const second = await readings.createIdempotent(undefined, { ...input, value: 99 });
    expect(second.inserted).toBe(false);
    expect(second.reading.id).toBe(first.reading.id);
    expect(second.reading.value).toBe(42);
    expect(await readings.count()).toBe(1);
  });

  it("分层与非分层同设备同指标同时间各自保留一条", async () => {
    const readings = new InMemoryReadingRepository();
    const base = { deviceId: "DEV-001", plotCode: "P-1", metric: "soilMoisture", value: 42, unit: "%", recordedAt: "2026-11-19T01:00:00Z" };

    const shallow = await readings.createIdempotent(undefined, { ...base, depthCm: 20 });
    const deep = await readings.createIdempotent(undefined, { ...base, depthCm: 60 });
    const noDepth = await readings.createIdempotent(undefined, base);

    expect([shallow.inserted, deep.inserted, noDepth.inserted]).toEqual([true, true, true]);
    expect(await readings.count()).toBe(3);
  });
});
