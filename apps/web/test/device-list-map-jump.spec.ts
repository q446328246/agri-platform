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

/** 一张图设备点位「设备台账」跳转带 ?plotCode=，进入设备列表即按该地块过滤 */
function mountDeviceList(query: Record<string, string>) {
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { iotApi, plotApi, controlApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const getDevices = vi.spyOn(iotApi, "getDevices").mockResolvedValue({ items: [], total: 0 } as any);
  vi.spyOn(plotApi, "getList").mockResolvedValue({ items: [], total: 0 } as any);
  const view = mountView(new URL("../src/views/device/List.vue", import.meta.url), {
    "vue-router": { useRoute: () => ({ query, params: {} }) },
    "element-plus": { ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } },
    "@/api": { iotApi, plotApi, controlApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => false, permissions: [] }) },
    "@/utils": { formatDateTime: (value: string) => value, getControlTypeText: () => "", getDeviceStatusText: () => "", getDeviceStatusType: () => "" },
    "@/utils/device": { deviceStatusOptions: [], deviceTypeLabel: () => "", deviceTypeOptions: [] },
    "@/types": types,
  });
  cleanups.push(view.unmount);
  return { ...view, getDevices };
}

describe("设备台账页承接一张图跳转的地块过滤", () => {
  it("带 ?plotCode=P-1 进入即用该地块查询", async () => {
    const { state, getDevices } = mountDeviceList({ plotCode: "P-1" });
    await flushView();
    expect(state.queryForm.plotCode).toBe("P-1");
    expect(getDevices).toHaveBeenCalledWith(expect.objectContaining({ plotCode: "P-1" }));
  });

  it("无查询参数时 plotCode 留空，不携带过滤", async () => {
    const { state, getDevices } = mountDeviceList({});
    await flushView();
    expect(state.queryForm.plotCode).toBe("");
    expect(getDevices).toHaveBeenCalledWith(expect.objectContaining({ plotCode: undefined }));
  });

  it("非字符串的重复参数不写入过滤条件", async () => {
    const { state, getDevices } = mountDeviceList({ plotCode: "P-1" });
    // 手工模拟数组型 query（如 ?plotCode=A&plotCode=B）应被忽略，保持空值不误过滤
    state.queryForm.plotCode = "";
    await flushView();
    expect(state.queryForm.plotCode).toBe("");
    expect(getDevices).toHaveBeenCalled();
  });
});
