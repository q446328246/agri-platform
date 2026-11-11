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

const globalRule = { id: "rule-soil-moisture", metric: "soilMoisture", plotCode: "", direction: "below", threshold: 30, level: "WARNING", message: "土壤含水率低于灌溉阈值", enabled: true, updatedAt: "2026-11-01T00:00:00Z" };
const plotRule = { id: "rule-soil-moisture-P-1-CRITICAL", metric: "soilMoisture", plotCode: "P-1", direction: "below", threshold: 20, level: "CRITICAL", message: "地块严重缺水", enabled: true, updatedAt: "2026-11-01T00:00:00Z" };

function mountAgro() {
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { telemetryApi, plotApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  vi.spyOn(telemetryApi, "getOverview").mockResolvedValue({ latest: [], alerts: [], pests: [], rules: [globalRule, plotRule] } as any);
  vi.spyOn(plotApi, "getList").mockResolvedValue({ items: [{ parcelCode: "P-1", name: "东区一号田" }], total: 1, page: 1, size: 200, pages: 1 } as any);
  // 苗情是默认页，挂载即加载生育期档案与长势曲线，桩掉以免污染阈值用例
  vi.spyOn(telemetryApi, "getGrowthStages").mockResolvedValue([] as any);
  vi.spyOn(telemetryApi, "getHistorySeries").mockResolvedValue([] as any);
  const saveRule = vi.spyOn(telemetryApi, "saveRule").mockResolvedValue(plotRule as any);
  const deleteRule = vi.spyOn(telemetryApi, "deleteRule").mockResolvedValue(undefined as any);
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
  return { ...view, telemetryApi, saveRule, deleteRule, message };
}

describe("四情页地块分级阈值管理", () => {
  it("编辑回填地块，保存携带 plotCode 与级别", async () => {
    const { state, saveRule } = mountAgro();
    await flushView();
    state.openRuleEdit(plotRule as any);
    expect(state.ruleForm.plotCode).toBe("P-1");
    expect(state.ruleForm.level).toBe("CRITICAL");
    await state.saveRule();
    expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({ metric: "soilMoisture", plotCode: "P-1", level: "CRITICAL", threshold: 20 }));
  });

  it("新建撞 (指标,地块,级别) 唯一键时拦截，不同级别放行", async () => {
    const { state, saveRule, message } = mountAgro();
    await flushView();
    state.openRuleCreate();
    state.ruleForm.metric = "soilMoisture";
    state.ruleForm.plotCode = "P-1";
    state.ruleForm.level = "CRITICAL"; // 与 plotRule 同键
    await state.saveRule();
    expect(saveRule).not.toHaveBeenCalled();
    expect(message.warning).toHaveBeenCalled();

    state.ruleForm.level = "INFO"; // 同指标同地块不同级别，允许新建
    await state.saveRule();
    expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({ plotCode: "P-1", level: "INFO" }));
  });

  it("删除按地块与级别精确下发，启用切换携带地块", async () => {
    const { state, deleteRule, saveRule } = mountAgro();
    await flushView();
    await state.removeRule(plotRule as any);
    expect(deleteRule).toHaveBeenCalledWith("soilMoisture", "P-1", "CRITICAL");

    saveRule.mockClear();
    await state.toggleRule(globalRule as any, false);
    expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({ metric: "soilMoisture", plotCode: "", enabled: false }));
  });

  it("地块下拉来自地块服务，级别文案为提示/预警/告警", async () => {
    const { state } = mountAgro();
    await flushView();
    expect(state.plotOptions).toEqual([{ parcelCode: "P-1", parcelName: "东区一号田" }]);
    expect(state.ruleLevelText("INFO")).toBe("提示");
    expect(state.ruleLevelText("WARNING")).toBe("预警");
    expect(state.ruleLevelText("CRITICAL")).toBe("告警");
  });
});