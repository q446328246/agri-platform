import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as types from "../src/types/index.js";
import { parsePlotBoundaries } from "../src/utils/geo.js";
import { deferred, evaluateTs, flushView, mountView, TestNode } from "./view-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function messages() {
  return { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
}

function mountPlot() {
  const del = vi.fn().mockResolvedValue(undefined);
  // 编译真实 API 模块，仅替换 HTTP 边界，不改根 Vitest 的别名配置。
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { plotApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { del, get: vi.fn(), post: vi.fn(), put: vi.fn() },
  });
  const getList = vi.spyOn(plotApi, "getList").mockResolvedValue({ items: [], total: 0 });
  const confirm = vi.fn().mockResolvedValue("confirm");
  const message = messages();
  const view = mountView(new URL("../src/views/plot/List.vue", import.meta.url), {
    "vue-router": { useRouter: () => ({ push: vi.fn() }) },
    "element-plus": { ElMessage: message, ElMessageBox: { confirm } },
    "@/api": { plotApi }, "@/types": types,
    "@/utils": { formatDateTime: vi.fn() }, "@/utils/export": { exportCsv: vi.fn() },
  });
  cleanups.push(view.unmount);
  return { ...view, plotApi, del, getList, confirm, message };
}

const selectedPlots = [
  { id: "uuid-1", parcelCode: "511723-000001-01-00001" },
  { id: "uuid-2", parcelCode: "片区/A 02" },
];

