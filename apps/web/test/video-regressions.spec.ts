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

class FakeHls {
  static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
  static instances: FakeHls[] = [];
  static isSupported() { return true; }
  handlers = new Map<string, (...args: any[]) => void>();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  destroy = vi.fn();
  constructor(_options: unknown) { FakeHls.instances.push(this); }
  on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
}

class FakeVideo {
  src = "";
  canPlayType = vi.fn(() => "");
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
}

interface VideoMountOptions {
  canControl?: boolean;
  cameras?: any[];
  cameraPages?: Array<{ items: any[]; total: number }>;
}

function mountVideo(options: VideoMountOptions = {}) {
  FakeHls.instances = [];
  vi.stubGlobal("HTMLVideoElement", FakeVideo);
  vi.stubGlobal("HTMLElement", class {});
  // 编译真实 API 模块，仅替换 HTTP 边界，验证 cleanParams 对布尔假值的处理
  const apiUrl = new URL("../src/api/index.ts", import.meta.url);
  const { videoApi } = evaluateTs(readFileSync(apiUrl, "utf8"), apiUrl.pathname, {
    "@/utils/request": { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  });
  const liveCameras = options.cameras ?? [camera, offlineCamera];
  const directoryPages = options.cameraPages ?? [{ items: liveCameras, total: liveCameras.length }];
  vi.spyOn(videoApi, "getCameras").mockImplementation(async (params: any) => {
    if (params?.size === 200) return directoryPages[params.page - 1] ?? { items: [], total: directoryPages.at(-1)?.total ?? 0 } as any;
    return { items: liveCameras, total: liveCameras.length, page: 1, size: 100, pages: 1 } as any;
  });
  vi.spyOn(videoApi, "getRecordings").mockResolvedValue({ items: [recording], total: 1, page: 1, size: 10, pages: 1 } as any);
  vi.spyOn(videoApi, "getAiEvents").mockResolvedValue({ items: [aiEvent], total: 1, page: 1, size: 10, pages: 1 } as any);
  vi.spyOn(videoApi, "getPtzCommands").mockResolvedValue({ items: [ptzCommand], total: 1, page: 1, size: 10, pages: 1 } as any);
  const createCamera = vi.spyOn(videoApi, "createCamera").mockResolvedValue(camera as any);
  const updateCamera = vi.spyOn(videoApi, "updateCamera").mockResolvedValue(camera as any);
  const deleteCamera = vi.spyOn(videoApi, "deleteCamera").mockResolvedValue(undefined);
  const createRecordingArchive = vi.spyOn(videoApi, "createRecordingArchive").mockResolvedValue({ id: "arc-1" } as any);
  const sendPtz = vi.spyOn(videoApi, "sendPtz").mockResolvedValue({ ...ptzCommand } as any);
  const retryPtz = vi.spyOn(videoApi, "retryPtz").mockResolvedValue({ ...ptzCommand, status: "SENT", message: "摄像机网关已接收（200）", deliveredAt: "2026-11-10T02:00:05.000Z" } as any);
  const retryAiEvent = vi.spyOn(videoApi, "retryAiEvent").mockResolvedValue({ ...aiEvent, forwarded: true, forwardStatus: 201, forwardMessage: "已生成虫情告警" } as any);
  const message = messages();
  const confirm = vi.fn().mockResolvedValue(true);
  const view = mountView(new URL("../src/views/video/Index.vue", import.meta.url), {
    "element-plus": { ElMessage: message, ElMessageBox: { confirm } },
    "hls.js": { __esModule: true, default: FakeHls },
    "@/api": { videoApi },
    "@/stores": { useUserStore: () => ({ hasPermission: () => options.canControl ?? true }) },
    "@/utils": { formatDateTime: (value: string) => value },
    "@/types": types,
  });
  cleanups.push(view.unmount);
  return { ...view, videoApi, createCamera, updateCamera, deleteCamera, createRecordingArchive, sendPtz, retryPtz, retryAiEvent, message, confirm };
}

describe("视频页标签页与数据接线", () => {
  it("挂载拉实时监看与完整目录，切换标签页才拉录像/AI/云台历史", async () => {
    const { state, videoApi } = mountVideo();
    await flushView();
    expect(videoApi.getCameras).toHaveBeenCalledTimes(2);
    expect(videoApi.getCameras).toHaveBeenCalledWith({ page: 1, size: 100 });
    expect(videoApi.getCameras).toHaveBeenCalledWith({ page: 1, size: 200 });
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

describe("完整摄像机目录与写权限", () => {
  it("按页拉全 200 台以上的目录，切 Tab 与名称解析不受实时查询分页影响", async () => {
    const directory = Array.from({ length: 201 }, (_, index) => ({
      ...camera, id: `camera-${index + 1}`, name: `摄像机 ${index + 1}`,
    }));
    const { state, videoApi } = mountVideo({
      cameras: [directory[0]],
      cameraPages: [
        { items: directory.slice(0, 200), total: 201 },
        { items: directory.slice(200), total: 201 },
      ],
    });
    await flushView();
    expect(videoApi.getCameras).toHaveBeenCalledWith({ page: 2, size: 200 });
    expect(state.cameraOptions).toHaveLength(201);
    expect(state.cameras).toHaveLength(1);
    expect(state.cameraName("camera-201")).toBe("摄像机 201");

    state.onTabChange("recordings");
    await flushView();
    expect(state.cameraName("camera-201")).toBe("摄像机 201");
    await state.assignCamera(0, "camera-201");
    expect(state.slotCamera(0)?.id).toBe("camera-201");
  });

  it("无 device:control 时隐藏写入口，直接调用写方法也不会发请求", async () => {
    const view = mountVideo({ canControl: false });
    const { state, message, confirm } = view;
    await flushView();
    expect(state.canControl).toBe(false);

    await state.openCameraDialog(camera);
    expect(state.cameraDialogVisible).toBe(false);
    state.cameraForm.name = "越权新增";
    await state.submitCamera();
    await state.removeCamera(camera);
    expect(confirm).not.toHaveBeenCalled();
    expect(view.deleteCamera).not.toHaveBeenCalled();

    await state.openArcDialog();
    expect(state.arcDialogVisible).toBe(false);
    state.arcForm.cameraId = camera.id;
    state.arcForm.eventAt = "2026-11-10 02:00:00";
    await state.submitArchive();
    expect(view.createRecordingArchive).not.toHaveBeenCalled();

    await state.openPtz(camera);
    expect(state.ptzDialogVisible).toBe(false);
    state.ptzCamera = camera;
    await state.ptzAction("LEFT");
    await state.retryPtzCommand(ptzCommand);
    state.onTabChange("ai");
    await flushView();
    await state.retryAiEvent(aiEvent);
    expect(view.sendPtz).not.toHaveBeenCalled();
    expect(view.retryPtz).not.toHaveBeenCalled();
    expect(view.retryAiEvent).not.toHaveBeenCalled();
    expect(message.warning).toHaveBeenCalledWith("无设备控制权限");
  });

  it("新增摄像头后同时刷新监看结果与完整目录", async () => {
    const { state, videoApi, createCamera } = mountVideo();
    await flushView();
    videoApi.getCameras.mockClear();
    state.openCameraDialog();
    state.cameraForm.name = "新增摄像机";
    await state.submitCamera();
    expect(createCamera).toHaveBeenCalledTimes(1);
    expect(videoApi.getCameras).toHaveBeenCalledWith(expect.objectContaining({ size: 10 }));
    expect(videoApi.getCameras).toHaveBeenCalledWith({ page: 1, size: 100 });
    expect(videoApi.getCameras).toHaveBeenCalledWith({ page: 1, size: 200 });
  });
});

describe("播放器异步与 KeepAlive 生命周期", () => {
  it("动态 import 返回前已销毁时不创建旧播放器，并清空媒体源", async () => {
    const { state } = mountVideo();
    await flushView();
    const video = new FakeVideo();
    state.videoEls.set("slot-0", video);
    const pending = state.playStream("slot-0", camera.streamUrl);
    state.destroyEngine("slot-0");
    await pending;
    await flushView();
    expect(FakeHls.instances).toHaveLength(0);
    expect(video.pause).toHaveBeenCalled();
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.load).toHaveBeenCalled();
  });

  it("KeepAlive 隐藏停流，激活后按原选择恢复；录像关闭也完整销毁", async () => {
    const { state } = mountVideo();
    await flushView();
    state.slots.value = [camera.id];
    const liveVideo = new FakeVideo();
    state.videoEls.set("slot-0", liveVideo);

    state.deactivatePlayback();
    expect(state.pageActive).toBe(false);
    expect(state.streamVideos.size).toBe(0);
    expect(liveVideo.pause).toHaveBeenCalled();
    await state.activatePlayback();
    // 纯 Node 渲染桩没有真实 video ref；模拟 DOM 在激活渲染后重新挂载媒体元素。
    state.videoEls.set("slot-0", liveVideo);
    await flushView();
    expect(state.pageActive).toBe(true);
    expect(state.playState["slot-0"]).toBe("loading");

    // 非模板 key 避免 Node 渲染桩用 TestNode 覆盖手动注入的媒体引用。
    const engineVideo = new FakeVideo();
    state.videoEls.set("engine-test", engineVideo);
    await state.playStream("engine-test", camera.streamUrl);
    expect(FakeHls.instances).toHaveLength(1);
    const liveHls = FakeHls.instances[0]!;
    state.destroyEngine("engine-test");
    expect(liveHls.destroy).toHaveBeenCalledTimes(1);
    expect(engineVideo.pause).toHaveBeenCalled();

    const recordingVideo = new FakeVideo();
    state.videoEls.set("recording", recordingVideo);
    await state.playStream("recording", recording.playbackUrl);
    const hls = FakeHls.instances.at(-1)!;
    state.recordingPlaying = recording;
    state.recordingDialogVisible = true;
    state.stopRecordingPlayback();
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(recordingVideo.pause).toHaveBeenCalled();
    expect(recordingVideo.removeAttribute).toHaveBeenCalledWith("src");
    expect(recordingVideo.load).toHaveBeenCalled();
    expect(state.recordingDialogVisible).toBe(false);
    expect(state.recordingPlaying).toBeNull();
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
    // 提示优先透传服务端 forwardMessage（P2 口径），不再前端拼接文案
    expect(message.success).toHaveBeenCalledWith("已生成虫情告警");
    expect(videoApi.getAiEvents).toHaveBeenCalledTimes(2);

    retryAiEvent.mockResolvedValue({ ...aiEvent, forwarded: false, forwardMessage: "遥测服务返回 503" } as any);
    await state.retryAiEvent(state.aiEvents[0]);
    expect(message.warning).toHaveBeenCalledWith("遥测服务返回 503");
    expect(message.success).toHaveBeenCalledTimes(1);
  });
});