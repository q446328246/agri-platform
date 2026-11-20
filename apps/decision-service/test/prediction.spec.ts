import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

import { EventTopic } from "@agri/contracts";

import { createDecisionHttpServer } from "../src/http.js";
import { InMemoryPredictionRepository } from "../src/prediction.repository.js";
import { createPredictionSweeper, predictPestRisk, predictSoilMoisture, predictYield } from "../src/prediction.js";
import type { PredictionFetchers } from "../src/prediction.js";

const NOW = new Date("2026-11-20T00:00:00.000Z");

function hoursLater(hours: number): string {
  return new Date(NOW.getTime() + hours * 3600_000).toISOString();
}

function soilSeries(values: Array<[number, number]>): Array<{ recordedAt: string; value: number }> {
  return values.map(([hour, value]) => ({ recordedAt: hoursLater(hour), value }));
}

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
  vi.restoreAllMocks();
});

describe("墒情/虫害/产量预测引擎", () => {
  it("墒情线性外推：持续下降达到预警，大幅下跌为严重", () => {
    const declining = predictSoilMoisture(soilSeries([[0, 32], [12, 30], [24, 28]]), {}, undefined, 24);
    expect(declining.predictedValue).toBe(24);
    expect(declining.level).toBe("WARNING");
    expect(declining.threshold).toBe(30);
    expect(declining.direction).toBe("below");
    expect(declining.inputs).toMatchObject({ sampleCount: 3, slopePerHour: expect.any(Number) });

    const critical = predictSoilMoisture(soilSeries([[0, 24], [12, 22.5], [24, 21]]), {}, undefined, 24);
    expect(critical.level).toBe("CRITICAL");
    expect(critical.predictedValue).toBeLessThan(20);
  });

  it("降雨概率达到抑制阈值时墒情降幅按零处理，不按持续干旱外推", () => {
    const noRain = predictSoilMoisture(soilSeries([[0, 32], [12, 30], [24, 28]]), {}, 30, 24);
    expect(noRain.level).toBe("WARNING");
    const likelyRain = predictSoilMoisture(soilSeries([[0, 32], [12, 30], [24, 28]]), {}, 80, 24);
    expect(likelyRain.predictedValue).toBe(28);
    expect(likelyRain.level).toBe("NORMAL");
    expect(likelyRain.inputs).toMatchObject({ effectiveSlopePerHour: 0 });
  });

  it("读数不足两条不外推，明确记数据不足不编数", () => {
    const single = predictSoilMoisture(soilSeries([[0, 26]]), {}, undefined, 24);
    expect(single.level).toBe("INSUFFICIENT_DATA");
    expect(single.predictedValue).toBe(26);
    const empty = predictSoilMoisture([], {}, undefined, 24);
    expect(empty.level).toBe("INSUFFICIENT_DATA");
  });

  it("虫害风险按未处置密度、严重等级与温度适宜度合成，无记录保守判正常", () => {
    const forecast = [{ date: "2026-11-20", tempMin: 22, tempMax: 26 }];
    const events = [
      { detectedAt: hoursLater(-20), level: 2 as const, handled: false, pestType: "稻飞虱" },
      { detectedAt: hoursLater(-50), level: 3 as const, handled: false, pestType: "二化螟" },
    ];
    const risk = predictPestRisk(events, forecast, {}, NOW);
    expect(risk.level).toBe("CRITICAL");
    expect(risk.predictedValue).toBeGreaterThanOrEqual(65);
    expect(risk.inputs).toMatchObject({ recentCount: 2, maxLevel: 3, tempSuitable: true });

    const noRecords = predictPestRisk([], forecast, {}, NOW);
    expect(noRecords.level).toBe("NORMAL");
    expect(noRecords.predictedValue).toBe(0);
    expect(noRecords.basis).toContain("无虫情记录");
  });

  it("产量：无农艺基线记数据不足，有基线按生育期进度折算且不预警", () => {
    const noBaseline = predictYield([{ stage: "REPRODUCTIVE", recordedAt: hoursLater(-1) }], {});
    expect(noBaseline.level).toBe("INSUFFICIENT_DATA");
    expect(noBaseline.predictedValue).toBe(-1);

    const estimated = predictYield([{ stage: "REPRODUCTIVE", recordedAt: hoursLater(-1) }], { yieldBaselineKgMu: 600 }, 24);
    expect(estimated.predictedValue).toBe(510);
    expect(estimated.level).toBe("NORMAL");
    expect(estimated.threshold).toBeUndefined();

    const unknownStage = predictYield([{ stage: "未知阶段" }], { yieldBaselineKgMu: 600 }, 24);
    expect(unknownStage.level).toBe("INSUFFICIENT_DATA");
  });
});

