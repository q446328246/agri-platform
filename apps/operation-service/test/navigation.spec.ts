import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createOperationHttpServer } from "../src/http.js";
import { planNavigation, parseNavigationRequest } from "../src/navigation.js";
import type { NavPlan } from "../src/navigation.js";

/**
 * 田间导航验证：站点顺序优化、直线与机耕道两种里程口径、参数校验与 HTTP 留痕。
 */

const servers: Server[] = [];

async function start(): Promise<string> {
  const server = createOperationHttpServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const START = { code: "START", name: "农机库", lng: 107.42, lat: 30.98 };

describe("导航规划", () => {
  it("按最近邻排站，直线口径给出分段里程与耗时", () => {
    const plan = planNavigation({
      start: START,
      stops: [
        { code: "B", name: "二站", lng: 107.422, lat: 30.98 },
        { code: "A", name: "一站", lng: 107.421, lat: 30.98 },
        { code: "C", name: "三站", lng: 107.42, lat: 30.981 },
      ],
      speedKmh: 8,
    });
    // 起点向东：A(约 95 米) 比 C(约 110 米) 更近，B 在 A 之后
    expect(plan.order).toEqual(["A", "B", "C"]);
    expect(plan.legs).toHaveLength(3);
    expect(plan.legs[0]?.fromCode).toBe("START");
    expect(plan.legs[0]?.distanceM).toBeGreaterThan(90);
    expect(plan.legs[0]?.distanceM).toBeLessThan(100);
    expect(plan.distanceM).toBeGreaterThan(400);
    expect(plan.distanceM).toBeLessThan(425);
    // 8 km/h 约 133 米/分钟，全程约 3 分钟
    expect(plan.durationMin).toBeCloseTo(plan.distanceM / 133.33, 0);
    expect(plan.warnings.join()).toContain("直线距离");
    expect(plan.polyline.coordinates.length).toBeGreaterThanOrEqual(4);
  });

  it("提供机耕道时按沿路距离，站点离路太远则退回直线并提示", () => {
    const road = { type: "LineString" as const, srid: 4490, coordinates: [[107.42, 30.98], [107.43, 30.98]] };
    const plan = planNavigation({
      start: { ...START, lat: 30.9802 },
      stops: [
        { code: "A", lng: 107.4245, lat: 30.9802 },
        { code: "B", lng: 107.4295, lat: 30.9802 },
      ],
      roadNetwork: [road],
    });
    expect(plan.order).toEqual(["A", "B"]);
    expect(plan.legs.every((leg) => leg.viaRoad)).toBe(true);
    // 两端各约 22 米的吸附距离 + 沿路 430 米，A→B 再 477 米
    expect(plan.distanceM).toBeGreaterThan(950);
    expect(plan.distanceM).toBeLessThan(1050);

    // 距离机耕道超过 300 米的站点不硬凑路网
    const far = planNavigation({
      start: START,
      stops: [{ code: "FAR", lng: 107.425, lat: 30.99 }],
      roadNetwork: [road],
    });
    expect(far.legs[0]?.viaRoad).toBe(false);
    expect(far.warnings.join()).toContain("距机耕道");
  });

  it("闭环作业把起点接回队尾", () => {
    const stops = [{ code: "A", lng: 107.421, lat: 30.98 }];
    const open = planNavigation({ start: START, stops });
    const loop = planNavigation({ start: START, stops, returnToStart: true });
    expect(loop.order).toEqual(["A"]);
    expect(loop.legs).toHaveLength(2);
    expect(loop.distanceM).toBeGreaterThan(open.distanceM);
  });

  it("入参校验一次说清错误", () => {
    expect(parseNavigationRequest({}).ok).toBe(false);
    const noStops = parseNavigationRequest({ start: { lng: 107.42, lat: 30.98 }, stops: [] });
    expect(noStops.errors.join()).toContain("至少需要一个");
    const badPoint = parseNavigationRequest({ start: { lng: 999, lat: 30.98 }, stops: [{ code: "A", lng: 107.4, lat: 30.9 }] });
    expect(badPoint.errors.join()).toContain("start");
    const badSpeed = parseNavigationRequest({ start: { lng: 107.42, lat: 30.98 }, stops: [{ code: "A", lng: 107.4, lat: 30.9 }], speedKmh: 90 });
    expect(badSpeed.errors.join()).toContain("speedKmh");
  });
});

describe("导航 HTTP", () => {
  it("返回方案并保留最近记录，非法入参 400", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/v1/operations/path-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: { code: "START", name: "农机库", lng: 107.42, lat: 30.98 },
        stops: [
          { code: "P-001", name: "东一号", lng: 107.423, lat: 30.981 },
          { code: "P-002", name: "东二号", lng: 107.426, lat: 30.982 },
        ],
        speedKmh: 10,
        roadNetwork: [{ type: "LineString", srid: 4490, coordinates: [[107.42, 30.98], [107.428, 30.982]] }],
      }),
    });
    expect(response.status).toBe(200);
    const plan = (await response.json() as { data: NavPlan }).data;
    expect(plan.planId).toBeTruthy();
    expect(plan.order).toHaveLength(2);
    expect(plan.legs.length).toBe(2);
    expect(plan.polyline.type).toBe("LineString");

    const history = await fetch(`${base}/api/v1/operations/path-plans`);
    const plans = (await history.json() as { data: NavPlan[] }).data;
    expect(plans[0]?.planId).toBe(plan.planId);

    const invalid = await fetch(`${base}/api/v1/operations/path-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: { lng: 107.42, lat: 30.98 }, stops: [] }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { message: string }).message).toContain("stops");
  });
});
