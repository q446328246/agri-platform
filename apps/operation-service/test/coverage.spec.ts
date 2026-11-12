import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationHttpServer } from "../src/http.js";
import { CoverageError, parseCoverageRequest, planCoverage } from "../src/coverage.js";
import type { CoveragePlan } from "../src/coverage.js";

/**
 * 覆盖式作业规划验证：等距布带、蛇形往返、内环跳洞、方向自动挑选、入场里程与参数校验。
 *
 * 用例几何取 107.42/30.98 附近，换算常数与 packages/shared/src/area.ts 相同：
 * 经度 1° ≈ 111320×cos(30.98°) ≈ 95430 米，纬度 1° ≈ 110540 米。
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

/** 约 95.4 米 × 55.3 米的矩形地块 */
const RECT = [[[107.42, 30.98], [107.421, 30.98], [107.421, 30.9805], [107.42, 30.9805], [107.42, 30.98]]];
/** 同一外环中间挖一个约 38 米 × 22 米的塘（内环与外环同级，都是点列表） */
const HOLE = [[107.4204, 30.9802], [107.4208, 30.9802], [107.4208, 30.9804], [107.4204, 30.9804], [107.4204, 30.9802]];
const WITH_HOLE = [RECT[0]!, HOLE];

function polygon(rings: number[][][]): { type: "Polygon"; coordinates: number[][][]; srid: number } {
  return { type: "Polygon", coordinates: rings, srid: 4490 };
}

describe("覆盖规划", () => {
  it("沿长边按幅宽等距布带，蛇形往返且里程分作业/转移两笔", () => {
    const plan = planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 90 });
    expect(plan.plotCode).toBe("P-RECT");
    expect(plan.headingAuto).toBe(false);
    expect(plan.laneSpacingM).toBe(10);
    // 55.3 米短边按 10 米间距 → 6 条东西向作业带，每条贯通约 95.4 米
    expect(plan.laneCount).toBe(6);
    for (const lane of plan.lanes) expect(lane.lengthM).toBeGreaterThan(94);
    for (const lane of plan.lanes) expect(lane.lengthM).toBeLessThan(97);
    expect(plan.workDistanceM).toBeGreaterThan(570);
    expect(plan.workDistanceM).toBeLessThan(576);
    // 5 次地头转移，每次正好一个间距
    expect(plan.turnCount).toBe(5);
    expect(plan.transferDistanceM).toBeCloseTo(50, 0);
    expect(plan.totalDistanceM).toBeCloseTo(plan.workDistanceM + plan.transferDistanceM, 1);
    // 默认作业 6 km/h、转移 8 km/h
    expect(plan.durationMin).toBeGreaterThan(5);
    expect(plan.durationMin).toBeLessThan(8);
    expect(plan.lanes.every((lane) => lane.pass === 1)).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it("相邻作业带首尾相接，连续路径不出现回头路", () => {
    const plan = planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 90 });
    const west = Math.min(...RECT[0]!.map((point) => point[0]));
    const east = Math.max(...RECT[0]!.map((point) => point[0]));
    plan.lanes.forEach((lane, index) => {
      const head = lane.coordinates[0]![0]!;
      const tail = lane.coordinates[1]![0]!;
      // 每条带的两端必须落在地块的东/西边界上，且横向贯通整块地
      expect(Math.abs(head - west) < 1e-6 || Math.abs(head - east) < 1e-6).toBe(true);
      expect(Math.abs(head - tail)).toBeGreaterThan(0.0009);
      const next = plan.lanes[index + 1];
      if (!next) return;
      expect(next.coordinates[0]![0]).toBeCloseTo(tail, 6);
    });
    // 未给入场点：路径折点数恰为每条带两个端点
    expect(plan.path.coordinates).toHaveLength(plan.laneCount * 2);
    expect(plan.path.srid).toBe(4490);
  });

  it("覆盖倍数按台账亩数核算，铺不满与重铺分别提示", () => {
    const plan = planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 90, areaMu: 7.91 });
    // 6 条 × 95.4 米 × 10 米幅宽 = 8.59 亩，比 7.91 亩多出边缘留白
    expect(plan.areaMu).toBe(7.91);
    expect(plan.coverageRatio).toBeGreaterThan(1.05);
    expect(plan.coverageRatio).toBeLessThan(1.15);
    // 幅宽远大于地块短边 → 单条带铺不满，报漏作业
    const sparse = planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 0, areaMu: 200 });
    expect(sparse.coverageRatio).toBeLessThan(0.98);
    expect(sparse.warnings.join()).toContain("漏作业");
  });

  it("含内环的地块自动跳洞，同一条扫描线拆成多段", () => {
    const plan = planCoverage({ plotCode: "P-HOLE", boundary: polygon(WITH_HOLE), implementWidthM: 10, headingDeg: 90 });
    const splits = plan.lanes.filter((lane) => lane.pass > 1);
    // 塘占纬度 30.9802~30.9804，两条扫描线穿过它
    expect(splits).toHaveLength(2);
    expect(plan.laneCount).toBe(8);
    expect(plan.warnings.join()).toContain("切成多段");
    // 断口按掉头处理，不是硬连过去
    expect(plan.transferDistanceM).toBeGreaterThan(70);
  });

  it("方向不填时逐个候选试算，取总里程最小的那一版", () => {
    const auto = planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10 });
    expect(auto.headingAuto).toBe(true);
    expect(auto.headingDeg).toBeGreaterThanOrEqual(0);
    expect(auto.headingDeg).toBeLessThan(180);
    // 自动结果不劣于任何手工方向
    const manual = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165].map((headingDeg) => planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, headingDeg }));
    expect(auto.totalDistanceM).toBeLessThanOrEqual(Math.min(...manual.map((plan) => plan.totalDistanceM)) + 0.1);
    // 横切短边（0°，带数最多）不是最优，自动挑的要省一截
    const crosswise = manual[0]!;
    expect(crosswise.laneCount).toBe(10);
    expect(auto.totalDistanceM).toBeLessThan(crosswise.totalDistanceM);
    expect(auto.warnings.join()).toContain("自动选定");
  });

  it("给了入场点才计入场里程", () => {
    const withoutStart = planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 90 });
    const withStart = planCoverage({
      plotCode: "P-RECT",
      boundary: polygon(RECT),
      implementWidthM: 10,
      headingDeg: 90,
      start: { lng: 107.425, lat: 30.985 },
    });
    expect(withStart.turnCount).toBe(withoutStart.turnCount + 1);
    expect(withStart.transferDistanceM).toBeGreaterThan(withoutStart.transferDistanceM + 500);
    // 路径从入场点起笔
    expect(withStart.path.coordinates[0]).toEqual([107.425, 30.985]);
    expect(withStart.path.coordinates).toHaveLength(withoutStart.path.coordinates.length + 1);
  });

  it("重叠挤掉间距、碎段并带与超限幅宽都在服务端拦住", () => {
    // 重叠 9.5 米，间距只剩 0.5 米 → 上百条带，碎段合并半径 0.25 米
    const tight = planCoverage({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, overlapM: 9.5, headingDeg: 90 });
    expect(tight.laneSpacingM).toBe(0.5);
    expect(tight.laneCount).toBeGreaterThan(100);
    expect(tight.warnings.join()).toContain("重叠");
    // 作业带条数超过 2000 直接拒算，提示核对幅宽
    const huge = { type: "Polygon" as const, srid: 4490, coordinates: [[[107.4, 30.9], [107.5, 30.9], [107.5, 31.0], [107.4, 31.0], [107.4, 30.9]]] };
    expect(() => planCoverage({ plotCode: "P-BIG", boundary: huge, implementWidthM: 0.5, headingDeg: 90 })).toThrow(CoverageError);
    // 退化几何铺不出带
    expect(() => planCoverage({ plotCode: "P-DEG", boundary: polygon([[[107.42, 30.98], [107.42, 30.98]]]), implementWidthM: 6 })).toThrow(CoverageError);
  });

  it("入参校验一次说清错误", () => {
    expect(parseCoverageRequest({}).errors.join()).toContain("plotCode");
    const badBoundary = parseCoverageRequest({ plotCode: "P", boundary: { type: "LineString", coordinates: [] }, implementWidthM: 6 });
    expect(badBoundary.errors.join()).toContain("boundary");
    const badWidth = parseCoverageRequest({ plotCode: "P", boundary: polygon(RECT), implementWidthM: 60 });
    expect(badWidth.errors.join()).toContain("implementWidthM");
    const badOverlap = parseCoverageRequest({ plotCode: "P", boundary: polygon(RECT), implementWidthM: 6, overlapM: 6 });
    expect(badOverlap.errors.join()).toContain("幅宽");
    const badHeading = parseCoverageRequest({ plotCode: "P", boundary: polygon(RECT), implementWidthM: 6, headingDeg: 400 });
    expect(badHeading.errors.join()).toContain("headingDeg");
    const badStart = parseCoverageRequest({ plotCode: "P", boundary: polygon(RECT), implementWidthM: 6, start: { lng: 999, lat: 30 } });
    expect(badStart.errors.join()).toContain("start");
    expect(parseCoverageRequest({ plotCode: "P", boundary: polygon(RECT), implementWidthM: 6 }).ok).toBe(true);
  });
});

