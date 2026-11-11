import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createVideoHttpServer } from "../src/http.js";
import type { PtzChannel } from "../src/ptz-channel.js";
import type { ForwardResult } from "../src/ai-event.js";

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

async function request(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) }, ...init });
  return { status: response.status, body: await response.json() };
}

const post = (base: string, path: string, payload: unknown, headers: Record<string, string> = {}) =>
  request(base, path, { method: "POST", body: JSON.stringify(payload), headers });

function stubChannel(configured: boolean, ok: boolean): PtzChannel {
  return { configured, deliver: async () => ({ ok, message: ok ? "摄像机网关已接收（200）" : "摄像机网关返回 503" }) };
}

describe("视频 AI 事件接口", () => {
  it("先落库再转发：失败 202 保留记录，人工重试成功后不可重复重试", async () => {
    let attempts = 0;
    const forward = async (): Promise<ForwardResult> => {
      attempts += 1;
      return attempts === 1 ? { forwarded: false, status: 0, message: "遥测服务不可达" } : { forwarded: true, status: 201, message: "已生成虫情告警" };
    };
    const video = await start(createVideoHttpServer({ forward }));

    const failed = await post(video, "/api/v1/video/ai-events", detection);
    expect(failed.status).toBe(202);
    expect(failed.body.data.forwarded).toBe(false);
    expect(failed.body.data.retryCount).toBe(1);
    expect(failed.body.data.lastError).toBe("遥测服务不可达");
    const id = failed.body.data.id as string;

    const listed = await request(video, "/api/v1/video/ai-events");
    expect(listed.body.data.total).toBe(1);
    expect((await request(video, "/api/v1/video/ai-events?forwarded=false")).body.data.total).toBe(1);
    expect((await request(video, "/api/v1/video/ai-events?forwarded=true")).body.data.total).toBe(0);
    expect((await request(video, "/api/v1/video/ai-events?plotCode=P-001")).body.data.total).toBe(1);
    expect((await request(video, "/api/v1/video/ai-events?plotCode=P-999")).body.data.total).toBe(0);

    const retried = await post(video, `/api/v1/video/ai-events/${id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body.data.forwarded).toBe(true);
    expect(retried.body.data.forwardedAt).toBeDefined();
    expect(retried.body.data.lastError).toBeUndefined();
    expect((await post(video, `/api/v1/video/ai-events/${id}/retry`, {})).status).toBe(400);
    expect((await post(video, "/api/v1/video/ai-events/missing/retry", {})).status).toBe(404);
  });

  it("非法分页与 forwarded 筛选返回 400，租户头隔离记录", async () => {
    const forward = async (): Promise<ForwardResult> => ({ forwarded: true, status: 201, message: "已生成虫情告警" });
    const video = await start(createVideoHttpServer({ forward }));
    expect((await request(video, "/api/v1/video/ai-events?page=0")).status).toBe(400);
    expect((await request(video, "/api/v1/video/ai-events?size=999")).status).toBe(400);
    expect((await request(video, "/api/v1/video/ai-events?forwarded=maybe")).status).toBe(400);

    await post(video, "/api/v1/video/ai-events", detection, { "x-tenant-id": "tenant-a" });
    expect((await request(video, "/api/v1/video/ai-events", { headers: { "x-tenant-id": "tenant-a" } })).body.data.total).toBe(1);
    expect((await request(video, "/api/v1/video/ai-events", { headers: { "x-tenant-id": "tenant-b" } })).body.data.total).toBe(0);
  });
});

describe("云台指令接口", () => {
  it("未配置通道时留存 QUEUED 并明示原因，历史可查", async () => {
    const video = await start(createVideoHttpServer());
    const queued = await post(video, "/api/v1/video/cameras/camera-001/ptz", { action: "LEFT", speed: 5 });
    expect(queued.status).toBe(202);
    expect(queued.body.data.status).toBe("QUEUED");
    expect(queued.body.data.speed).toBe(5);
    expect(queued.body.data.message).toContain("未配置");
    expect(queued.body.data.deliveredAt).toBeUndefined();

    const history = await request(video, "/api/v1/video/ptz-commands?cameraId=camera-001");
    expect(history.body.data.total).toBe(1);
    expect(history.body.data.items[0].id).toBe(queued.body.data.id);
    expect((await request(video, "/api/v1/video/ptz-commands?cameraId=camera-002")).body.data.total).toBe(0);

    const retried = await post(video, `/api/v1/video/ptz-commands/${queued.body.data.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe("QUEUED");
  });

  it("配置通道后按真实响应落 SENT/FAILED，失败可重试、成功不可重复", async () => {
    let ok = false;
    const channel: PtzChannel = { configured: true, deliver: async () => ({ ok, message: ok ? "摄像机网关已接收（200）" : "摄像机网关返回 503" }) };
    const video = await start(createVideoHttpServer({ channel }));

    const failed = await post(video, "/api/v1/video/cameras/camera-001/ptz", { action: "ZOOM_IN" });
    expect(failed.status).toBe(202);
    expect(failed.body.data.status).toBe("FAILED");
    expect(failed.body.data.deliveredAt).toBeDefined();

    ok = true;
    const retried = await post(video, `/api/v1/video/ptz-commands/${failed.body.data.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe("SENT");
    expect((await post(video, `/api/v1/video/ptz-commands/${failed.body.data.id}/retry`, {})).status).toBe(400);
    expect((await post(video, "/api/v1/video/ptz-commands/missing/retry", {})).status).toBe(404);

    const sent = await post(video, "/api/v1/video/cameras/camera-002/ptz", { action: "STOP" });
    expect(sent.body.data.status).toBe("SENT");
  });

  it("非法动作、速度与未知摄像头返回 400/404", async () => {
    const video = await start(createVideoHttpServer({ channel: stubChannel(true, true) }));
    expect((await post(video, "/api/v1/video/cameras/camera-001/ptz", { action: "FLY" })).status).toBe(400);
    expect((await post(video, "/api/v1/video/cameras/camera-001/ptz", {})).status).toBe(400);
    expect((await post(video, "/api/v1/video/cameras/camera-001/ptz", { action: "UP", speed: 0 })).status).toBe(400);
    expect((await post(video, "/api/v1/video/cameras/camera-001/ptz", { action: "UP", speed: 11 })).status).toBe(400);
    expect((await post(video, "/api/v1/video/cameras/camera-001/ptz", { action: "UP", speed: 1.5 })).status).toBe(400);
    expect((await post(video, "/api/v1/video/cameras/camera-999/ptz", { action: "UP" })).status).toBe(404);
    const lower = await post(video, "/api/v1/video/cameras/camera-001/ptz", { action: "down" });
    expect(lower.status).toBe(202);
    expect(lower.body.data.action).toBe("DOWN");
  });
});

describe("摄像头与录像查询保持兼容", () => {
  it("摄像头状态筛选与录像按摄像头/时间窗口过滤", async () => {
    const video = await start(createVideoHttpServer());
    const online = await request(video, "/api/v1/video/cameras?status=ONLINE");
    expect(online.body.data.total).toBe(3);
    const byPlot = await request(video, "/api/v1/video/cameras?plotCode=511723-000001-01-00001-0000-5");
    expect(byPlot.body.data.items[0].id).toBe("camera-001");
    const recordings = await request(video, "/api/v1/video/recordings?cameraId=camera-001");
    expect(recordings.body.data.total).toBe(1);
    expect(recordings.body.data.items[0].id).toBe("rec-demo-001");
    const none = await request(video, "/api/v1/video/recordings?from=2099-01-01");
    expect(none.body.data.total).toBe(0);
  });
});