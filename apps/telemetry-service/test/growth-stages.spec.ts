import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createTelemetryHttpServer } from "../src/http.js";
import { InMemoryGrowthStageRepository } from "../src/growth.repository.js";

/**
 * 苗情生育期档案接口验证：登记计划/实际节点、按地块回看、同地块同生育期幂等更新、删除与入参校验。
 */

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createTelemetryHttpServer({ growth: new InMemoryGrowthStageRepository() });
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

describe("苗情生育期档案接口", () => {
  it("登记计划与实际节点、按地块回看并幂等更新", async () => {
    await withServer(async (base) => {
      const empty = await send(base, "GET", `/api/v1/telemetry/growth-stages?plotCode=${PLOT}`);
      expect(empty.status).toBe(200);
      expect(empty.body.data).toHaveLength(0);

      const created = await send(base, "POST", "/api/v1/telemetry/growth-stages", {
        plotCode: PLOT,
        stage: "tillering",
        plannedStartAt: "2026-06-10T00:00:00+08:00",
        plannedEndAt: "2026-06-25T00:00:00+08:00",
        note: "分蘖期计划",
      });
      expect(created.status).toBe(200);
      const stage = created.body.data;
      expect(stage).toMatchObject({ plotCode: PLOT, stage: "tillering", note: "分蘖期计划" });
      expect(stage.plannedStartAt).toBe("2026-06-09T16:00:00.000Z");
      expect(stage.actualStartAt).toBeUndefined();

      // 补登实际节点：同地块同生育期应更新而非新增，id 不变
      const updated = await send(base, "POST", "/api/v1/telemetry/growth-stages", {
        plotCode: PLOT,
        stage: "tillering",
        plannedStartAt: "2026-06-10T00:00:00+08:00",
        plannedEndAt: "2026-06-25T00:00:00+08:00",
        actualStartAt: "2026-06-12T00:00:00+08:00",
        note: "实际晚 2 天",
      });
      expect(updated.body.data.id).toBe(stage.id);
      expect(updated.body.data.actualStartAt).toBe("2026-06-11T16:00:00.000Z");

      const list = await send(base, "GET", `/api/v1/telemetry/growth-stages?plotCode=${PLOT}`);
      expect(list.body.data).toHaveLength(1);

      // 另一地块的记录不串档
      await send(base, "POST", "/api/v1/telemetry/growth-stages", { plotCode: "other-plot", stage: "heading" });
      const filtered = await send(base, "GET", `/api/v1/telemetry/growth-stages?plotCode=${PLOT}`);
      expect(filtered.body.data).toHaveLength(1);
      const all = await send(base, "GET", "/api/v1/telemetry/growth-stages");
      expect(all.body.data).toHaveLength(2);

      const removed = await send(base, "DELETE", `/api/v1/telemetry/growth-stages/${stage.id as string}`);
      expect(removed.status).toBe(200);
      const afterRemove = await send(base, "GET", `/api/v1/telemetry/growth-stages?plotCode=${PLOT}`);
      expect(afterRemove.body.data).toHaveLength(0);
      const missing = await send(base, "DELETE", `/api/v1/telemetry/growth-stages/${stage.id as string}`);
      expect(missing.status).toBe(404);
    });
  });

  it("缺地块/生育期或非法时间拒绝登记", async () => {
    await withServer(async (base) => {
      expect((await send(base, "POST", "/api/v1/telemetry/growth-stages", { stage: "tillering" })).status).toBe(400);
      expect((await send(base, "POST", "/api/v1/telemetry/growth-stages", { plotCode: PLOT })).status).toBe(400);
      expect((await send(base, "POST", "/api/v1/telemetry/growth-stages", { plotCode: PLOT, stage: "tillering", actualStartAt: "not-a-date" })).status).toBe(400);
    });
  });
});