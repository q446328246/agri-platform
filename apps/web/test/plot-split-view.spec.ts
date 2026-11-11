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

function rect(minLng: number, minLat: number, maxLng: number, maxLat: number): [number, number][] {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
  ];
}

const geoUrl = new URL("../src/utils/geo.ts", import.meta.url);
const geo = evaluateTs(readFileSync(geoUrl, "utf8"), geoUrl.pathname, { "@/types": types });
const FULL = rect(107.4212, 30.9805, 107.4252, 30.9825);
const WEST = rect(107.4212, 30.9805, 107.4232, 30.9825);
const EAST = rect(107.4232, 30.9805, 107.4252, 30.9825);
// 台账面积按同一几何现算，避免前端校验参照的口径和边界对不上
const fullAreaMu = Number(geo.polygonAreaMu(FULL).toFixed(2));
const sourcePlot = {
  id: "p-1", parcelCode: "511723-000001-01-9001A", name: "拆分验证地块",
  regionCode: "511723", villageCode: "511723-000001", type: "FIELD", status: "ACTIVE",
  areaMu: fullAreaMu, gridCode: "", createdAt: "", updatedAt: "",
  geom: { type: "Polygon", coordinates: [[...FULL, FULL[0]]], srid: 4490 },
};

const editorStub = { name: "PlotPolygonEditor", props: ["modelValue"], setup: () => () => null };

function mountSplit(options: { getById?: () => Promise<unknown>; confirm?: () => Promise<unknown> } = {}) {
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { plotApi, toPolygonGeom } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  vi.spyOn(plotApi, "getById").mockImplementation(options.getById ?? (() => Promise.resolve(structuredClone(sourcePlot))));
  const split = vi.spyOn(plotApi, "split").mockResolvedValue({
    plots: [
      { ...sourcePlot, parcelCode: "511723-000001-01-9002A", name: "子地块 1", areaMu: Number(geo.polygonAreaMu(WEST).toFixed(2)) },
      { ...sourcePlot, parcelCode: "511723-000001-01-9003A", name: "子地块 2", areaMu: Number(geo.polygonAreaMu(EAST).toFixed(2)) },
    ] as any,
    sourceCode: sourcePlot.parcelCode,
    sourceRemoved: true,
    pieceAreaSum: fullAreaMu,
  } as any);
  const confirm = vi.fn().mockImplementation(options.confirm ?? (() => Promise.resolve(true)));
  const success = vi.fn();
  const warning = vi.fn();
  const push = vi.fn();
  const back = vi.fn();
  const view = mountView(new URL("../src/views/plot/Split.vue", import.meta.url), {
    "vue-router": { useRoute: () => ({ params: { id: sourcePlot.parcelCode } }), useRouter: () => ({ push, back }) },
    "element-plus": { ElMessage: { success, warning, error: vi.fn() }, ElMessageBox: { confirm } },
    "@/components/PlotPolygonEditor.vue": editorStub,
    "@/api": { plotApi, toPolygonGeom },
    "@/utils/geo": geo,
  });
  cleanups.push(view.unmount);
  return { ...view, split, confirm, success, warning, push, back };
}