describe("覆盖规划 HTTP", () => {
  it("返回方案并保留最近记录，非法入参 400", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/v1/operations/coverage-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plotCode: "P-001", boundary: polygon(WITH_HOLE), implementWidthM: 6, overlapM: 0.5, areaMu: 7.91 }),
    });
    expect(response.status).toBe(200);
    const plan = (await response.json() as { data: CoveragePlan }).data;
    expect(plan.planId).toBeTruthy();
    expect(plan.plotCode).toBe("P-001");
    expect(plan.laneCount).toBeGreaterThan(1);
    expect(plan.laneSpacingM).toBe(5.5);
    expect(plan.path.type).toBe("LineString");
    expect(plan.totalDistanceM).toBeGreaterThan(0);

    const history = await fetch(`${base}/api/v1/operations/coverage-plans`);
    const plans = (await history.json() as { data: CoveragePlan[] }).data;
    expect(plans[0]?.planId).toBe(plan.planId);

    const invalid = await fetch(`${base}/api/v1/operations/coverage-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plotCode: "", boundary: polygon(RECT), implementWidthM: 0 }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { message: string }).message).toContain("implementWidthM");

    const unpaintable = await fetch(`${base}/api/v1/operations/coverage-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plotCode: "P-002", boundary: { type: "Polygon", srid: 4490, coordinates: [[[107.42, 30.98], [107.421, 30.98], [107.42, 30.98]]] }, implementWidthM: 6 }),
    });
    expect(unpaintable.status).toBe(400);
    expect(((await unpaintable.json()) as { message: string }).message).toContain("作业带");
  });

  it("方案按租户隔离", async () => {
    const base = await start();
    const body = JSON.stringify({ plotCode: "P-001", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 90 });
    await fetch(`${base}/api/v1/operations/coverage-plan`, { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": "tenant-a" }, body });
    const other = await fetch(`${base}/api/v1/operations/coverage-plans`, { headers: { "x-tenant-id": "tenant-b" } });
    expect(((await other.json()) as { data: CoveragePlan[] }).data).toEqual([]);
  });
});
