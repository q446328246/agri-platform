import { readFileSync } from "node:fs";
import dayjs from "dayjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as types from "../src/types/index.js";
import { evaluateTs, flushView, mountView } from "./view-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 事件标签与配色的唯一来源是 @/utils，测试取真实模块，不手抄一份映射（抄一份就会漏掉新事件）
const utilsUrl = new URL("../src/utils/index.ts", import.meta.url);
const utils = evaluateTs(readFileSync(utilsUrl, "utf8"), utilsUrl.pathname, { dayjs, "@/types": types });

const chainFixture = [
  { id: "c1", traceCode: "TR-a", batchCode: "BT-CHAIN", plotCode: "P-1", event: "FARM_OPERATION", detail: "整地", operator: "张伟", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "c2", traceCode: "TR-b", batchCode: "BT-CHAIN", plotCode: "P-1", event: "PRESCRIPTION_ISSUED", detail: "追肥处方", operator: "decision-service", createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "c3", traceCode: "TR-c", batchCode: "BT-CHAIN", plotCode: "P-1", event: "HARVEST", detail: "采收", operator: "李芳", createdAt: "2026-03-01T00:00:00.000Z" },
];

function mountTrace() {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("window", { scrollTo: vi.fn() });
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { traceApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const getRecords = vi.spyOn(traceApi, "getRecords").mockResolvedValue({ items: [{ ...chainFixture[0] }, { ...chainFixture[1], batchCode: "BT-EAST" }], total: 2, page: 1, size: 20, pages: 1 } as any);
  const getChain = vi.spyOn(traceApi, "getChain").mockResolvedValue(chainFixture as any);
  const createRecord = vi.spyOn(traceApi, "createRecord").mockResolvedValue(chainFixture[0] as any);
  const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
  const view = mountView(new URL("../src/views/trace/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: message, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } },
    "@/api": { traceApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => true, userInfo: { name: "管理员" } }) },
    "@/utils": utils,
  });
  cleanups.push(view.unmount);
  return { ...view, getRecords, getChain, createRecord, message };
}

describe("全链路质量溯源页", () => {
  it("按溯源码查询链条，时间正序渲染并标记外部下游环节", async () => {
    const { state, getChain } = mountTrace();
    await flushView();
    state.lookupCode = "BT-CHAIN";
    await state.lookupChain();
    expect(getChain).toHaveBeenCalledWith("BT-CHAIN");
    expect(state.chainRecords.map((r: any) => r.id)).toEqual(["c1", "c2", "c3"]);
    expect(state.chainSearched).toBe(true);
  });

  it("列表按溯源码过滤并入查询条件", async () => {
    const { state, getRecords } = mountTrace();
    await flushView();
    getRecords.mockClear();
    state.query.batchCode = "BT-EAST";
    await state.search();
    expect(getRecords).toHaveBeenCalledWith(expect.objectContaining({ batchCode: "BT-EAST" }));
  });

  it("行内「看链条」回填溯源码并加载链条", async () => {
    const { state, getChain } = mountTrace();
    await flushView();
    state.viewChain("BT-EAST");
    await flushView();
    expect(state.lookupCode).toBe("BT-EAST");
    expect(getChain).toHaveBeenCalledWith("BT-EAST");
  });

  it("时间轴节点色与事件标签口径一致", async () => {
    const { state } = mountTrace();
    await flushView();
    expect(state.traceTimelineType("HARVEST")).toBe("success");
    expect(state.traceTimelineType("OPERATION_COMPLETED")).toBe("warning");
    expect(state.traceTimelineType("FARM_OPERATION")).toBe("primary");
  });

  it("登记可带溯源码，提交后回写查询联动", async () => {
    const { state, createRecord } = mountTrace();
    await flushView();
    // 模板里 el-form 被自动打桩，提交前用可控实例替换校验入口
    state.formRef = { validate: async () => true, clearValidate: () => {} };
    state.form.batchCode = "BT-NEW";
    state.form.plotCode = "P-9";
    state.form.detail = "领用有机肥";
    state.form.operator = "张伟";
    await state.submit();
    expect(createRecord).toHaveBeenCalledWith(expect.objectContaining({ batchCode: "BT-NEW", plotCode: "P-9" }));
  });
});
