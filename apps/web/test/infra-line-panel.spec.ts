import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as types from "../src/types/index.js";
import * as infraLineUtils from "../src/utils/infraLine.js";
import * as permissionUtils from "../src/utils/permission.js";
import { evaluateTs, flushView, mountView } from "./view-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

function mountPanel(lines: any[], plots: any[]) {
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { plotApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const getInfraLines = vi.spyOn(plotApi, "getInfraLines").mockResolvedValue(lines as any);
  vi.spyOn(plotApi, "getList").mockResolvedValue({ items: plots, total: plots.length } as any);
  const view = mountView(new URL("../src/components/InfraLinePanel.vue", import.meta.url), {
    "@/api": { plotApi },
    "@/stores": { useUserStore: () => ({ permissions: [] }) },
    "@/utils/permission": permissionUtils,
    "@/utils/infraLine": infraLineUtils,
    "@/types": types,
  });
  cleanups.push(view.unmount);
  return { ...view, getInfraLines };
}

const LINE_P1 = { id: "1", lineCode: "LINE-1", lineName: "一号田灌溉管", lineType: "IRRIGATION_PIPE", lengthM: 300, plotCode: "P-1", geom: { coordinates: [[107.4, 30.9], [107.41, 30.91]] } };
const LINE_ORPHAN = { id: "2", lineCode: "LINE-2", lineName: "公共主干", lineType: "ELECTRIC_LINE", lengthM: 900, plotCode: "", geom: { coordinates: [[107.4, 30.9], [107.42, 30.9]] } };
const PLOTS = [{ parcelCode: "P-1", name: "东区一号田" }];

describe("管线列表地块联动", () => {
  it("加载全量管线与地块，归属地块列显示地块名", async () => {
    const { state } = mountPanel([LINE_P1, LINE_ORPHAN], PLOTS);
    await state.reload();
    await flushView();
    expect(state.plotName("P-1")).toBe("东区一号田");
    expect(state.plotName("")).toBe("未绑定地块");
    expect(state.plotName("P-9")).toBe("P-9");
  });

  it("按归属地块过滤只命中绑定该地块的管线", async () => {
    const { state } = mountPanel([LINE_P1, LINE_ORPHAN], PLOTS);
    await state.reload();
    await flushView();
    state.filterPlot = "P-1";
    expect(state.rows.map((row: any) => row.lineCode)).toEqual(["LINE-1"]);
  });

  it("选择“未绑定地块”筛出无归属管线", async () => {
    const { state } = mountPanel([LINE_P1, LINE_ORPHAN], PLOTS);
    await state.reload();
    await flushView();
    state.filterPlot = "__none__";
    expect(state.rows.map((row: any) => row.lineCode)).toEqual(["LINE-2"]);
  });

  it("重置清空地块过滤，恢复全部管线", async () => {
    const { state } = mountPanel([LINE_P1, LINE_ORPHAN], PLOTS);
    await state.reload();
    await flushView();
    state.filterPlot = "P-1";
    state.reset();
    await flushView();
    expect(state.filterPlot).toBe("");
    expect(state.rows).toHaveLength(2);
  });
});
