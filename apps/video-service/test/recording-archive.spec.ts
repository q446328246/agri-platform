import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createVideoHttpServer } from "../src/http.js";
import type { ForwardResult } from "../src/ai-event.js";
import { InMemoryRecordingArchiveRepository, archiveWindow } from "../src/recording-archive.repository.js";
import type { RecordingArchive } from "../src/recording-archive.repository.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const detection = { cameraId: "camera-001", plotCode: "P-001", pestType: "稻飞虱", level: 2, confidence: 0.9, detectedAt: "2026-11-10T02:00:00Z" };
const forwardOk = async (): Promise<ForwardResult> => ({ forwarded: true, status: 201, message: "已生成虫情告警" });

async function request(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) }, ...init });
  return { status: response.status, body: await response.json() };
}

const post = (base: string, path: string, payload: unknown, headers: Record<string, string> = {}) =>
  request(base, path, { method: "POST", body: JSON.stringify(payload), headers });

function archive(overrides: Partial<RecordingArchive> = {}): RecordingArchive {
  const window = archiveWindow("2026-11-10T02:00:00.000Z", 30, 60);
  return {
    id: "arc-1", tenantId: "tenant-demo", cameraId: "camera-001", plotCode: "P-001",
    source: "AI_EVENT", eventId: "ai-1", eventType: "PEST", eventAt: "2026-11-10T02:00:00.000Z",
    preSeconds: 30, postSeconds: 60, startedAt: window.startedAt, endedAt: window.endedAt,
    storageKey: "", playbackUrl: "", status: "PENDING", message: "", note: "", createdAt: "2026-11-10T02:00:01.000Z",
    ...overrides,
  };
}

describe("InMemoryRecordingArchiveRepository", () => {
  it("创建、多条件分页筛选与租户隔离", async () => {
    const repo = new InMemoryRecordingArchiveRepository();
    await repo.create(archive({ id: "arc-a" }));
    await repo.create(archive({ id: "arc-b", cameraId: "camera-002", source: "MANUAL", createdAt: "2026-11-10T03:00:01.000Z" }));
    await repo.create(archive({ id: "arc-other", tenantId: "tenant-other" }));

    const all = await repo.page("tenant-demo", { page: 1, size: 10 });
    expect(all.total).toBe(2);
    expect(all.items.map((item) => item.id)).toEqual(["arc-b", "arc-a"]);
    expect((await repo.page("tenant-demo", { page: 1, size: 10, cameraId: "camera-001" })).items.map((item) => item.id)).toEqual(["arc-a"]);
    expect((await repo.page("tenant-demo", { page: 1, size: 10, source: "MANUAL" })).items.map((item) => item.id)).toEqual(["arc-b"]);
    expect((await repo.page("tenant-demo", { page: 1, size: 10, status: "ARCHIVED" })).total).toBe(0);
    expect((await repo.page("tenant-demo", { page: 1, size: 10, from: "2026-11-10T02:30:00.000Z" })).total).toBe(0);
    expect(await repo.find("tenant-other", "arc-a")).toBeNull();
  });

  it("settle 回填存储键与回放地址，未提供的字段保持原值", async () => {
    const repo = new InMemoryRecordingArchiveRepository();
    await repo.create(archive());
    const settled = await repo.settle("tenant-demo", "arc-1", { status: "ARCHIVED", storageKey: "vod/arc-1.mp4", message: "切片完成" }, "2026-11-10T02:05:00.000Z");
    expect(settled?.status).toBe("ARCHIVED");
    expect(settled?.storageKey).toBe("vod/arc-1.mp4");
    expect(settled?.playbackUrl).toBe("");
    expect(settled?.settledAt).toBe("2026-11-10T02:05:00.000Z");
    expect(await repo.settle("tenant-other", "arc-1", { status: "FAILED" })).toBeNull();
  });

  it("archiveWindow 按事件时刻前后展开窗口", () => {
    const window = archiveWindow("2026-11-10T02:00:00.000Z", 30, 60);
    expect(window.startedAt).toBe("2026-11-10T01:59:30.000Z");
    expect(window.endedAt).toBe("2026-11-10T02:01:00.000Z");
  });
});

