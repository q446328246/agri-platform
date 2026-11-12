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

/**
 * 目录夹具刻意用与生产不同的协议名、剖面 key 与缺省值。
 * 界面若把 MODBUS_TCP、剖面 key 或端口写死而不是照目录渲染，这些用例会当场失败。
 */
const CATALOGUE = {
  protocols: [
    { value: "CB", label: "回调式", requiresBinding: false },
    { value: "BUS", label: "总线式", requiresBinding: true },
  ],
  defaultProtocol: "CB",
  profiles: [
    { key: "SW", label: "启停剖面", applicableTypes: ["PUMP"], meter: null },
    { key: "METER", label: "计量剖面", applicableTypes: ["PUMP", "VALVE"], meter: { register: 32, wordOrder: "LOW_FIRST", wordOrderLabel: "低字在前（CDAB）", scale: 0.1, unit: "L" } },
  ],
  defaults: { port: 1502, unitId: 9, timeoutMs: 4321 },
};

const LEDGER = {
  id: "d1",
  deviceNo: "DZ-P-001",
  name: "一号泵站",
  type: "PUMP",
  status: "OFFLINE",
  plotCode: "P-1",
  protocol: "BUS",
  binding: { host: "10.1.2.3", port: 1502, unitId: 9, profile: "SW", timeoutMs: 4321 },
  lastSeenAt: "2026-11-12T00:00:00.000Z",
};

function mountDeviceList() {
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { iotApi, plotApi, controlApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const getFieldAccess = vi.spyOn(iotApi, "getFieldAccess").mockResolvedValue(CATALOGUE as any);
  const updateDevice = vi.spyOn(iotApi, "updateDevice").mockImplementation(async (_id: string, data: any) => ({ ...LEDGER, ...data }) as any);
  vi.spyOn(iotApi, "getDevices").mockResolvedValue({ items: [{ ...LEDGER }], total: 1 } as any);
  vi.spyOn(plotApi, "getBounds").mockResolvedValue([] as any);
  const view = mountView(new URL("../src/views/device/List.vue", import.meta.url), {
    "vue-router": { useRoute: () => ({ query: {}, params: {} }) },
    "element-plus": { ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } },
    "@/api": { iotApi, plotApi, controlApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => true, permissions: [] }) },
    "@/utils": { formatDateTime: (value: string) => value, getControlTypeText: () => "", getDeviceStatusText: () => "", getDeviceStatusType: () => "" },
    "@/utils/device": { deviceStatusOptions: [], deviceTypeLabel: (value?: string) => `类型(${value ?? ""})`, deviceTypeOptions: [] },
    "@/types": types,
  });
  cleanups.push(view.unmount);
  return { ...view, getFieldAccess, updateDevice };
}

/**
 * Element Plus 表单在纯 Node 渲染桩里没有真实实例：弹窗一渲染，ref 就被绑回桩组件。
 * 因此每次会让表单重新渲染的改动之后都要重新代答校验，用例本身只管目录与收发的绑定。
 * 建档侧的必填与匹配由服务端校验兜底，不在这里假装有表单校验。
 */
function passValidation(state: any) {
  state.configFormRef = { validate: async () => true, clearValidate: () => {} };
}

describe("设备配置弹窗按服务端现场接入目录渲染并收发绑定", () => {
  it("进页面先取目录，协议与剖面选项都来自目录而非前端清单", async () => {
    const { state, getFieldAccess } = mountDeviceList();
    await flushView();
    expect(getFieldAccess).toHaveBeenCalledTimes(1);
    expect(state.fieldAccess).toEqual(CATALOGUE);
    expect(state.protocolOptions.map((item: any) => item.value)).toEqual(["CB", "BUS"]);
    expect(state.profileOptions.map((item: any) => item.key)).toEqual(["SW", "METER"]);
  });

  it("在册的现场地址与剖面按台账回填，不让运维重抄一遍", async () => {
    const { state } = mountDeviceList();
    await flushView();
    passValidation(state);
    await state.openConfig({ ...LEDGER });
    expect(state.configForm.protocol).toBe("BUS");
    expect(state.configForm.host).toBe("10.1.2.3");
    expect(state.configForm.profile).toBe("SW");
    expect(state.needsBinding).toBe(true);
  });

  it("切到需要绑定的协议后，缺省端口以外的绑定按目录缺省留空即不发出", async () => {
    const { state, updateDevice } = mountDeviceList();
    await flushView();
    passValidation(state);
    await state.openConfig({ ...LEDGER, protocol: "CB", binding: undefined });
    state.configForm.protocol = "BUS";
    state.configForm.host = " 10.9.9.9 ";
    state.configForm.profile = "METER";
    passValidation(state);
    await state.submitConfig();
    expect(updateDevice).toHaveBeenCalledWith("d1", expect.objectContaining({
      protocol: "BUS",
      // 端口、单元标识与超时留空：不发出去，由服务端按目录缺省补齐，前端不替后端决定数值
      binding: { host: "10.9.9.9", profile: "METER" },
    }));
  });

  it("改回回调式接入时显式清空绑定，网关才不会连一台已改回调的设备", async () => {
    const { state, updateDevice } = mountDeviceList();
    await flushView();
    passValidation(state);
    await state.openConfig({ ...LEDGER });
    state.configForm.protocol = "CB";
    passValidation(state);
    await state.submitConfig();
    expect(state.needsBinding).toBe(false);
    expect(updateDevice).toHaveBeenCalledWith("d1", expect.objectContaining({ protocol: "CB", binding: null }));
  });

  it("设备类型没有可用剖面时，需要绑定的协议不可选且原剖面被清空", async () => {
    const { state } = mountDeviceList();
    await flushView();
    passValidation(state);
    await state.openConfig({ ...LEDGER });
    state.configForm.type = "SENSOR";
    await flushView();
    const bus = state.protocolOptions.find((item: any) => item.value === "BUS");
    expect(bus.unsupported).toBe(true);
    expect(state.configForm.profile).toBe("");
    expect(state.protocolHint).toContain("类型(SENSOR)");
  });

  it("计量剖面把倍率与字序翻成可读话，启停剖面说明不报作业量", async () => {
    const { state } = mountDeviceList();
    await flushView();
    passValidation(state);
    await state.openConfig({ ...LEDGER });
    state.configForm.profile = "METER";
    expect(state.hex(state.selectedProfile.meter.register)).toBe("0x0020");
    expect(state.selectedProfile.meter.wordOrderLabel).toBe("低字在前（CDAB）");
    state.configForm.profile = "SW";
    expect(state.selectedProfile.meter).toBeNull();
  });
});