describe("地块拆分页", () => {
  it("载入后按原边界给每块子地块塞参考顶点，面积取几何现算", async () => {
    const { state } = mountSplit();
    await flushView();
    expect(state.source).toMatchObject({ parcelCode: sourcePlot.parcelCode });
    expect(state.pieces).toHaveLength(2);
    for (const piece of state.pieces) {
      expect(piece.coordinates).toHaveLength(4);
      expect(piece.areaMu).toBe(fullAreaMu);
    }
  });

  it("无边界地块不进拆分流，档案为空态", async () => {
    const { state } = mountSplit({ getById: () => Promise.resolve({ ...sourcePlot, geom: undefined }) });
    await flushView();
    expect(state.pieces.every((piece: { coordinates: unknown[] }) => piece.coordinates.length === 0)).toBe(true);
  });

  it("逐块预检面积上限：超限块被拦下，不发请求", async () => {
    const { state, split, warning } = mountSplit();
    await flushView();
    state.pieces[0].coordinates = WEST.map((point) => [...point] as [number, number]);
    state.handlePieceArea(0, geo.polygonAreaMu(WEST));
    // 第二块仍是整幅参考边界（=原面积），恰好在上限内；改成放大版触发拦截
    state.pieces[1].coordinates = rect(107.4212, 30.9805, 107.4262, 30.9835).map((point) => [...point] as [number, number]);
    state.handlePieceArea(1, geo.polygonAreaMu(rect(107.4212, 30.9805, 107.4262, 30.9835)));
    await state.handleSplit();
    expect(split).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("超过原地块"));
  });

  it("确认拆分提交闭合环 GeoJSON，成功后回退", async () => {    const { state, split, success, back } = mountSplit();
    await flushView();
    state.pieces[0].coordinates = WEST.map((point) => [...point] as [number, number]);
    state.handlePieceArea(0, geo.polygonAreaMu(WEST));
    state.pieces[1].coordinates = EAST.map((point) => [...point] as [number, number]);
    state.handlePieceArea(1, geo.polygonAreaMu(EAST));
    await state.handleSplit();
    await flushView();
    expect(split).toHaveBeenCalledTimes(1);
    const payload = split.mock.calls[0][0] as { parcelCode: string; keepSource: boolean; pieces: Array<{ parcelName: string; geom: { type: string; srid: number; coordinates: number[][][] } }> };
    expect(payload.parcelCode).toBe(sourcePlot.parcelCode);
    expect(payload.keepSource).toBe(false);
    expect(payload.pieces).toHaveLength(2);
    for (const piece of payload.pieces) {
      expect(piece.geom.type).toBe("Polygon");
      expect(piece.geom.srid).toBe(4490);
      const ring = piece.geom.coordinates[0]!;
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
    expect(success).toHaveBeenCalledWith(expect.stringContaining("拆分完成"));
    expect(back).toHaveBeenCalled();
  });
});

describe("plotApi 合并/拆分接口线格式", () => {
  function wire() {
    const post = vi.fn();
    const apiUrl = new URL("../src/api/index.ts", import.meta.url);
    const { plotApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
      "@/utils/request": { get: vi.fn(), post, put: vi.fn(), del: vi.fn() },
      "@/types": types,
    });
    return { plotApi, post };
  }

  it("merge POST /plots/merge，返回归一化地块与源编码", async () => {
    const { plotApi, post } = wire();
    post.mockResolvedValue({ plot: { parcelCode: "511723-000001-01-9004A", parcelName: "合并地块", areaMu: 12.34 }, sourceCodes: ["A1", "B2"] });
    const result = await plotApi.merge({ parcelCodes: ["A1", "B2"], parcelName: "合并地块" });
    expect(post).toHaveBeenCalledWith("/plots/merge", { parcelCodes: ["A1", "B2"], parcelName: "合并地块" });
    expect(result.plot).toMatchObject({ parcelCode: "511723-000001-01-9004A", name: "合并地块", areaMu: 12.34 });
    expect(result.sourceCodes).toEqual(["A1", "B2"]);
  });

  it("split POST /plots/split，返回逐块归一化的子地块", async () => {
    const { plotApi, post } = wire();
    post.mockResolvedValue({
      plots: [{ parcelCode: "C1", areaMu: 3 }, { parcelCode: "C2", areaMu: 4 }],
      sourceCode: "A1",
      sourceRemoved: true,
      pieceAreaSum: 7,
    });
    const input = { parcelCode: "A1", pieces: [{ parcelName: "东", geom: { type: "Polygon" as const, coordinates: [FULL], srid: 4490 } }], keepSource: false };
    const result = await plotApi.split(input);
    expect(post).toHaveBeenCalledWith("/plots/split", input);
    expect(result.plots.map((plot) => plot.parcelCode)).toEqual(["C1", "C2"]);
    expect(result.sourceRemoved).toBe(true);
  });
});
