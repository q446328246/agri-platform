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

const reportFixture = {
  months: [
    { month: "2026-01", input: 100, output: 300, profit: 200 },
    { month: "2026-02", input: 60, output: 0, profit: -60 },
  ],
  categories: [
    { kind: "OUTPUT" as const, category: "稻谷销售", amount: 300 },
    { kind: "INPUT" as const, category: "SEED", amount: 160 },
  ],
  plots: [
    { plotCode: "P-1", input: 100, output: 300, profit: 200 },
    { plotCode: "P-2", input: 60, output: 0, profit: -60 },
  ],
};

function mountFinance() {
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { financeApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const getEntries = vi.spyOn(financeApi, "getEntries").mockResolvedValue([] as any);
  const getSummary = vi.spyOn(financeApi, "getSummary").mockResolvedValue({ input: 160, output: 300, profit: 140, currency: "CNY" } as any);
  const getReport = vi.spyOn(financeApi, "getReport").mockResolvedValue(reportFixture as any);
  const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
  const view = mountView(new URL("../src/views/finance/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: message, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } },
    "@/api": { financeApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => true }) },
    "@/utils": { formatDateTime: (value: string) => value },
    "vue-echarts": { name: "VChart", render: () => null },
    "echarts/core": { use: () => {} },
    "echarts/renderers": { CanvasRenderer: {} },
    "echarts/charts": { BarChart: {}, LineChart: {}, PieChart: {} },
    "echarts/components": { TooltipComponent: {}, LegendComponent: {}, GridComponent: {} },
  });
  cleanups.push(view.unmount);
  return { ...view, getEntries, getSummary, getReport, message };
}

describe("财务核算报表", () => {
  it("进入页面即拉取列表、汇总与报表三份同筛选数据", async () => {
    const { getEntries, getSummary, getReport, state } = mountFinance();
    await flushView();
    expect(getEntries).toHaveBeenCalledTimes(1);
    expect(getSummary).toHaveBeenCalledTimes(1);
    expect(getReport).toHaveBeenCalledTimes(1);
    expect(state.report).toMatchObject(reportFixture);
  });

  it("月度图按月份轴排布，投入产出为柱、利润为线", async () => {
    const { state } = mountFinance();
    await flushView();
    const option = state.monthChartOption as any;
    expect(option.xAxis.data).toEqual(["2026-01", "2026-02"]);
    expect(option.series.map((s: any) => [s.name, s.type])).toEqual([["投入", "bar"], ["产出", "bar"], ["利润", "line"]]);
    expect(option.series[2].data).toEqual([200, -60]);
  });

  it("类别构成与地块利润排行分别取类别金额与地块利润", async () => {
    const { state } = mountFinance();
    await flushView();
    const pie = state.categoryChartOption as any;
    expect(pie.series[0].data.map((d: any) => d.name)).toEqual(["产出·稻谷销售", "投入·SEED"]);
    const bar = state.plotChartOption as any;
    expect(bar.yAxis.data).toEqual(["P-2", "P-1"]);
    expect(bar.series[0].data).toEqual([-60, 200]);
  });

  it("查询走同一套筛选条件，报表随查询刷新", async () => {
    const { state, getReport } = mountFinance();
    await flushView();
    getReport.mockClear();
    state.query.plotCode = "P-1";
    await state.search();
    expect(getReport).toHaveBeenCalledTimes(1);
    expect(getReport).toHaveBeenCalledWith(expect.objectContaining({ plotCode: "P-1" }));
  });
});