describe("预测扫描器", () => {
  function fakeFetchers(overrides: Partial<PredictionFetchers> = {}): PredictionFetchers {
    return {
      fetchPlotCodes: async () => ["P-1"],
      fetchSoilSeries: async () => soilSeries([[0, 32], [12, 30], [24, 28]]),
      fetchPestEvents: async () => [],
      fetchForecast: async () => [{ date: "2026-11-20", rainProbability: 20 }],
      fetchGrowthStages: async () => [],
      ...overrides,
    };
  }

  it("一轮扫描对每地块落三条预测，预警级发布事件，正常/数据不足不发布", async () => {
    const repository = new InMemoryPredictionRepository();
    const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const sweeper = createPredictionSweeper({
      repository,
      fetchers: fakeFetchers(),
      tenantId: "tenant-demo",
      publish: async (topic, payload) => { published.push({ topic, payload: payload as Record<string, unknown> }); },
      now: () => NOW,
    });

    await sweeper.runOnce();

    const soil = await repository.findLatest("P-1", "SOIL_MOISTURE");
    expect(soil?.predictedAt).toBe(hoursLater(24));
    expect(soil?.level).toBe("WARNING");
    // 墒情预警发布，虫害正常与产量数据不足不发布
    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe(EventTopic.DecisionPredictionAlert);
    expect(published[0]!.payload).toMatchObject({ parcelId: "P-1", metric: "SOIL_MOISTURE", level: "WARNING", horizonHours: 24 });
  });

  it("同一预测窗口重跑只落一条且不重复发布", async () => {
    const repository = new InMemoryPredictionRepository();
    const published: string[] = [];
    const sweeper = createPredictionSweeper({
      repository,
      fetchers: fakeFetchers(),
      tenantId: "tenant-demo",
      publish: async (topic) => { published.push(topic); },
      now: () => NOW,
    });

    await sweeper.runOnce();
    await sweeper.runOnce();

    const all = await repository.list({ plotCode: "P-1", limit: 100 });
    expect(all).toHaveLength(3);
    expect(published).toHaveLength(1);
  });

  it("地块清单拉取失败只记错误不中断，单地块失败不影响其余地块", async () => {
    const repository = new InMemoryPredictionRepository();
    const errors: string[] = [];
    const sweeper = createPredictionSweeper({
      repository,
      fetchers: fakeFetchers({
        fetchPlotCodes: async () => { throw new Error("plot service down"); },
      }),
      tenantId: "tenant-demo",
      onError: (error, phase) => { errors.push(`${phase}:${error.message}`); },
      now: () => NOW,
    });

    await sweeper.runOnce();
    expect(errors).toEqual(["plots:plot service down"]);
    expect(await repository.list({})).toEqual([]);
  });
});

describe("预测 HTTP 接口", () => {
  const savedAuthGuard: string | undefined = process.env.AUTH_GUARD_MODE;

  beforeEach(() => {
    process.env.AUTH_GUARD_MODE = "enforce";
  });

  afterEach(() => {
    if (savedAuthGuard === undefined) delete process.env.AUTH_GUARD_MODE;
    else process.env.AUTH_GUARD_MODE = savedAuthGuard;
  });

  it("预测台账按 decision:read 放行与拒绝，非法枚举返回 400", async () => {
    const repository = new InMemoryPredictionRepository();
    await repository.save(undefined, {
      tenantId: "tenant-demo", plotCode: "P-1", seasonId: "", metric: "SOIL_MOISTURE",
      predictedAt: hoursLater(24), horizonHours: 24, predictedValue: 24, level: "WARNING",
      unit: "%", threshold: 30, direction: "below", basis: "外推", inputs: {},
    });
    const base = await start(createDecisionHttpServer({ predictions: repository }));

    const anonymous = await fetch(`${base}/api/v1/decision/predictions`);
    expect(anonymous.status).toBe(401);

    const noPermission = await fetch(`${base}/api/v1/decision/predictions`, { headers: { "x-user-id": "u1", "x-permissions": "decision:role" } });
    expect(noPermission.status).toBe(403);

    const ok = await fetch(`${base}/api/v1/decision/predictions?plotCode=P-1`, { headers: { "x-user-id": "u1", "x-permissions": "decision:read" } });
    expect(ok.status).toBe(200);
    const body = (await ok.json() as { data: { items: Array<{ plotCode: string; level: string }> } }).data;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ plotCode: "P-1", level: "WARNING" });

    const badMetric = await fetch(`${base}/api/v1/decision/predictions?metric=unknown`, { headers: { "x-user-id": "u1", "x-permissions": "decision:read" } });
    expect(badMetric.status).toBe(400);
    const badLevel = await fetch(`${base}/api/v1/decision/predictions?level=unknown`, { headers: { "x-user-id": "u1", "x-permissions": "decision:read" } });
    expect(badLevel.status).toBe(400);
  });

  it("人工触发需决策写权限，未配置扫描器时明确报错", async () => {
    const runOnce = vi.fn(async () => {});
    const withSweeper = await start(createDecisionHttpServer({ predictionSweeper: { runOnce } }));

    const denied = await fetch(`${withSweeper}/api/v1/decision/predictions/run`, { method: "POST", headers: { "x-user-id": "u1", "x-permissions": "decision:read" } });
    expect(denied.status).toBe(403);

    const ok = await fetch(`${withSweeper}/api/v1/decision/predictions/run`, { method: "POST", headers: { "x-user-id": "u1", "x-permissions": "decision:write" } });
    expect(ok.status).toBe(200);
    expect(runOnce).toHaveBeenCalledTimes(1);

    const withoutSweeper = await start(createDecisionHttpServer());
    const missing = await fetch(`${withoutSweeper}/api/v1/decision/predictions/run`, { method: "POST", headers: { "x-user-id": "u1", "x-permissions": "decision:write" } });
    expect(missing.status).toBe(400);
  });
});
