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
// 乱序返回，验证时间轴按生育期目录排序
const growthRecords = [
  { id: "g-heading", plotCode: "P-1", stage: "heading", actualStartAt: "2026-07-04T16:00:00.000Z", actualEndAt: "2026-07-14T16:00:00.000Z", note: "", updatedAt: "2026-11-01T00:00:00Z" },
  { id: "g-tillering", plotCode: "P-1", stage: "tillering", plannedStartAt: "2026-06-09T16:00:00.000Z", actualStartAt: "2026-06-11T16:00:00.000Z", note: "实际偏晚", updatedAt: "2026-11-01T00:00:00Z" },
  { id: "g-seedling", plotCode: "P-1", stage: "seedling", plannedStartAt: "2026-05-20T16:00:00.000Z", note: "", updatedAt: "2026-11-01T00:00:00Z" },
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
  vi.spyOn(plotApi, "getList").mockResolvedValue({ items: plots, total: 1, page: 1, size: 200, pages: 1 } as any);
  vi.spyOn(telemetryApi, "getLatest").mockResolvedValue([] as any);
  const getHistorySeries = vi.spyOn(telemetryApi, "getHistorySeries").mockResolvedValue([] as any);
  const getGrowthStages = vi.spyOn(telemetryApi, "getGrowthStages").mockResolvedValue(growthRecords as any);
  const saveGrowthStage = vi.spyOn(telemetryApi, "saveGrowthStage").mockResolvedValue(growthRecords[1] as any);
  const deleteGrowthStage = vi.spyOn(telemetryApi, "deleteGrowthStage").mockResolvedValue(undefined as any);
  const getPests = vi.spyOn(telemetryApi, "getPests").mockResolvedValue([] as any);
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
  return { ...view, telemetryApi, getHistorySeries, getGrowthStages, saveGrowthStage, deleteGrowthStage, getPests, message };
}

describe("四情页苗情生育期档案", () => {
  it("默认按首个地块加载档案，时间轴按生育期目录排序并标注状态与提前滞后", async () => {
    const { state, getGrowthStages } = mountAgro();
    await flushView();
    // 苗情是默认页：挂载即按首个地块拉生育期
    expect(getGrowthStages).toHaveBeenCalledWith("P-1");
    const timeline = state.growthTimeline as Array<{ stage: string; label: string; status: string; deviation: string }>;
    expect(timeline.map((item) => item.stage)).toEqual(["seedling", "tillering", "heading"]);
    expect(timeline[0]).toMatchObject({ label: "出苗期", status: "pending" });
    expect(timeline[1]).toMatchObject({ label: "分蘖期", status: "active", deviation: "滞后 2 天" });
    expect(timeline[2]).toMatchObject({ label: "抽穗期", status: "done" });
  });

  it("登记按农场东八区日零点转 ISO，空节点省略", async () => {
    const { state, saveGrowthStage, getGrowthStages } = mountAgro();
    await flushView();
    getGrowthStages.mockClear();
    state.growthForm.plotCode = "P-1";
    state.growthForm.stage = "jointing";
    state.growthForm.plannedStart = "2026-06-26";
    state.growthForm.actualStart = "2026-06-28";
    await state.saveGrowth();
    expect(saveGrowthStage).toHaveBeenCalledWith({
      plotCode: "P-1",
      stage: "jointing",
      note: "",
      plannedStartAt: "2026-06-25T16:00:00.000Z",
      actualStartAt: "2026-06-27T16:00:00.000Z",
    });
    // 保存成功后刷新当前地块档案
    expect(getGrowthStages).toHaveBeenCalledWith("P-1");
  });

  it("编辑回填农场日历日，删除确认后调用接口，治理联动切到虫情页", async () => {
    const { state, deleteGrowthStage, getPests } = mountAgro();
    await flushView();
    state.openGrowthEdit(growthRecords[1]);
    expect(state.growthForm).toMatchObject({ id: "g-tillering", stage: "tillering", plannedStart: "2026-06-10", actualStart: "2026-06-12", note: "实际偏晚" });

    await state.removeGrowth(growthRecords[1]);
    expect(deleteGrowthStage).toHaveBeenCalledWith("g-tillering");

    state.goPestGovernance();
    await flushView();
    expect(state.activeTab).toBe("pest");
    expect(state.query.plotCode).toBe("P-1");
    expect(getPests).toHaveBeenCalledWith({ pendingOnly: true, plotCode: "P-1" });
  });
});