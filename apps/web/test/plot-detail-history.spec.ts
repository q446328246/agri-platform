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

const basePlot = {
  id: "internal-uuid", parcelCode: "片区/东 01", name: "东一号", regionName: "开江", villageName: "任市",
  type: "FIELD", status: "ACTIVE", areaMu: 12.5, gridCode: "G-1", soilType: "PADDY_SOIL", currentCrop: "水稻",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z",
};

function mountDetail(history: unknown, historyImpl?: (code: string) => Promise<unknown>) {
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { plotApi, operationApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  vi.spyOn(plotApi, "getById").mockResolvedValue(basePlot as any);
  vi.spyOn(operationApi, "getTasks").mockResolvedValue({ items: [], total: 0, page: 1, size: 50, pages: 0 } as any);
  const getHistory = vi.spyOn(plotApi, "getHistory").mockImplementation(historyImpl ?? (() => Promise.resolve(history)));
  const view = mountView(new URL("../src/views/plot/Detail.vue", import.meta.url), {
    "vue-router": { useRoute: () => ({ params: { id: "internal-uuid" } }), useRouter: () => ({ back: vi.fn(), push: vi.fn() }) },
    "@/api": { plotApi, operationApi },
    "@/components/PlotBoundaryMap.vue": { name: "PlotBoundaryMap", render: () => null },
    "@/utils": {
      formatDateTime: (value: unknown) => String(value),
      formatArea: (value: number) => `${value} 亩`,
      getPlotStatusText: () => "种植中",
      getPlotStatusType: () => "success",
      getPlotTypeText: () => "大田",
      getSoilTypeText: () => "水稻土",
      getTaskStatusText: () => "",
      getTaskStatusType: () => "info",
    },
  });
  cleanups.push(view.unmount);
  return { ...view, getHistory };
}

describe("地块详情变更历史", () => {
  it("按地块编码拉取历史，映射动作标签与颜色", async () => {
    const { state, getHistory } = mountDetail([
      { id: "l3", parcelCode: "片区/东 01", action: "DELETE", summary: "删除：已归档移除", actor: "u-3", createdAt: "2026-06-01T00:00:00.000Z" },
      { id: "l2", parcelCode: "片区/东 01", action: "UPDATE", summary: "修改：边界", actor: "u-2", createdAt: "2026-03-01T00:00:00.000Z" },
      { id: "l1", parcelCode: "片区/东 01", action: "CREATE", summary: "建档：新增地块", actor: "u-1", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await flushView();
    // 用档案编码（含斜杠需编码）而非路由内部 id 请求历史
    expect(getHistory).toHaveBeenCalledWith("片区/东 01");
    expect(state.changeLogs).toHaveLength(3);
    expect(state.changeActionText("CREATE")).toBe("建档");
    expect(state.changeActionText("UPDATE")).toBe("修改");
    expect(state.changeActionText("DELETE")).toBe("删除");
    expect(state.changeActionType("CREATE")).toBe("primary");
    expect(state.changeActionType("UPDATE")).toBe("warning");
    expect(state.changeActionType("DELETE")).toBe("danger");
  });

  it("历史接口失败时仍显示档案，历史退回空态不阻断", async () => {
    const { state } = mountDetail(undefined, () => Promise.reject(new Error("network")));
    await flushView();
    expect(state.plotData).toMatchObject({ parcelCode: "片区/东 01" });
    expect(state.changeLogs).toEqual([]);
  });

  it("无历史时保持空数组供空态提示", async () => {
    const { state, getHistory } = mountDetail([]);
    await flushView();
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(state.changeLogs).toEqual([]);
  });
});
