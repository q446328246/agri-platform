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

// 状态/类型文案与时间格式的唯一来源是 @/utils 与后端字段，测试同样取真实模块，不手抄一份映射
const utilsUrl = new URL("../src/utils/index.ts", import.meta.url);
const utils = evaluateTs(readFileSync(utilsUrl, "utf8"), utilsUrl.pathname, { dayjs, "@/types": types });

interface CommandSeed {
  id?: string;
  type?: string;
  status?: string;
  origin?: string;
  createdAt?: string;
  sentAt?: string | null;
  ackedAt?: string | null;
  finishedAt?: string | null;
  receiptMessage?: string;
  pendingMin?: number;
  overdue?: boolean;
}

/** 与 /control/commands 返回的视图同构；时间戳只是样例，断言都取字段本身 */
function command(seed: CommandSeed = {}) {
  return {
    id: seed.id ?? "CMD-1",
    deviceId: "DEV-IRR-01",
    plotCode: "511723-000001-01-9001A",
    type: seed.type ?? "IRRIGATION",
    origin: seed.origin ?? "EVENT",
    status: seed.status ?? "SENT",
    reason: "土壤含水率低于下限，自动生成灌溉指令",
    sourceEventId: "EVT-7",
    parameters: {},
    operatorId: "system:event",
    createdAt: seed.createdAt ?? "2026-11-12T01:00:00.000Z",
    sentAt: seed.sentAt ?? "2026-11-12T01:02:00.000Z",
    ackedAt: seed.ackedAt ?? null,
    finishedAt: seed.finishedAt ?? null,
    receiptMessage: seed.receiptMessage ?? "",
    pendingMin: seed.pendingMin ?? 8,
    overdue: seed.overdue ?? false,
    version: 2,
  };
}

function mountCommands(options: { hasPermission?: boolean; items?: unknown[]; confirm?: () => Promise<unknown> } = {}) {
  vi.stubGlobal("HTMLElement", class {});
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { controlApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    "@/types": types,
  });
  const getCommands = vi.spyOn(controlApi, "getCommands").mockResolvedValue({
    items: options.items ?? [command()],
    total: (options.items ?? [command()]).length,
    page: 1,
    size: 20,
    pages: 1,
  } as any);
  const dispatchCommand = vi.spyOn(controlApi, "dispatchCommand").mockResolvedValue(command({ status: "SENT" }) as any);
  const reportReceipt = vi.spyOn(controlApi, "reportReceipt").mockResolvedValue(command({ status: "DONE" }) as any);
  const confirm = vi.fn().mockImplementation(options.confirm ?? (() => Promise.resolve(true)));
  const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() };
  const view = mountView(new URL("../src/views/device/Commands.vue", import.meta.url), {
    "element-plus": { ElMessage: message, ElMessageBox: { confirm } },
    "@/api": { controlApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => options.hasPermission ?? true }) },
    "@/utils": utils,
  });
  cleanups.push(view.unmount);
  return { ...view, getCommands, dispatchCommand, reportReceipt, confirm, message };
}

