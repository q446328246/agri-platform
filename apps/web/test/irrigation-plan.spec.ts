import { readFileSync } from "node:fs";
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as types from "../src/types/index.js";
import { deferred, evaluateTs, flushView, mountView } from "./view-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const planResult = {
  plotCode: "P-2",
  flowM3h: 20,
  totalAreaMu: 15,
  totalWaterVolume: 300,
  totalDurationMin: 15,
  zones: [
    { zoneCode: "A", areaMu: 10, targetMm: 10, waterVolume: 200, durationMin: 10, startMin: 0, endMin: 10 },
    { zoneCode: "B", areaMu: 5, targetMm: 20, waterVolume: 100, durationMin: 5, startMin: 10, endMin: 15 },
  ],
  curve: [],
  recipe: { nitrogen: 2, phosphorus: 1, potassium: 1, totalKg: 60 },
  stir: { durationMin: 15, rpm: 60 },
  warnings: [],
};

function mountIrrigation(options: { devicePages?: any[] } = {}) {
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { controlApi, iotApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const devicePages = options.devicePages ?? [{
    items: [{ id: "pump-1", name: "一号泵", deviceNo: "P-1", type: "IRRIGATION_PUMP", plotCode: "P-2" }],
    total: 1,
  }];
  const getDevices = vi.spyOn(iotApi, "getDevices").mockImplementation(async (params: any) =>
    (devicePages[params.page - 1] ?? { items: [], total: devicePages.at(-1)?.total ?? 0 }) as any,
  );
  const buildIrrigationPlan = vi.spyOn(controlApi, "buildIrrigationPlan").mockResolvedValue(planResult as any);
  const sendCommand = vi.spyOn(controlApi, "sendCommand").mockResolvedValue({ id: "cmd-1" } as any);
  const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
  const view = mountView(new URL("../src/views/irrigation/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: message },
    "vue-echarts": { __esModule: true, default: Vue.defineComponent({ render: () => null }) },
    "echarts/core": { use: vi.fn() },
    "echarts/renderers": { CanvasRenderer: {} },
    "echarts/charts": { LineChart: {}, BarChart: {} },
    "echarts/components": { TooltipComponent: {}, LegendComponent: {}, GridComponent: {} },
    "@/api": { controlApi, iotApi },
  });
  cleanups.push(view.unmount);
  return { ...view, getDevices, buildIrrigationPlan, sendCommand, message };
}

describe("灌溉设备候选全量分页", () => {
  it("先按页拉全台账，再按类型与地块筛选，不漏掉 200 台之后的候选", async () => {
    const filler = Array.from({ length: 200 }, (_, index) => ({
      id: `sensor-${index}`, name: `传感器 ${index}`, deviceNo: `S-${index}`, type: "SOIL_SENSOR", plotCode: "P-1",
    }));
    const { state, getDevices } = mountIrrigation({
      devicePages: [
        { items: filler, total: 203 },
        { items: [
          { id: "pump-2", name: "二号泵", deviceNo: "P-2", type: "IRRIGATION_PUMP", plotCode: "P-2" },
          { id: "pump-3", name: "三号泵", deviceNo: "P-3", type: "IRRIGATION_PUMP", plotCode: "P-3" },
          { id: "fert-1", name: "水肥阀", deviceNo: "F-1", type: "FERTILIZER_VALVE", plotCode: "P-2" },
        ], total: 203 },
      ],
    });
    state.form.plotCode = "P-2";
    await flushView();
    await state.loadDevices();
    expect(getDevices).toHaveBeenCalledWith({ page: 1, size: 200 });
    expect(getDevices).toHaveBeenCalledWith({ page: 2, size: 200 });
    expect(getDevices.mock.calls.every(([params]) => !("plotCode" in params) && !("type" in params))).toBe(true);
    expect(state.deviceOptions.map((item: any) => item.id)).toEqual(["pump-2"]);
  });
});

describe("灌溉方案快照", () => {
  it("分区、流量、配比等任一方案输入变化都会作废旧方案", async () => {
    const { state, sendCommand } = mountIrrigation();
    await flushView();
    state.form.deviceId = "pump-1";
    const mutations: Array<(form: any) => void> = [
      (form) => { form.plotCode = "P-3"; },
      (form) => { form.flowM3h = 30; },
      (form) => { form.zones[0].zoneCode = "C"; },
      (form) => { form.zones[0].areaMu = 12; },
      (form) => { form.zones[0].targetMm = 15; },
      (form) => { form.zones.push({ zoneCode: "C", areaMu: 2, targetMm: 10 }); },
      (form) => { form.zones.pop(); },
      (form) => { form.withRecipe = true; },
      (form) => { form.recipe.nitrogen = 3; },
      (form) => { form.stir.rpm = 80; },
    ];
    for (const mutate of mutations) {
      await state.calculate();
      expect(state.plan).not.toBeNull();
      mutate(state.form);
      await flushView();
      expect(state.plan).toBeNull();
      expect(state.planInput).toBeNull();
      await state.dispatch();
    }
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("生成请求期间改参数，旧响应不能重新挂回方案", async () => {
    const { state, buildIrrigationPlan, sendCommand } = mountIrrigation();
    await flushView();
    const pending = deferred<any>();
    buildIrrigationPlan.mockReturnValue(pending.promise);
    const calculation = state.calculate();
    state.form.flowM3h = 40;
    await flushView();
    pending.resolve(planResult);
    await calculation;
    await flushView();
    expect(state.plan).toBeNull();
    expect(state.planInput).toBeNull();
    state.form.deviceId = "pump-1";
    await state.dispatch();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("指令类型取生成时配比快照，切换施肥开关后旧灌溉方案立即失效", async () => {
    const { state, sendCommand } = mountIrrigation();
    await flushView();
    state.form.deviceId = "pump-1";
    state.form.plotCode = "P-2";
    await state.calculate();
    await state.dispatch();
    expect(sendCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "IRRIGATION",
      plotCode: "P-2",
    }));

    state.form.withRecipe = true;
    await flushView();
    expect(state.plan).toBeNull();
    await state.dispatch();
    expect(sendCommand).toHaveBeenCalledTimes(1);

    state.form.deviceId = "fert-1";
    await state.calculate();
    await state.dispatch();
    expect(sendCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "FERTILIZATION",
      parameters: expect.objectContaining({ recipe: { nitrogen: 2, phosphorus: 1, potassium: 1 } }),
    }));
  });
});
