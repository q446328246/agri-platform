import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as types from "../src/types/index.js";
import { evaluateTs, flushView, mountView } from "./view-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const soilReadings = [
  { deviceId: "device-soil-009", plotCode: "P-1", metric: "soilMoisture", value: 22, unit: "%", recordedAt: "2026-11-01T02:00:00Z", depthCm: 20 },
  { deviceId: "device-soil-009", plotCode: "P-1", metric: "soilMoisture", value: 48, unit: "%", recordedAt: "2026-11-01T02:00:00Z", depthCm: 60 },
  { deviceId: "device-soil-009", plotCode: "P-1", metric: "soilTemperature", value: 18, unit: "°C", recordedAt: "2026-11-01T02:00:00Z", depthCm: 20 },
  { deviceId: "device-soil-009", plotCode: "P-1", metric: "airTemperature", value: 30, unit: "°C", recordedAt: "2026-11-01T02:00:00Z" },
];
const historyPoints = [
  { recordedAt: "2026-11-01T01:00:00Z", value: 35 },
  { recordedAt: "2026-11-01T02:00:00Z", value: 22 },
];

function mountAgro() {
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { telemetryApi, plotApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  vi.spyOn(telemetryApi, "getOverview").mockResolvedValue({ latest: [], alerts: [], pests: [], rules: [] } as any);
  vi.spyOn(plotApi, "getList").mockResolvedValue({ items: [], total: 0, page: 1, size: 1, pages: 0 } as any);
  const getLatest = vi.spyOn(telemetryApi, "getLatest").mockResolvedValue(soilReadings as any);
  const getHistorySeries = vi.spyOn(telemetryApi, "getHistorySeries").mockResolvedValue(historyPoints as any);
  const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
  const view = mountView(new URL("../src/views/agro/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: message, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } },
    "@/api": { telemetryApi, plotApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => true }) },
    "@/utils": { formatDateTime: (value: string) => value },
    "@/types": types,
    "vue-echarts": { name: "VChart", render: () => null },
    "echarts/core": { use: () => {} },
    "echarts/renderers": { CanvasRenderer: {} },
    "echarts/charts": { LineChart: {} },
    "echarts/components": { TooltipComponent: {}, LegendComponent: {}, GridComponent: {} },
  });
  cleanups.push(view.unmount);
  return { ...view, telemetryApi, getLatest, getHistorySeries, message };
}

describe("四情页土壤墒情分层", () => {
  it("切到土壤页按地块拉分层读数，深度列由数据推导并按地块+指标分组", async () => {
    const { state, getLatest } = mountAgro();
    await flushView();
    // 挂载只拉总览，不拉土壤
    expect(getLatest).not.toHaveBeenCalled();

    state.query.plotCode = "P-1";
    state.onTabChange("soil");
    await flushView();
    expect(getLatest).toHaveBeenCalledWith({ plotCode: "P-1" });
    // 空气温度不属于土壤指标，被过滤
    expect(state.soilLatest).toHaveLength(3);
    expect(state.soilDepthColumns).toEqual([{ value: 20, label: "20cm" }, { value: 60, label: "60cm" }]);
    expect(state.soilRows).toHaveLength(2);
    const moisture = state.soilRows.find((row: { label: string }) => row.label === "土壤湿度");
    expect(moisture.depths).toEqual({ 20: 22, 60: 48 });
    // 历史深度默认落到第一个分层
    expect(state.soilHistoryDepth).toBe(20);
  });

  it("历史曲线把深度与农场东八区时间窗传给后端", async () => {
    const { state, getHistorySeries } = mountAgro();
    await flushView();
    state.query.plotCode = "P-1";
    state.onTabChange("soil");
    await flushView();
    getHistorySeries.mockClear();

    state.soilMetric = "soilMoisture";
    state.soilHistoryDepth = 60;
    state.soilRange = ["2026-11-01", "2026-11-05"];
    await state.loadSoilHistory();
    expect(getHistorySeries).toHaveBeenCalledWith("", "soilMoisture", {
      plotCode: "P-1",
      depthCm: 60,
      from: "2026-10-31T16:00:00.000Z",
      to: "2026-11-05T15:59:59.999Z",
      size: 500,
    });
    expect(state.soilHistoryLoaded).toBe(true);
    expect(state.soilValues).toEqual([35, 22]);
  });

  it("深度筛选只点亮对应列，未分层读数归入 -1 列", async () => {
    const { state } = mountAgro();
    await flushView();
    state.onTabChange("soil");
    await flushView();
    const moisture = state.soilRows.find((row: { label: string }) => row.label === "土壤湿度");
    expect(state.soilCell(moisture, 20)).toBe("22");
    expect(state.soilCell(moisture, 60)).toBe("48");
    state.soilDepthFilter = 60;
    expect(state.soilCell(moisture, 20)).toBe("—");
    expect(state.soilCell(moisture, 60)).toBe("48");

    // 追加一条未分层读数，应出现 -1「未分层」列
    state.soilLatest = [...state.soilLatest, { deviceId: "d", plotCode: "P-1", metric: "soilPh", value: 6.5, unit: "", recordedAt: "2026-11-01T03:00:00Z" }];
    await flushView();
    expect(state.soilDepthColumns.some((column: { value: number }) => column.value === -1)).toBe(true);
  });
});