describe("地块批量删除回归", () => {
  it("将所选 parcelCode 而非内部 id 发到删除 URL，并确认数量、刷新列表", async () => {
    const { state, del, getList, confirm, message } = mountPlot();
    await flushView();
    state.handleSelectionChange(selectedPlots);
    expect(state.selectedCodes).toEqual(selectedPlots.map((plot) => plot.parcelCode));
    await state.handleBatchDelete();
    expect(confirm.mock.calls[0]?.[0]).toContain("2 个地块");
    expect(del.mock.calls.map(([url]) => url)).toEqual(selectedPlots.map((plot) => `/plots/${encodeURIComponent(plot.parcelCode)}`));
    expect(message.success).toHaveBeenCalledWith("批量删除成功，共 2 个地块");
    expect(getList).toHaveBeenCalledTimes(2);
    expect(state.selectedCodes).toEqual([]);
    expect(state.selectedRows).toEqual([]);
    expect(state.deleting).toBe(false);
  });

  it("确认期间选择变化不改变将要删除的批次，重复点击不重复提交", async () => {
    const { state, del, confirm } = mountPlot();
    await flushView();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    state.handleSelectionChange(selectedPlots);
    const pending = state.handleBatchDelete();
    state.handleSelectionChange([{ id: "other-id", parcelCode: "OTHER" }]);
    await state.handleBatchDelete();
    expect(confirm).toHaveBeenCalledTimes(1);
    approval.resolve("confirm");
    await pending;
    expect(del.mock.calls.map(([url]) => url)).toEqual(selectedPlots.map((plot) => `/plots/${encodeURIComponent(plot.parcelCode)}`));
  });

  it.each(["cancel", "close"])("%s 确认框时不删除、不刷新、不提示失败", async (action) => {
    const { state, del, getList, confirm, message } = mountPlot();
    await flushView();
    state.handleSelectionChange(selectedPlots);
    confirm.mockRejectedValue(action);
    await state.handleBatchDelete();
    expect(del).not.toHaveBeenCalled();
    expect(getList).toHaveBeenCalledTimes(1);
    expect(message.error).not.toHaveBeenCalled();
    expect(state.selectedCodes).toHaveLength(2);
    expect(state.deleting).toBe(false);
  });

  it("部分失败等待剩余删除完成才刷新，并明确失败编码而非提示整批成功", async () => {
    const { state, del, getList, message } = mountPlot();
    await flushView();
    const slowDelete = deferred<void>();
    del.mockImplementation((url: string) => url.includes("00001") ? slowDelete.promise : Promise.reject(new Error("conflict")));
    state.handleSelectionChange(selectedPlots);
    const pending = state.handleBatchDelete();
    await flushView();
    expect(del).toHaveBeenCalledTimes(2);
    expect(getList).toHaveBeenCalledTimes(1);
    expect(message.warning).not.toHaveBeenCalled();
    slowDelete.resolve();
    await pending;
    expect(getList).toHaveBeenCalledTimes(2);
    expect(message.success).not.toHaveBeenCalled();
    expect(message.warning).toHaveBeenCalledWith(expect.stringContaining("成功删除 1 个地块，失败 1 个（片区/A 02）"));
    expect(state.selectedCodes).toEqual([]);
  });

  it("全部失败与意外拒绝均反馈失败、刷新且不显示成功", async () => {
    const { state, del, plotApi, getList, message } = mountPlot();
    await flushView();
    del.mockRejectedValue(new Error("conflict"));
    state.handleSelectionChange(selectedPlots);
    await state.handleBatchDelete();
    expect(message.error).toHaveBeenCalledWith(expect.stringContaining("成功删除 0 个地块，失败 2 个"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(plotApi, "batchDelete").mockRejectedValue(new Error("unexpected"));
    state.handleSelectionChange(selectedPlots);
    await state.handleBatchDelete();
    expect(message.error).toHaveBeenLastCalledWith(expect.stringContaining("部分地块可能已删除"));
    expect(message.success).not.toHaveBeenCalled();
    expect(getList).toHaveBeenCalledTimes(3);
  });

  it("空选择不弹确认或发删除请求", async () => {
    const { state, del, confirm } = mountPlot();
    await state.handleBatchDelete();
    expect(confirm).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});

const geom = { type: "Polygon", coordinates: [[[107.4, 30.9], [107.41, 30.9], [107.41, 30.91], [107.4, 30.9]]], srid: 4490 };
function zone(code: string, name = code, hull: unknown = geom) {
  return { zoneCode: code, zoneName: name, color: "#00d4ff", plotCount: 0, areaMu: 0, hull };
}
function plot(code: string, name = code) {
  return { id: `uuid-${code}`, parcelCode: code, name, areaMu: 2, geom };
}

function leafletMock() {
  const maps: any[] = [];
  const tiles: any[] = [];
  const groups: any[] = [];
  const polygons: any[] = [];
  const leaflet = {
    map: vi.fn((element: TestNode) => {
      const map = {
        getContainer: () => element,
        invalidateSize: vi.fn(), fitBounds: vi.fn(), setView: vi.fn(),
        removeLayer: vi.fn(), remove: vi.fn(),
      };
      maps.push(map);
      return map;
    }),
    tileLayer: vi.fn(() => {
      const tile = { addTo: vi.fn().mockReturnThis(), remove: vi.fn() };
      tiles.push(tile);
      return tile;
    }),
    layerGroup: vi.fn(() => {
      const group = { addTo: vi.fn().mockReturnThis(), clearLayers: vi.fn() };
      groups.push(group);
      return group;
    }),
    latLngBounds: () => {
      const points: unknown[] = [];
      return { extend: (point: unknown) => points.push(point), isValid: () => points.length > 0 };
    },
    polygon: vi.fn((ring: unknown, options: unknown) => {
      const polygon = { ring, options, bindTooltip: vi.fn().mockReturnThis(), addTo: vi.fn().mockReturnThis() };
      polygons.push(polygon);
      return polygon;
    }),
  };
  return { leaflet, maps, tiles, groups, polygons };
}

function mountZone(initialZones: ReturnType<typeof zone>[] | Promise<ReturnType<typeof zone>[]>) {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new TestNode(tag),
    createTextNode: (text: string) => new TestNode("#text", text),
  });
  const zoneApi = {
    getMap: vi.fn().mockResolvedValue(initialZones),
    getDetail: vi.fn().mockImplementation(async (code: string) => ({ ...zone(code), plots: [] })),
    create: vi.fn().mockResolvedValue(zone("NEW")),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const leaflet = leafletMock();
  const view = mountView(new URL("../src/views/zone/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: messages() }, leaflet: leaflet.leaflet,
    "@/api": { zoneApi, plotApi: { getList: vi.fn().mockResolvedValue({ items: [] }) } },
    "@/utils/geo": { parsePlotBoundaries },
  });
  cleanups.push(view.unmount);
  return { ...view, zoneApi, ...leaflet };
}

describe("片区地图生命周期与异步详情回归", () => {
  it("mounted 时无容器，异步列表到达后创建地图、双底图并校正尺寸", async () => {
    const initial = deferred<ReturnType<typeof zone>[]>();
    const { state, maps, tiles, zoneApi } = mountZone(initial.promise);
    expect(state.mapEl).toBeNull();
    expect(maps).toHaveLength(0);
    initial.resolve([zone("A")]);
    await flushView();
    expect(zoneApi.getDetail).toHaveBeenCalledWith("A");
    expect(maps).toHaveLength(1);
    expect(maps[0].getContainer()).toBe(state.mapEl);
    expect(tiles).toHaveLength(2);
    tiles.forEach((tile) => expect(tile.addTo).toHaveBeenCalledWith(maps[0]));
    expect(maps[0].invalidateSize).toHaveBeenCalledWith({ pan: false });
    expect(maps[0].fitBounds).toHaveBeenCalled();
  });

  it("空列表再新建可初始化；删除最后片区销毁，再新建不复用失效容器", async () => {
    const { state, zoneApi, maps, tiles, groups } = mountZone([]);
    await flushView();
    expect(maps).toHaveLength(0);
    state.openCreate();
    state.form.zoneName = "新片区";
    zoneApi.getMap.mockResolvedValue([zone("NEW", "新片区", null)]);
    await state.submitForm();
    await flushView();
    expect(maps).toHaveLength(1);
    expect(maps[0].setView).toHaveBeenCalledWith([30.982425, 107.421325], 15);
    const firstContainer = state.mapEl;
    const firstGroups = [...groups];
    zoneApi.getMap.mockResolvedValue([]);
    await state.removeZone();
    await flushView();
    expect(state.mapEl).toBeNull();
    expect(maps[0].remove).toHaveBeenCalledTimes(1);
    tiles.forEach((tile) => expect(tile.remove).toHaveBeenCalledTimes(1));
    firstGroups.forEach((group) => expect(group.clearLayers).toHaveBeenCalled());
    zoneApi.getMap.mockResolvedValue([zone("NEW")]);
    state.openCreate();
    state.form.zoneName = "重建片区";
    await state.submitForm();
    await flushView();
    expect(maps).toHaveLength(2);
    expect(state.mapEl).not.toBe(firstContainer);
    expect(maps[1].getContainer()).toBe(state.mapEl);
  });

  it("切换复用有效容器但清除旧图层，详情乱序不把 A 成员画到 B", async () => {
    const { state, zoneApi, maps, groups } = mountZone([zone("A"), zone("B")]);
    await flushView();
    const a = deferred<any>();
    const b = deferred<any>();
    zoneApi.getDetail.mockImplementation((code) => code === "A" ? a.promise : b.promise);
    const pendingA = state.selectZone("A");
    await flushView();
    const previousLayer = groups.at(-1);
    const pendingB = state.selectZone("B");
    await flushView();
    expect(previousLayer.clearLayers).toHaveBeenCalled();
    expect(maps[0].removeLayer).toHaveBeenCalledWith(previousLayer);
    expect(state.members).toEqual([]);
    b.resolve({ plots: [plot("B-plot")] });
    await pendingB;
    await flushView();
    const count = groups.length;
    a.resolve({ plots: [plot("A-plot")] });
    await pendingA;
    await flushView();
    expect(state.activeCode).toBe("B");
    expect(state.members.map((item: any) => item.parcelCode)).toEqual(["B-plot"]);
    expect(groups).toHaveLength(count);
    expect(maps).toHaveLength(1);
    expect(maps[0].remove).not.toHaveBeenCalled();
  });

  it("A→B→A 时同编码旧请求也不能覆盖最新详情", async () => {
    const { state, zoneApi } = mountZone([zone("A"), zone("B")]);
    await flushView();
    const oldA = deferred<any>();
    const middleB = deferred<any>();
    const newA = deferred<any>();
    zoneApi.getDetail.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(middleB.promise).mockReturnValueOnce(newA.promise);
    const first = state.selectZone("A");
    const second = state.selectZone("B");
    const third = state.selectZone("A");
    newA.resolve({ plots: [plot("latest-A")] });
    await third;
    middleB.resolve({ plots: [plot("stale-B")] });
    oldA.resolve({ plots: [plot("stale-A")] });
    await Promise.all([first, second]);
    await flushView();
    expect(state.members.map((item: any) => item.parcelCode)).toEqual(["latest-A"]);
  });

  it("删除当前片区选择剩余片区，忽略删除前未完成的详情请求", async () => {
    const { state, zoneApi, maps } = mountZone([zone("A"), zone("B")]);
    await flushView();
    const old = deferred<any>();
    zoneApi.getDetail.mockReturnValueOnce(old.promise);
    const pending = state.selectZone("A");
    zoneApi.getMap.mockResolvedValue([zone("B")]);
    await state.removeZone();
    await flushView();
    old.resolve({ plots: [plot("deleted-A")] });
    await pending;
    await flushView();
    expect(state.activeCode).toBe("B");
    expect(state.members).toEqual([]);
    expect(maps.at(-1).getContainer()).toBe(state.mapEl);
    expect(maps[0].remove).toHaveBeenCalledTimes(1);
  });

  it("卸载释放图层和底图，未完成的详情不能再绘图", async () => {
    const { state, zoneApi, maps, tiles, groups, unmount } = mountZone([zone("A")]);
    await flushView();
    const detail = deferred<any>();
    zoneApi.getDetail.mockReturnValueOnce(detail.promise);
    const pending = state.selectZone("A");
    await flushView();
    unmount();
    cleanups.pop();
    const count = groups.length;
    detail.resolve({ plots: [plot("late")] });
    await pending;
    await flushView();
    expect(maps[0].remove).toHaveBeenCalledTimes(1);
    tiles.forEach((tile) => expect(tile.remove).toHaveBeenCalledTimes(1));
    groups.forEach((group) => expect(group.clearLayers).toHaveBeenCalled());
    expect(groups).toHaveLength(count);
    expect(state.members).toEqual([]);
  });

  it("列表返回前卸载不初始化地图或继续读取详情", async () => {
    const initial = deferred<ReturnType<typeof zone>[]>();
    const { unmount, zoneApi, maps } = mountZone(initial.promise);
    unmount();
    cleanups.pop();
    initial.resolve([zone("A")]);
    await flushView();
    expect(maps).toHaveLength(0);
    expect(zoneApi.getDetail).not.toHaveBeenCalled();
  });

  it("片区和地块恶意名称作为 DOM 文本传入 tooltip，不插值成 HTML", async () => {
    const zoneName = '<img src=x onerror="alert(1)">';
    const plotName = '<svg onload="alert(2)">&名称';
    const { zoneApi, polygons } = mountZone([zone("A", zoneName)]);
    zoneApi.getDetail.mockResolvedValue({ ...zone("A"), plots: [plot("P", plotName)] });
    await flushView();
    const tooltips = polygons.map((polygon) => polygon.bindTooltip.mock.calls[0][0]);
    expect(tooltips.every((tooltip) => tooltip instanceof TestNode)).toBe(true);
    const titles = tooltips.map((tooltip) => tooltip.children[0]);
    expect(titles.every((title) => title.tag === "strong")).toBe(true);
    expect(titles.map((title) => title.textContent)).toContain(zoneName);
    expect(titles.map((title) => title.textContent)).toContain(plotName);
    expect(titles.every((title) => title.children.length === 0)).toBe(true);
  });
});
