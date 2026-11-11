import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createVideoHttpServer } from "../src/http.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const detection = { cameraId: "camera-001", plotCode: "P-001", pestType: "稻飞虱", level: 2, confidence: 0.9, detectedAt: "2026-11-10T02:00:00Z" };

async function post(base: string, path: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}

describe("视频 AI 回调鉴权（enforce）", () => {
  it("识别上报认设备凭证，转发遥测时携带同一凭证", async () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    vi.stubEnv("DEVICE_CALLBACK_TOKEN", "device-secret");
    const received: Array<{ token: string; body: string }> = [];
    const telemetry = await start(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ token: request.headers["x-device-token"]?.toString() ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "OK", data: {} }));
    }));
    vi.stubEnv("TELEMETRY_BASE_URL", telemetry);
    const video = await start(createVideoHttpServer());

    expect((await post(video, "/api/v1/video/ai-events", detection)).status).toBe(401);
    expect((await post(video, "/api/v1/video/ai-events", detection, { "x-device-token": "wrong" })).status).toBe(401);
    const ok = await post(video, "/api/v1/video/ai-events", detection, { "x-device-token": "device-secret" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.forwarded).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.token).toBe("device-secret");
    expect(JSON.parse(received[0]!.body)).toMatchObject({ deviceId: "camera-001", pestType: "稻飞虱", level: 2 });

    // 查询识别记录仍需设备查看权限，不因回调放开而匿名可访问
    expect((await fetch(`${video}/api/v1/video/ai-events`)).status).toBe(401);
    expect((await fetch(`${video}/api/v1/video/ai-events`, { headers: { "x-user-id": "user-1", "x-permissions": "device:read" } })).status).toBe(200);
  });

  it("用户设备控制权限可人工上报，只读被拒；遥测不可达时保留记录返回 202", async () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    vi.stubEnv("DEVICE_CALLBACK_TOKEN", "device-secret");
    vi.stubEnv("TELEMETRY_BASE_URL", "http://127.0.0.1:1");
    const video = await start(createVideoHttpServer());
    expect((await post(video, "/api/v1/video/ai-events", detection, { "x-user-id": "user-1", "x-permissions": "device:read" })).status).toBe(403);
    const ok = await post(video, "/api/v1/video/ai-events", detection, { "x-user-id": "user-1", "x-permissions": "device:control" });
    expect(ok.status).toBe(202);
    expect(ok.body.data.forwarded).toBe(false);
  });

  it("守卫未开启时匿名上报保持兼容，非法识别结果仍 400", async () => {
    vi.stubEnv("AUTH_GUARD_MODE", "");
    vi.stubEnv("TELEMETRY_BASE_URL", "http://127.0.0.1:1");
    const video = await start(createVideoHttpServer());
    expect((await post(video, "/api/v1/video/ai-events", detection)).status).toBe(202);
    expect((await post(video, "/api/v1/video/ai-events", { ...detection, level: 4 })).status).toBe(400);
  });
});