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

function messages() {
  return { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
}

const camera = { id: "camera-001", name: "东区一号田摄像头", plotCode: "P-001", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-001.m3u8" };
const offlineCamera = { id: "camera-004", name: "场部入口枪机", status: "OFFLINE", streamUrl: "https://example.invalid/live/camera-004.m3u8" };
const recording = { id: "rec-1", cameraId: "camera-001", startedAt: "2026-11-10T02:00:00.000Z", endedAt: "2026-11-10T03:00:00.000Z", playbackUrl: "https://example.invalid/vod/rec-1.m3u8" };
const aiEvent = {
  id: "ai-1", cameraId: "camera-001", plotCode: "P-001", pestType: "稻飞虱", level: 2, confidence: 0.9,
  detectedAt: "2026-11-10T02:00:00.000Z", receivedAt: "2026-11-10T02:00:01.000Z",
  forwarded: false, forwardStatus: 0, forwardMessage: "", retryCount: 1, lastError: "遥测服务不可达",
};
const ptzCommand = { id: "ptz-1", cameraId: "camera-001", action: "LEFT", speed: 5, status: "QUEUED", message: "云台控制通道未配置，指令已留存", createdAt: "2026-11-10T02:00:00.000Z" };

function mountVideo() {
  // Node 无 DOM：桩掉元素类型判定，TestNode 不会命中 instanceof，播放器引用自然留空
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("HTMLElement", class {});
  // 编译真实 API 模块，仅替换 HTTP 边界，验证 cleanParams 对布尔假值的处理
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { videoApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  });
  vi.spyOn(videoApi, "getCameras").mockResolvedValue({ items: [camera, offlineCamera], total: 2, page: 1, size: 100, pages: 1 } as any);
  vi.spyOn(videoApi, "getRecordings").mockResolvedValue({ items: [recording], total: 1, page: 1, size: 10, pages: 1 } as any);
  vi.spyOn(videoApi, "getAiEvents").mockResolvedValue({ items: [aiEvent], total: 1, page: 1, size: 10, pages: 1 } as any);
  vi.spyOn(videoApi, "getPtzCommands").mockResolvedValue({ items: [ptzCommand], total: 1, page: 1, size: 10, pages: 1 } as any);
  const sendPtz = vi.spyOn(videoApi, "sendPtz").mockResolvedValue({ ...ptzCommand } as any);
  const retryPtz = vi.spyOn(videoApi, "retryPtz").mockResolvedValue({ ...ptzCommand, status: "SENT", message: "摄像机网关已接收（200）", deliveredAt: "2026-11-10T02:00:05.000Z" } as any);
  const retryAiEvent = vi.spyOn(videoApi, "retryAiEvent").mockResolvedValue({ ...aiEvent, forwarded: true, forwardStatus: 201, forwardMessage: "已生成虫情告警" } as any);
  const message = messages();
  const view = mountView(new URL("../src/views/video/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: message },
    "@/api": { videoApi },
    "@/utils": { formatDateTime: (value: string) => value },
    "@/types": types,
  });
  cleanups.push(view.unmount);
  return { ...view, videoApi, sendPtz, retryPtz, retryAiEvent, message };
}

describe("视频页标签页与数据接线", () => {
  it("挂载只拉摄像机，切换标签页才拉录像/AI/云台历史", async () => {
    const { state, videoApi } = mountVideo();
    await flushView();
    expect(videoApi.getCameras).toHaveBeenCalledTimes(1);
    expect(videoApi.getRecordings).not.toHaveBeenCalled();
    expect(videoApi.getAiEvents).not.toHaveBeenCalled();
    expect(videoApi.getPtzCommands).not.toHaveBeenCalled();

    state.onTabChange("recordings");
    await flushView();
    expect(videoApi.getRecordings).toHaveBeenCalledWith({ page: 1, size: 10 });
    expect(state.recordings).toHaveLength(1);
    expect(state.recTotal).toBe(1);

    state.onTabChange("ai");
    await flushView();
    expect(videoApi.getAiEvents).toHaveBeenCalledWith({ page: 1, size: 10 });
    expect(state.aiEvents).toHaveLength(1);

    state.onTabChange("ptz");
    await flushView();
    expect(videoApi.getPtzCommands).toHaveBeenCalledWith({ page: 1, size: 10 });
    expect(state.ptzCommands).toHaveLength(1);
  });

  it("录像筛选把摄像机与日期区间传给后端", async () => {
    const { state, videoApi } = mountVideo();
    await flushView();
    state.recQuery.cameraId = "camera-001";
    state.recQuery.range = ["2026-11-01", "2026-11-10"];
    await state.loadRecordings();
    expect(videoApi.getRecordings).toHaveBeenLastCalledWith({ page: 1, size: 10, cameraId: "camera-001", from: "2026-11-01", to: "2026-11-10" });
  });

  it("AI 筛选 forwarded=false 不被 cleanParams 丢掉", async () => {
    const { state, videoApi } = mountVideo();
    await flushView();
    state.aiQuery.forwarded = "false";
    state.aiQuery.plotCode = "P-001";
    await state.loadAiEvents();
    expect(videoApi.getAiEvents).toHaveBeenLastCalledWith({ page: 1, size: 10, plotCode: "P-001", forwarded: false });
  });
});

describe("云台控制按真实回执反馈", () => {
  it("下发携带速度，QUEUED/SENT/FAILED 分别警告/成功/报错", async () => {
    const { state, sendPtz, message } = mountVideo();
    await flushView();
    state.openPtz(camera as any);
    await flushView();
    expect(state.ptzDialogVisible).toBe(true);
    expect(state.ptzCamera?.id).toBe("camera-001");

    await state.ptzAction("LEFT");
    expect(sendPtz).toHaveBeenCalledWith("camera-001", { action: "LEFT", speed: 5 });
    expect(message.warning).toHaveBeenCalledWith(ptzCommand.message);
    expect(message.success).not.toHaveBeenCalled();

    sendPtz.mockResolvedValue({ ...ptzCommand, status: "SENT", message: "摄像机网关已接收（200）" } as any);
    await state.ptzAction("UP");
    expect(message.success).toHaveBeenCalledWith("摄像机网关已接收（200）");

    sendPtz.mockResolvedValue({ ...ptzCommand, status: "FAILED", message: "摄像机网关返回 503" } as any);
    await state.ptzAction("STOP");
    expect(message.error).toHaveBeenCalledWith("摄像机网关返回 503");
  });

  it("离线摄像机禁用云台动作；历史重试成功后刷新列表", async () => {
    const { state, retryPtz, videoApi, message } = mountVideo();
    await flushView();
    state.openPtz(offlineCamera as any);
    expect(state.ptzCameraOnline).toBe(false);

    state.onTabChange("ptz");
    await flushView();
    await state.retryPtzCommand(state.ptzCommands[0]);
    expect(retryPtz).toHaveBeenCalledWith("ptz-1");
    expect(message.success).toHaveBeenCalledWith("摄像机网关已接收（200）");
    // 打开对话框、切换历史标签、重试后刷新各拉取一次
    expect(videoApi.getPtzCommands).toHaveBeenCalledTimes(3);
  });
});

describe("AI 识别事件重试", () => {
  it("转发成功提示并刷新，仍失败如实警告不假装成功", async () => {
    const { state, retryAiEvent, videoApi, message } = mountVideo();
    await flushView();
    state.onTabChange("ai");
    await flushView();

    await state.retryAiEvent(state.aiEvents[0]);
    expect(retryAiEvent).toHaveBeenCalledWith("ai-1");
    expect(message.success).toHaveBeenCalledWith("转发成功，已生成虫情告警");
    expect(videoApi.getAiEvents).toHaveBeenCalledTimes(2);

    retryAiEvent.mockResolvedValue({ ...aiEvent, forwarded: false, forwardMessage: "遥测服务返回 503" } as any);
    await state.retryAiEvent(state.aiEvents[0]);
    expect(message.warning).toHaveBeenCalledWith("遥测服务返回 503");
    expect(message.success).toHaveBeenCalledTimes(1);
  });
});