describe("录像留档接口", () => {
  it("识别事件落库时自动登记前后窗口留档，来源可筛选", async () => {
    const video = await start(createVideoHttpServer({ forward: forwardOk }));
    const reported = await post(video, "/api/v1/video/ai-events", detection);
    expect(reported.status).toBe(201);

    const listed = await request(video, "/api/v1/video/recording-archives?source=AI_EVENT");
    expect(listed.body.data.total).toBe(1);
    const item = listed.body.data.items[0];
    expect(item.eventId).toBe(reported.body.data.id);
    expect(item.cameraId).toBe("camera-001");
    expect(item.preSeconds).toBe(30);
    expect(item.postSeconds).toBe(60);
    expect(item.startedAt).toBe("2026-11-10T01:59:30.000Z");
    expect(item.endedAt).toBe("2026-11-10T02:01:00.000Z");
    expect(item.status).toBe("PENDING");
    expect(item.playbackUrl).toBe("");
    expect((await request(video, "/api/v1/video/recording-archives?source=MANUAL")).body.data.total).toBe(0);
    expect((await request(video, "/api/v1/video/recording-archives?source=FLY")).status).toBe(400);
    expect((await request(video, "/api/v1/video/recording-archives?status=DONE")).status).toBe(400);
  });

  it("人工补登校验摄像头与窗口参数，非法输入 400/404", async () => {
    const video = await start(createVideoHttpServer({ forward: forwardOk }));
    const created = await post(video, "/api/v1/video/recording-archives", { cameraId: "camera-002", eventAt: "2026-11-10T02:00:00Z", preSeconds: 10, postSeconds: 20, note: "巡田发现异常" });
    expect(created.status).toBe(201);
    expect(created.body.data.source).toBe("MANUAL");
    expect(created.body.data.plotCode).toBe("511723-000001-02-00005-0000-C");
    expect(created.body.data.startedAt).toBe("2026-11-10T01:59:50.000Z");
    expect(created.body.data.endedAt).toBe("2026-11-10T02:00:20.000Z");

    expect((await post(video, "/api/v1/video/recording-archives", { cameraId: "camera-999", eventAt: "2026-11-10T02:00:00Z" })).status).toBe(404);
    expect((await post(video, "/api/v1/video/recording-archives", { cameraId: "camera-001", eventAt: "not-a-date" })).status).toBe(400);
    expect((await post(video, "/api/v1/video/recording-archives", { cameraId: "camera-001", eventAt: "2026-11-10T02:00:00Z", preSeconds: 601 })).status).toBe(400);
    expect((await post(video, "/api/v1/video/recording-archives", { cameraId: "camera-001", eventAt: "2026-11-10T02:00:00Z", postSeconds: -1 })).status).toBe(400);
  });

  it("内部回填只认 INTERNAL_TOKEN，留档成功必须带存储键或回放地址", async () => {
    const video = await start(createVideoHttpServer({ forward: forwardOk }));
    const created = await post(video, "/api/v1/video/recording-archives", { cameraId: "camera-001", eventAt: "2026-11-10T02:00:00Z" });
    const id = created.body.data.id as string;
    const settlePath = `/api/v1/internal/video/recording-archives/${id}/settle`;

    expect((await post(video, settlePath, { status: "ARCHIVED", storageKey: "vod/a.mp4" })).status).toBe(401);
    expect((await post(video, settlePath, { status: "ARCHIVED", storageKey: "vod/a.mp4" }, { "x-internal-token": "wrong" })).status).toBe(401);
    expect((await post(video, settlePath, { status: "ARCHIVED" }, { "x-internal-token": "agri-internal" })).status).toBe(400);
    expect((await post(video, settlePath, { status: "PENDING" }, { "x-internal-token": "agri-internal" })).status).toBe(400);

    const settled = await post(video, settlePath, { status: "ARCHIVED", storageKey: "vod/a.mp4", playbackUrl: "https://vod.example/a.m3u8", message: "切片完成" }, { "x-internal-token": "agri-internal" });
    expect(settled.status).toBe(200);
    expect(settled.body.data.status).toBe("ARCHIVED");
    expect(settled.body.data.playbackUrl).toBe("https://vod.example/a.m3u8");
    expect(settled.body.data.settledAt).toBeDefined();
    expect((await post(video, "/api/v1/internal/video/recording-archives/missing/settle", { status: "FAILED" }, { "x-internal-token": "agri-internal" })).status).toBe(404);
  });
});