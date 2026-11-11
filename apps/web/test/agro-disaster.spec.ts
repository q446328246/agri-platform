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

const plots = [{ parcelCode: "P-1", name: "示例地块" }];
const reportedRecord = {
  id: "d-1", disasterType: "drought", plotCode: "P-1", affectedAreaMu: 12.34, severity: 3,
  occurredAt: "2026-08-01T00:00:00.000Z", suggestion: "启动应急灌溉", status: "REPORTED",
  lossAssessment: "", imageFileIds: ["f1", "f2"], reportedBy: "巡查员甲", handledBy: "",
  createdAt: "2026-08-01T00:00:01.000Z", updatedAt: "2026-08-01T00:00:01.000Z",
};
const statsFixture = {
  total: 2, open: 2, affectedAreaMu: 17.34,
  byType: [{ disasterType: "drought", count: 1, affectedAreaMu: 12.34 }, { disasterType: "flood", count: 1, affectedAreaMu: 5 }],
  bySeverity: [{ severity: 2, count: 1 }, { severity: 3, count: 1 }],
};

function mountAgro() {
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { telemetryApi, plotApi, operationApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  vi.spyOn(telemetryApi, "getOverview").mockResolvedValue({ latest: [], alerts: [], pests: [], rules: [] } as any);
  vi.spyOn(plotApi, "getList").mockResolvedValue({ items: plots, total: 1, page: 1, size: 200, pages: 1 } as any);
  vi.spyOn(telemetryApi, "getLatest").mockResolvedValue([] as any);
  vi.spyOn(telemetryApi, "getHistorySeries").mockResolvedValue([] as any);
  vi.spyOn(telemetryApi, "getGrowthStages").mockResolvedValue([] as any);
  vi.spyOn(telemetryApi, "getPestStats").mockResolvedValue({ total: 0, pending: 0, byLevel: [], byType: [], byPlot: [] } as any);
  vi.spyOn(telemetryApi, "getPestTrend").mockResolvedValue([] as any);
  const getDisasters = vi.spyOn(telemetryApi, "getDisasters").mockResolvedValue([reportedRecord] as any);
  const getDisasterStats = vi.spyOn(telemetryApi, "getDisasterStats").mockResolvedValue(statsFixture as any);
  const createDisaster = vi.spyOn(telemetryApi, "createDisaster").mockResolvedValue({ ...reportedRecord, id: "d-new" } as any);
  const supplementDisaster = vi.spyOn(telemetryApi, "supplementDisaster").mockResolvedValue({ ...reportedRecord, status: "ASSESSED", handledBy: "农技员乙", handledAt: "2026-08-05T00:00:00Z" } as any);
  vi.spyOn(operationApi, "createTask").mockResolvedValue({ id: "t-x" } as any);
  const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
  const view = mountView(new URL("../src/views/agro/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: message, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } },
    "@/api": { telemetryApi, plotApi, operationApi },
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
  return { ...view, telemetryApi, getDisasters, getDisasterStats, createDisaster, supplementDisaster, message };
}

describe("四情页灾情档案", () => {
  it("按查询地块加载灾情档案与概览统计", async () => {
    const { state, getDisasters, getDisasterStats } = mountAgro();
    await flushView();
    state.query.plotCode = "P-1";
    await state.loadDisasters();
    expect(getDisasters).toHaveBeenCalledWith({ plotCode: "P-1" });
    expect(getDisasterStats).toHaveBeenCalledWith({ plotCode: "P-1" });
    expect(state.disasters).toHaveLength(1);
    expect(state.disasterStats).toMatchObject({ total: 2, open: 2 });
  });

  it("上报按农场东八区日零点转 ISO，影像逗号分隔转数组", async () => {
    const { state, createDisaster, getDisasters } = mountAgro();
    await flushView();
    state.openDisasterReport();
    state.disasterReportForm.disasterType = "flood";
    state.disasterReportForm.severity = 4;
    state.disasterReportForm.occurredDate = "2026-07-15";
    state.disasterReportForm.plotCode = "P-1";
    state.disasterReportForm.affectedAreaMu = 6.5;
    state.disasterReportForm.suggestion = "排水降渍";
    state.disasterReportForm.reportedBy = "张三";
    state.disasterReportForm.imageFileIds = "a, b , c";
    getDisasters.mockClear();
    await state.submitDisasterReport();
    expect(createDisaster).toHaveBeenCalledWith({
      disasterType: "flood", plotCode: "P-1", severity: 4, affectedAreaMu: 6.5,
      occurredAt: "2026-07-14T16:00:00.000Z", suggestion: "排水降渍", reportedBy: "张三",
      imageFileIds: ["a", "b", "c"],
    });
    expect(state.disasterReportVisible).toBe(false);
    expect(getDisasters).toHaveBeenCalled();
  });

  it("缺发生日期时拦截上报", async () => {
    const { state, createDisaster, message } = mountAgro();
    await flushView();
    state.openDisasterReport();
    state.disasterReportForm.occurredDate = "";
    await state.submitDisasterReport();
    expect(message.warning).toHaveBeenCalledWith("请选择灾情发生日期");
    expect(createDisaster).not.toHaveBeenCalled();
  });

  it("补充处置从当前状态开始只允许向前推进", async () => {
    const { state, supplementDisaster, getDisasters } = mountAgro();
    await flushView();
    state.openDisasterSupplement(reportedRecord);
    // REPORTED 的下一档默认 ASSESSED，可选档位不含回退项
    expect(state.disasterSupplementForm.status).toBe("ASSESSED");
    expect(state.disasterStatusOptions("REPORTED").map((item: { value: string }) => item.value)).toEqual(["REPORTED", "ASSESSED", "HANDLED", "ARCHIVED"]);
    expect(state.disasterStatusOptions("HANDLED").map((item: { value: string }) => item.value)).toEqual(["HANDLED", "ARCHIVED"]);
    state.disasterSupplementForm.handledBy = "农技员乙";
    state.disasterSupplementForm.lossAssessment = "减产一成";
    getDisasters.mockClear();
    await state.submitDisasterSupplement();
    expect(supplementDisaster).toHaveBeenCalledWith("d-1", {
      status: "ASSESSED", handledBy: "农技员乙", suggestion: "启动应急灌溉", lossAssessment: "减产一成", affectedAreaMu: 12.34,
    });
    expect(getDisasters).toHaveBeenCalled();
  });

  it("灾种/分级/状态标签映射完整", async () => {
    const { state } = mountAgro();
    await flushView();
    expect(state.disasterTypeLabel("drought")).toBe("干旱");
    expect(state.disasterTypeLabel("hail")).toBe("冰雹");
    expect(state.disasterSeverityLabel(4)).toBe("特别重大");
    expect(state.disasterStatusText("ASSESSED")).toBe("已核查");
    expect(state.disasterStatusTag("ARCHIVED")).toBe("success");
    expect(state.disasterSeverityTag(1)).toBe("info");
  });
});
