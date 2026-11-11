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
const stats = {
  total: 12,
  pending: 5,
  byLevel: [{ level: 1, count: 2 }, { level: 2, count: 7 }, { level: 3, count: 3 }],
  byType: [{ pestType: "稻飞虱", count: 8 }, { pestType: "二化螟", count: 4 }],
  byPlot: [{ plotCode: "P-1", count: 12 }],
};
const trend = [
  { date: "2026-10-28", count: 0 },
  { date: "2026-10-29", count: 3 },
  { date: "2026-10-30", count: 1 },
];
const pendingEvent = {
  id: "pest-1", plotCode: "P-1", deviceId: "camera-001", pestType: "稻飞虱", level: 2, confidence: 0.9,
  detectedAt: "2026-10-30T02:00:00.000Z", handled: false, governanceStatus: "pending",
  measure: "", pesticide: "", dosage: "", dispatchNote: "", governedBy: "",
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
  const getPests = vi.spyOn(telemetryApi, "getPests").mockResolvedValue([pendingEvent] as any);
  const getPestStats = vi.spyOn(telemetryApi, "getPestStats").mockResolvedValue(stats as any);
  const getPestTrend = vi.spyOn(telemetryApi, "getPestTrend").mockResolvedValue(trend as any);
  const governPest = vi.spyOn(telemetryApi, "governPest").mockResolvedValue({ ...pendingEvent, governanceStatus: "dispatched" } as any);
  const createTask = vi.spyOn(operationApi, "createTask").mockResolvedValue({ id: "task-x", name: "稻飞虱喷防作业" } as any);
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
  return { ...view, telemetryApi, getPests, getPestStats, getPestTrend, governPest, createTask, message };
}

describe("四情页虫情统计与治理派单", () => {
  it("按查询地块加载区域统计与逐日趋势", async () => {
    const { state, getPestStats, getPestTrend } = mountAgro();
    await flushView();
    state.query.plotCode = "P-1";
    state.query.pestType = "稻飞虱";
    await state.loadPestAnalytics();
    expect(getPestStats).toHaveBeenCalledWith({ plotCode: "P-1", pestType: "稻飞虱" });
    expect(getPestTrend).toHaveBeenCalledWith({ days: 14, plotCode: "P-1", pestType: "稻飞虱" });
    expect(state.pestStats).toMatchObject({ total: 12, pending: 5 });
    // 趋势按农场日历日渲染，日期截去前缀年
    const option = state.pestTrendChartOption as { xAxis: { data: string[] }, series: Array<{ data: number[] }> };
    expect(option.xAxis.data).toEqual(["10-28", "10-29", "10-30"]);
    expect(option.series[0].data).toEqual([0, 3, 1]);
  });

  it("勾选派单时先建植保喷防任务再回写已派单状态与任务 id", async () => {
    const { state, createTask, governPest, getPests } = mountAgro();
    await flushView();
    state.openPestGovern(pendingEvent);
    expect(state.pestGovernForm).toMatchObject({ id: "pest-1", pestType: "稻飞虱", plotCode: "P-1", status: "planned", dispatch: false });
    state.pestGovernForm.measure = "喷施吡蚜酮";
    state.pestGovernForm.pesticide = "吡蚜酮";
    state.pestGovernForm.dosage = "20g/亩";
    state.pestGovernForm.dispatchNote = "上午无风时段作业";
    state.pestGovernForm.governedBy = "张三";
    state.pestGovernForm.dispatch = true;
    getPests.mockClear();
    await state.submitPestGovern();
    expect(createTask).toHaveBeenCalledWith({ type: "SPRAYING", name: "稻飞虱喷防作业", plotCode: "P-1", assigneeName: "张三" });
    expect(governPest).toHaveBeenCalledWith("pest-1", {
      status: "dispatched", measure: "喷施吡蚜酮", pesticide: "吡蚜酮", dosage: "20g/亩",
      dispatchNote: "上午无风时段作业", governedBy: "张三", taskId: "task-x",
    });
    expect(state.pestGovernVisible).toBe(false);
    // 提交成功后刷新列表与统计
    expect(getPests).toHaveBeenCalled();
  });

  it("不派单时仅登记治理方案，不生成农事任务", async () => {
    const { state, createTask, governPest } = mountAgro();
    await flushView();
    state.openPestGovern(pendingEvent);
    state.pestGovernForm.measure = "田间排水降湿";
    state.pestGovernForm.status = "archived";
    await state.submitPestGovern();
    expect(createTask).not.toHaveBeenCalled();
    expect(governPest).toHaveBeenCalledWith("pest-1", { status: "archived", measure: "田间排水降湿", pesticide: "", dosage: "", dispatchNote: "" });
  });

  it("缺治理措施时拦截提交并提示", async () => {
    const { state, governPest, message } = mountAgro();
    await flushView();
    state.openPestGovern(pendingEvent);
    state.pestGovernForm.measure = "  ";
    await state.submitPestGovern();
    expect(message.warning).toHaveBeenCalledWith("请填写治理措施");
    expect(governPest).not.toHaveBeenCalled();
  });

  it("治理状态文本与标签映射", async () => {
    const { state } = mountAgro();
    await flushView();
    expect(state.governanceText("pending")).toBe("待处置");
    expect(state.governanceText("planned")).toBe("已定方案");
    expect(state.governanceText("dispatched")).toBe("已派单");
    expect(state.governanceText("archived")).toBe("已归档");
    expect(state.governanceTag("dispatched")).toBe("warning");
    expect(state.governanceTag("archived")).toBe("success");
  });
});