describe("控制指令台账页", () => {
  it("挂载即以默认分页拉取，条件留空不上送", async () => {
    const { state, getCommands } = mountCommands();
    await flushView();
    expect(getCommands).toHaveBeenCalledWith({ page: 1, size: 20 });
    expect(state.commands.map((row: { id: string }) => row.id)).toEqual(["CMD-1"]);
    expect(state.total).toBe(1);
    expect(state.loading).toBe(false);
  });

  it("只把填过的条件下发，超时勾选才带 overdue", async () => {
    const { state, getCommands } = mountCommands();
    await flushView();
    getCommands.mockClear();
    state.query.plotCode = "511723-000001-01-9001A";
    state.query.status = "QUEUED";
    state.query.range = ["2026-11-01", "2026-11-12"];
    state.query.overdue = true;
    state.reload();
    await flushView();
    expect(getCommands).toHaveBeenCalledWith({
      plotCode: "511723-000001-01-9001A",
      status: "QUEUED",
      from: "2026-11-01",
      to: "2026-11-12",
      overdue: true,
      page: 1,
      size: 20,
    });
    getCommands.mockClear();
    state.query.overdue = false;
    state.reload();
    await flushView();
    expect("overdue" in (getCommands.mock.calls[0]![0] as Record<string, unknown>)).toBe(false);
  });

  it("重置清空全部条件并回到第一页", async () => {
    const { state, getCommands } = mountCommands();
    await flushView();
    state.query.deviceId = "DEV-IRR-01";
    state.query.overdue = true;
    state.query.page = 3;
    getCommands.mockClear();
    state.reset();
    await flushView();
    expect(getCommands).toHaveBeenCalledWith({ page: 1, size: 20 });
    expect(state.query).toMatchObject({ deviceId: "", overdue: false, range: null, page: 1 });
  });

  it("生命周期只铺已发生的节点，失败收口写「失败」", async () => {
    const { state } = mountCommands();
    await flushView();
    const running = state.lifecycleText(command({ status: "SENT" }));
    expect(running.split("\n")).toHaveLength(2);
    expect(running).toContain(`入队 ${utils.formatDateTime("2026-11-12T01:00:00.000Z")}`);
    expect(running).toContain("下发");
    expect(running).not.toContain("接收");

    const done = state.lifecycleText(command({ status: "DONE", ackedAt: "2026-11-12T01:05:00.000Z", finishedAt: "2026-11-12T01:25:00.000Z" }));
    expect(done.split("\n")).toHaveLength(4);
    expect(done).toContain("到位");

    const failed = state.lifecycleText(command({ status: "FAILED", finishedAt: "2026-11-12T02:00:00.000Z" }));
    expect(failed).toContain("失败");
    expect(failed).not.toContain("到位");
  });

  it("标记下发走二次确认，成功后重查列表", async () => {
    const { state, confirm, dispatchCommand, getCommands, message } = mountCommands({
      items: [command({ status: "QUEUED", sentAt: null })],
    });
    await flushView();
    getCommands.mockClear();
    await state.dispatch(state.commands[0]);
    await flushView();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("已下发"), "二次确认", expect.anything());
    expect(dispatchCommand).toHaveBeenCalledWith("CMD-1");
    expect(message.success).toHaveBeenCalledWith(expect.stringContaining("下发"));
    expect(getCommands).toHaveBeenCalledTimes(1);
    expect(state.busyId).toBe("");
  });

  it("取消二次确认不发请求，接口失败也不会卡在忙态", async () => {
    const { state, dispatchCommand } = mountCommands({ items: [command({ status: "QUEUED" })], confirm: () => Promise.reject("cancel") });
    await flushView();
    await state.dispatch(state.commands[0]);
    expect(dispatchCommand).not.toHaveBeenCalled();

    const failing = mountCommands({ items: [command({ status: "QUEUED" })] });
    failing.dispatchCommand.mockRejectedValue(new Error("指令状态已被其它回执推进"));
    await failing.state.dispatch(failing.state.commands[0]);
    await flushView();
    expect(failing.state.busyId).toBe("");
  });

  it("回执默认状态跟随当前状态：已下发报接收，设备已接收报到位", async () => {
    const { state } = mountCommands({ items: [command({ status: "SENT" }), command({ id: "CMD-2", status: "ACKED", ackedAt: "2026-11-12T01:05:00.000Z" })] });
    await flushView();
    state.openReceipt(state.commands[0]);
    expect(state.receiptForm.status).toBe("ACKED");
    expect(state.receiptVisible).toBe(true);
    state.openReceipt(state.commands[1]);
    expect(state.receiptForm.status).toBe("DONE");
  });

  it("急停结单必须勾到位确认，未勾选时提交无效且不发请求", async () => {
    const { state, reportReceipt } = mountCommands({ items: [command({ id: "CMD-E", type: "ESTOP", status: "ACKED", ackedAt: "2026-11-12T01:05:00.000Z" })] });
    await flushView();
    state.openReceipt(state.commands[0]);
    expect(state.receiptForm.status).toBe("DONE");
    expect(state.needConfirm).toBe(true);
    expect(state.receiptValid).toBe(false);
    await state.submitReceipt();
    expect(reportReceipt).not.toHaveBeenCalled();

    state.receiptForm.confirmed = true;
    expect(state.receiptValid).toBe(true);
    await state.submitReceipt();
    expect(reportReceipt).toHaveBeenCalledWith({ commandId: "CMD-E", status: "DONE", result: { confirmed: true } });
    expect(state.receiptVisible).toBe(false);
  });

  it("失败回执必须写明原因，说明文字去空格后上送", async () => {
    const { state, reportReceipt } = mountCommands({ items: [command({ id: "CMD-F", status: "ACKED", ackedAt: "2026-11-12T01:05:00.000Z" })] });
    await flushView();
    state.openReceipt(state.commands[0]);
    state.receiptForm.status = "FAILED";
    state.receiptForm.message = "   ";
    expect(state.receiptValid).toBe(false);
    await state.submitReceipt();
    expect(reportReceipt).not.toHaveBeenCalled();

    state.receiptForm.message = " 阀门未动作 ";
    expect(state.receiptValid).toBe(true);
    await state.submitReceipt();
    expect(reportReceipt).toHaveBeenCalledWith({ commandId: "CMD-F", status: "FAILED", message: "阀门未动作" });
  });

  it("无 device:control 权限时不给出可操作的结单入口", async () => {
    const granted = mountCommands();
    const denied = mountCommands({ hasPermission: false });
    await flushView();
    expect(granted.state.canControl).toBe(true);
    expect(denied.state.canControl).toBe(false);
  });
});
