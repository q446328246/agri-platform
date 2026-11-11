import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createTelemetryHttpServer } from "../src/http.js";
import { InMemoryDisasterRepository } from "../src/disaster.repository.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "../src/reading.repository.js";

/**
 * 灾情档案上报与处置接口验证（开发方案 6.4）：
 * 上报后按地块聚合灾种/等级与受灾面积，处置沿 REPORTED→ASSESSED→HANDLED→ARCHIVED 单向推进，
 * 状态回退与非法入参被拒绝；影像只登记引用，真实定损/理赔仍属外部依赖。
 */

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createTelemetryHttpServer({
    readings: new InMemoryReadingRepository(),
    alerts: new InMemoryAlertRepository(),
    disasters: new InMemoryDisasterRepository(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function send(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

const PLOT = "511723-000001-01-00001-0000-5";

describe("灾情档案上报与处置接口", () => {
  it("上报落库、区域统计与状态单向推进", async () => {
    await withServer(async (base) => {
      const reported = await send(base, "POST", "/api/v1/telemetry/disasters", {
        disasterType: "drought", plotCode: PLOT, affectedAreaMu: 12.5, severity: 3,
        occurredAt: "2026-08-01T02:00:00.000Z", suggestion: "启动应急灌溉", reportedBy: "巡查员甲", imageFileIds: ["file-1", "file-2"],
      });
      expect(reported.status).toBe(201);
      const record = reported.body.data;
      expect(record).toMatchObject({ disasterType: "drought", status: "REPORTED", affectedAreaMu: 12.5, severity: 3, imageFileIds: ["file-1", "file-2"] });
      expect(record.handledAt).toBeUndefined();
      const id = record.id as string;

      // 再来一条洪涝，验证多灾种聚合
      const second = await send(base, "POST", "/api/v1/telemetry/disasters", { disasterType: "flood", plotCode: PLOT, affectedAreaMu: 8, severity: 2, occurredAt: "2026-07-20T02:00:00.000Z" });
      expect(second.status).toBe(201);

      const stats = await send(base, "GET", `/api/v1/telemetry/disasters/stats?plotCode=${PLOT}`);
      expect(stats.status).toBe(200);
      expect(stats.body.data).toMatchObject({ total: 2, open: 2 });
      // 未受灾面积合计 = 12.5 + 8
      expect(Number(stats.body.data.affectedAreaMu.toFixed(1))).toBe(20.5);
      expect(stats.body.data.byType.map((row: { disasterType: string }) => row.disasterType).sort()).toEqual(["drought", "flood"]);
      expect(stats.body.data.bySeverity.find((row: { severity: number }) => row.severity === 3)?.count).toBe(1);

      // 核查：ASSESSED 记录处置人与处置时点
      const assessed = await send(base, "POST", `/api/v1/telemetry/disasters/${id}/supplement`, { status: "ASSESSED", lossAssessment: "减产约一成", handledBy: "农技员乙" });
      expect(assessed.status).toBe(200);
      expect(assessed.body.data).toMatchObject({ status: "ASSESSED", lossAssessment: "减产约一成", handledBy: "农技员乙" });
      expect(assessed.body.data.handledAt).toBeTruthy();
      // 未再传 suggestion 应保留上报值
      expect(assessed.body.data.suggestion).toBe("启动应急灌溉");

      // 处置 → 归档
      const handled = await send(base, "POST", `/api/v1/telemetry/disasters/${id}/supplement`, { status: "HANDLED" });
      expect(handled.body.data).toMatchObject({ status: "HANDLED" });
      const archived = await send(base, "POST", `/api/v1/telemetry/disasters/${id}/supplement`, { status: "ARCHIVED", lossAssessment: "已核损结案" });
      expect(archived.body.data).toMatchObject({ status: "ARCHIVED", lossAssessment: "已核损结案" });

      // 归档后不再计入待处理，open 只剩第二条洪涝
      const afterArchive = await send(base, "GET", `/api/v1/telemetry/disasters/stats?plotCode=${PLOT}`);
      expect(afterArchive.body.data).toMatchObject({ total: 2, open: 1 });

      const detail = await send(base, "GET", `/api/v1/telemetry/disasters/${id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({ id, status: "ARCHIVED" });
    });
  });

  it("非法灾种/等级、状态回退与未知记录被拒绝", async () => {
    await withServer(async (base) => {
      expect((await send(base, "POST", "/api/v1/telemetry/disasters", { disasterType: "typhoon", plotCode: PLOT, severity: 2 })).status).toBe(400);
      expect((await send(base, "POST", "/api/v1/telemetry/disasters", { disasterType: "drought", plotCode: PLOT, severity: 5 })).status).toBe(400);
      expect((await send(base, "POST", "/api/v1/telemetry/disasters", { disasterType: "frost", plotCode: PLOT, severity: 2, affectedAreaMu: -1 })).status).toBe(400);

      const reported = await send(base, "POST", "/api/v1/telemetry/disasters", { disasterType: "hail", plotCode: PLOT, severity: 4 });
      const id = reported.body.data.id as string;
      await send(base, "POST", `/api/v1/telemetry/disasters/${id}/supplement`, { status: "HANDLED" });
      // 从 HANDLED 回退到 ASSESSED 被拒绝
      expect((await send(base, "POST", `/api/v1/telemetry/disasters/${id}/supplement`, { status: "ASSESSED" })).status).toBe(404);
      // 非法状态值
      expect((await send(base, "POST", `/api/v1/telemetry/disasters/${id}/supplement`, { status: "DONE" })).status).toBe(400);
      // 未知记录
      expect((await send(base, "POST", "/api/v1/telemetry/disasters/nope/supplement", { status: "ASSESSED" })).status).toBe(404);
      expect((await send(base, "GET", "/api/v1/telemetry/disasters/nope")).status).toBe(404);
    });
  });
});
