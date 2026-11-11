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

const season = (over: Record<string, unknown>) => ({
  seasonCode: "S", plotCode: "P-1", crop: "水稻", variety: "", seasonYear: 2026, seasonIndex: 1,
  plantDate: "", harvestDate: "", status: "planned", yieldKg: null, note: "", createdAt: "2026-01-01T00:00:00.000Z", ...over,
});

function mountSeason() {
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { plotApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const getList = vi.spyOn(plotApi, "getList").mockResolvedValue({
    items: [{ parcelCode: "P-1", name: "示范田一号" } as any], total: 1, page: 1, size: 200, pages: 1,
  } as any);
  const getSeasons = vi.spyOn(plotApi, "getSeasons").mockResolvedValue([] as any);
  const createSeason = vi.spyOn(plotApi, "createSeason").mockResolvedValue(season({}) as any);
  const updateSeason = vi.spyOn(plotApi, "updateSeason").mockResolvedValue(season({}) as any);
  const deleteSeason = vi.spyOn(plotApi, "deleteSeason").mockResolvedValue(undefined as any);
  const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
  const view = mountView(new URL("../src/views/plot/Season.vue", import.meta.url), {
    "element-plus": { ElMessage: message, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } },
    "@/api": { plotApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => true }) },
  });
  cleanups.push(view.unmount);
  return { ...view, getList, getSeasons, createSeason, updateSeason, deleteSeason, message };
}

describe("种植季/茬口档案页", () => {
  it("进入页面拉取地块选项与档案列表，作物下拉与状态标签口径一致", async () => {
    const { state, getList, getSeasons } = mountSeason();
    await flushView();
    expect(getList).toHaveBeenCalledTimes(1);
    expect(getSeasons).toHaveBeenCalledTimes(1);
    expect(state.plotOptions).toEqual([{ value: "P-1", label: "示范田一号（P-1）" }]);
    expect(state.seasonStatusText("harvested")).toBe("已采收");
    expect(state.seasonStatusType("growing")).toBe("warning");
    expect(state.seasonTimelineType("growing")).toBe("primary");
  });

  it("查询把地块/作物/年份/状态一并透传给接口", async () => {
    const { state, getSeasons } = mountSeason();
    await flushView();
    getSeasons.mockClear();
    state.query.plotCode = "P-1";
    state.query.crop = "稻";
    state.query.year = "2026";
    state.query.status = "growing";
    await state.search();
    expect(getSeasons).toHaveBeenCalledWith({ plotCode: "P-1", crop: "稻", year: "2026", status: "growing" });
  });

  it("选择地块后按轮作序列拉取，相邻同茬作物给出连作提示", async () => {
    const { state, getSeasons } = mountSeason();
    await flushView();
    getSeasons.mockResolvedValue([
      season({ seasonCode: "a", crop: "水稻", seasonYear: 2025, plantDate: "2025-05-01", harvestDate: "2025-09-01", status: "harvested" }),
      season({ seasonCode: "b", crop: "水稻", seasonYear: 2026, plantDate: "2026-05-01", status: "growing" }),
    ] as any);
    state.rotationPlot = "P-1";
    await state.onRotationPlot();
    expect(state.rotationRecords).toHaveLength(2);
    expect(state.rotationAdvice?.kind).toBe("warning");
    expect(state.rotationAdvice?.text).toContain("连作");
    expect(state.seasonPeriod(state.rotationRecords[0])).toBe("2025-05-01 至 2025-09-01");
  });

  it("新增提交裁剪作物并落到创建接口，随后刷新列表", async () => {
    const { state, createSeason, getSeasons, message } = mountSeason();
    await flushView();
    state.openCreate();
    state.formRef = { validate: async () => true, clearValidate: () => {} };
    state.form.plotCode = "P-1";
    state.form.crop = " 油菜 ";
    state.form.seasonYear = 2025;
    state.form.seasonIndex = 2;
    getSeasons.mockResolvedValue([] as any);
    await state.submit();
    expect(createSeason).toHaveBeenCalledTimes(1);
    expect(createSeason.mock.calls[0][0]).toMatchObject({ plotCode: "P-1", crop: "油菜", seasonYear: 2025, seasonIndex: 2, status: "planned" });
    expect(message.success).toHaveBeenCalled();
  });

  it("采收早于栽插被前端拦截，不发起写请求", async () => {
    const { state, createSeason, message } = mountSeason();
    await flushView();
    state.openCreate();
    state.formRef = { validate: async () => true, clearValidate: () => {} };
    state.form.plotCode = "P-1";
    state.form.crop = "小麦";
    state.form.plantDate = "2026-06-01";
    state.form.harvestDate = "2026-05-01";
    await state.submit();
    expect(createSeason).not.toHaveBeenCalled();
    expect(message.error).toHaveBeenCalled();
  });
});
