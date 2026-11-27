import { describe, expect, it } from "vitest";

import { detectQualityFlags } from "../src/quality.js";

const recordedAt = "2026-11-27T12:00:00.000Z";
const nowMs = Date.parse(recordedAt);

describe("遥测质量判定", () => {
  it("累计水量停机不变不判传感器卡死", () => {
    expect(detectQualityFlags({ metric: "water_meter", value: 128.5, recordedAt }, [128.5, 128.5, 128.5, 128.5], nowMs)).toEqual([]);
  });

  it("流量与转速停机为零是有效状态", () => {
    for (const metric of ["flowRate", "pumpSpeed", "rainfall", "lightIntensity"]) {
      expect(detectQualityFlags({ metric, value: 0, recordedAt }, [0, 0, 0, 0], nowMs), metric).toEqual([]);
    }
  });

  it("非零运行指标连续不变仍判卡死", () => {
    expect(detectQualityFlags({ metric: "flowRate", value: 10, recordedAt }, [10, 10, 10, 10], nowMs)).toContain("STUCK_VALUE");
  });
});
