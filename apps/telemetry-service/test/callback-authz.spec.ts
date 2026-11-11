import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

import { createTelemetryHttpServer } from "../src/http.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "../src/reading.repository.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createTelemetryHttpServer({ readings: new InMemoryReadingRepository(), alerts: new InMemoryAlertRepository() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function send(base: string, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}

const reading = { deviceId: "device-soil-001", plotCode: "P-001", metric: "soilMoisture", value: 30, unit: "%", recordedAt: "2026-11-10T01:00:00Z" };
const pest = { plotCode: "P-001", deviceId: "camera-001", pestType: "稻飞虱", level: 2, confidence: 0.9, detectedAt: "2026-11-10T02:00:00Z" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("遥测回调鉴权（enforce）", () => {
  it("设备上报与虫情回调必须携带有效凭证或用户写权限", async () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    vi.stubEnv("DEVICE_CALLBACK_TOKEN", "device-secret");
    await withServer(async (base) => {
      expect((await send(base, "POST", "/api/v1/telemetry/report", reading)).status).toBe(401);
      expect((await send(base, "POST", "/api/v1/telemetry/report", reading, { "x-device-token": "wrong" })).status).toBe(401);
      expect((await send(base, "POST", "/api/v1/telemetry/report", reading, { "x-device-token": "device-secret" })).status).toBe(201);

      // 人工田间核查走用户身份：写权限放行，只读拒绝
      expect((await send(base, "POST", "/api/v1/telemetry/pest-events", pest, { "x-user-id": "user-agro", "x-permissions": "telemetry:write" })).status).toBe(201);
      expect((await send(base, "POST", "/api/v1/telemetry/pest-events", pest, { "x-user-id": "user-agro", "x-permissions": "telemetry:read" })).status).toBe(403);
      expect((await send(base, "POST", "/api/v1/telemetry/pest-events", pest)).status).toBe(401);
      // 算法回调凭证同样适用于虫情入口
      expect((await send(base, "POST", "/api/v1/telemetry/pest-events", pest, { "x-device-token": "device-secret" })).status).toBe(201);

      // 查询侧不因回调放开而匿名可访问
      expect((await send(base, "GET", "/api/v1/telemetry/latest")).status).toBe(401);
      expect((await send(base, "GET", "/api/v1/telemetry/latest", undefined, { "x-user-id": "user-agro", "x-permissions": "telemetry:read" })).status).toBe(200);
    });
  });

  it("未配置回调凭证时设备通道关闭，用户写权限仍可用", async () => {
    vi.stubEnv("AUTH_GUARD_MODE", "enforce");
    vi.stubEnv("DEVICE_CALLBACK_TOKEN", "");
    await withServer(async (base) => {
      expect((await send(base, "POST", "/api/v1/telemetry/report", reading, { "x-device-token": "device-secret" })).status).toBe(401);
      expect((await send(base, "POST", "/api/v1/telemetry/report", reading, { "x-user-id": "user-agro", "x-permissions": "telemetry:write" })).status).toBe(201);
    });
  });

  it("守卫未开启时保持本地直连兼容", async () => {
    vi.stubEnv("AUTH_GUARD_MODE", "");
    await withServer(async (base) => {
      expect((await send(base, "POST", "/api/v1/telemetry/report", reading)).status).toBe(201);
    });
  });
});