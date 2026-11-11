import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createTelemetryHttpServer } from "../src/http.js";
import { InMemoryPestEventRepository } from "../src/pest.repository.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "../src/reading.repository.js";

/**
 * 虫情治理与统计趋势接口验证（开发方案 6.3）：
 * 上报后可按区域/等级/类型聚合与逐日趋势，治理按状态推进并保留药剂方案，派单后不再计为待处置。
 */

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createTelemetryHttpServer({
    readings: new InMemoryReadingRepository(),
    alerts: new InMemoryAlertRepository(),
    pests: new InMemoryPestEventRepository(),
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

describe("虫情治理与统计趋势接口", () => {
  it("聚合统计、逐日趋势与治理状态推进", async () => {
    await withServer(async (base) => {
      const reported = await send(base, "POST", "/api/v1/telemetry/pest-events", {
        plotCode: PLOT, deviceId: "camera-001", pestType: "稻飞虱", level: 3, confidence: 0.9,
      });
      expect(reported.status).toBe(201);
      const id = reported.body.data.event.id as string;

      const stats = await send(base, "GET", `/api/v1/telemetry/pests/stats?plotCode=${PLOT}`);
      expect(stats.status).toBe(200);
      expect(stats.body.data).toMatchObject({ total: 1, pending: 1 });
      expect(stats.body.data.byType).toEqual([{ pestType: "稻飞虱", count: 1 }]);
      expect(stats.body.data.byLevel).toEqual([{ level: 3, count: 1 }]);
      expect(stats.body.data.byPlot).toEqual([{ plotCode: PLOT, count: 1 }]);

      const trend = await send(base, "GET", "/api/v1/telemetry/pests/trend?days=7");
      expect(trend.status).toBe(200);
      const points = trend.body.data as Array<{ date: string; count: number }>;
      expect(points).toHaveLength(7);
      expect(points.reduce((sum, point) => sum + point.count, 0)).toBe(1);
      // 日期升序且为连续农场日历日
      expect(points[0]!.date < points[points.length - 1]!.date).toBe(true);

      // 定方案：planned 不改变待处置状态
      const planned = await send(base, "POST", `/api/v1/telemetry/pests/${id}/govern`, {
        status: "planned", measure: "飞防", pesticide: "吡虫啉", dosage: "10g/亩", governedBy: "张三",
      });
      expect(planned.status).toBe(200);
      expect(planned.body.data).toMatchObject({ governanceStatus: "planned", pesticide: "吡虫啉", handled: false });

      // 派单：dispatched 记植保任务 id 并置为已处置
      const dispatched = await send(base, "POST", `/api/v1/telemetry/pests/${id}/govern`, {
        status: "dispatched", dispatchNote: "航线待无人机执行", taskId: "task-spray-1",
      });
      expect(dispatched.body.data).toMatchObject({ governanceStatus: "dispatched", handled: true, taskId: "task-spray-1" });
      // 未再传药剂方案应保留上一次的值
      expect(dispatched.body.data.pesticide).toBe("吡虫啉");

      // 归档：状态推进到 archived，说明更新
      const archived = await send(base, "POST", `/api/v1/telemetry/pests/${id}/govern`, { status: "archived", dispatchNote: "作业完成已回收" });
      expect(archived.body.data).toMatchObject({ governanceStatus: "archived", dispatchNote: "作业完成已回收" });

      const pending = await send(base, "GET", "/api/v1/telemetry/pests?pendingOnly=true");
      expect(pending.body.data).toHaveLength(0);
    });
  });

  it("非法治理状态、未知记录与非法 days 被拒绝", async () => {
    await withServer(async (base) => {
      const reported = await send(base, "POST", "/api/v1/telemetry/pest-events", { plotCode: PLOT, deviceId: "c", pestType: "蚜虫", level: 1, confidence: 0.6 });
      const id = reported.body.data.event.id as string;
      expect((await send(base, "POST", `/api/v1/telemetry/pests/${id}/govern`, { status: "pending" })).status).toBe(400);
      expect((await send(base, "POST", "/api/v1/telemetry/pests/nope/govern", { status: "planned" })).status).toBe(404);
      expect((await send(base, "GET", "/api/v1/telemetry/pests/trend?days=0")).status).toBe(400);
      expect((await send(base, "GET", "/api/v1/telemetry/pests/trend?days=999")).status).toBe(400);
    });
  });
});