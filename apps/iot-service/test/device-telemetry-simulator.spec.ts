import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const simulatorPath = fileURLToPath(new URL("../../../scripts/device-telemetry.mjs", import.meta.url));
const {
  DEVICE_TELEMETRY_PROFILES,
  historyTimestamps,
  meterM3At,
  telemetryReadings,
} = await import(simulatorPath);

function stateFor(type: string, deviceNo = "DZ-SIM-TEST") {
  return {
    fixture: { deviceId: `device-${deviceNo}`, deviceNo, type },
    flowM3h: 10,
    scale: 1,
    startedAt: Date.UTC(2026, 10, 27, 12),
    counts: 0,
    switchOn: false,
    faulted: false,
  };
}

describe("设备类型遥测模拟", () => {
  it("每种台账设备类型都有独立指标剖面", () => {
    for (const [type, profile] of Object.entries(DEVICE_TELEMETRY_PROFILES)) {
      const readings = telemetryReadings(stateFor(type), Date.UTC(2026, 10, 27, 8));
      expect(readings, type).toHaveLength(profile.length);
      expect(readings.every((reading: any) => Number.isFinite(reading.value) && reading.unit.length > 0), type).toBe(true);
    }
  });

  it("灌溉泵不再只有水量，且同一种子生成结果稳定", () => {
    const state = stateFor("IRRIGATION_PUMP", "DZ-SIM-PUMP");
    const at = Date.UTC(2026, 10, 27, 8);
    const first = telemetryReadings(state, at);
    const second = telemetryReadings(state, at);
    expect(first).toEqual(second);
    expect(first.map((reading: any) => reading.metric)).toEqual([
      "water_meter", "flowRate", "outletPressure", "motorCurrent",
      "voltage", "motorTemperature", "vibration", "pumpSpeed",
    ]);
  });

  it("泵的运行指标联动，停机流量归零且累计水量不倒退", () => {
    const state = stateFor("IRRIGATION_PUMP");
    const running = telemetryReadings(state, Date.UTC(2026, 10, 27, 8));
    const stopped = telemetryReadings(state, Date.UTC(2026, 10, 27, 12));
    const value = (readings: any[], metric: string) => readings.find((reading) => reading.metric === metric).value;
    expect(value(running, "flowRate")).toBeGreaterThan(0);
    expect(value(running, "outletPressure")).toBeGreaterThan(value(stopped, "outletPressure"));
    expect(value(running, "motorCurrent")).toBeGreaterThan(value(stopped, "motorCurrent"));
    expect(value(stopped, "flowRate")).toBe(0);
    expect(value(stopped, "pumpSpeed")).toBe(0);
    expect(value(stopped, "water_meter")).toBeGreaterThanOrEqual(value(running, "water_meter"));
  });

  it("土壤传感器按深度分层，气象站呈昼夜温差", () => {
    const soil = telemetryReadings(stateFor("SOIL_SENSOR"), Date.UTC(2026, 10, 27, 8));
    expect(soil.filter((reading: any) => reading.metric === "soilMoisture").map((reading: any) => reading.depthCm)).toEqual([10, 20, 30]);
    expect(soil.some((reading: any) => reading.metric === "water_meter")).toBe(false);

    const weather = stateFor("WEATHER_STATION");
    const temperatureAt = (at: number) => telemetryReadings(weather, at).find((reading: any) => reading.metric === "airTemperature").value;
    expect(temperatureAt(Date.UTC(2026, 10, 27, 7))).toBeGreaterThan(temperatureAt(Date.UTC(2026, 10, 26, 23)));
  });

  it("24 小时历史按 15 分钟对齐并覆盖 97 个采样点", () => {
    const now = Date.UTC(2026, 10, 27, 12, 7);
    const timestamps = historyTimestamps(now, 24, 15);
    expect(timestamps).toHaveLength(97);
    expect(timestamps[0]).toBe(Date.UTC(2026, 10, 26, 12));
    expect(timestamps.at(-1)).toBe(Date.UTC(2026, 10, 27, 12));
    expect(timestamps.every((at) => at % (15 * 60_000) === 0)).toBe(true);
  });

  it("累计水量随时间单调增加，未知类型直接报错", () => {
    const state = stateFor("IRRIGATION_PUMP");
    const values = [0, 8, 12, 18, 23].map((hour) => meterM3At(state, Date.UTC(2026, 10, 27, hour)));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(() => telemetryReadings(stateFor("UNKNOWN"), Date.UTC(2026, 10, 27, 8))).toThrow("尚未配置遥测模拟剖面");
  });
});
