import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationHttpServer } from "../src/http.js";
import { planCoverage } from "../src/coverage.js";
import { parseVariableRateRequest, planVariableRate } from "../src/variable-rate.js";
import type { RateGrid, VariableRateInput, VariableRatePlan } from "../src/variable-rate.js";
import type { VariableRatePlanRecord } from "../src/variable-rate.repository.js";

/**
 * 变量播种/施肥规划验证（A15）：路径里程与覆盖方案同口径、逐带速率映射、
 * 用量汇总、空网格降级与参数校验。几何与换算常数沿用 coverage.spec 的口径：
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

/** 约 95.4 米 × 55.3 米的矩形地块，与 coverage.spec 同一夹具 */
const RECT = [[[107.42, 30.98], [107.421, 30.98], [107.421, 30.9805], [107.42, 30.9805], [107.42, 30.98]]];

function polygon(rings: number[][][]): { type: "Polygon"; coordinates: number[][][]; srid: number } {
  return { type: "Polygon", coordinates: rings, srid: 4490 };
}

/** 铺满 RECT 的 10 米网格：格值随经度线性升高（西弱东强），模拟长势差异 */
function gradientGrid(): RateGrid {
  const cells: Array<{ center: number[]; value: number }> = [];
  for (let lng = 107.42005; lng < 107.421; lng += 0.0001) {
    for (let lat = 30.98005; lat < 30.9805; lat += 0.0001) {
      cells.push({ center: [Number(lng.toFixed(6)), Number(lat.toFixed(6))], value: Math.round((lng - 107.42) * 1e5) });
    }
  }
  return { cellSizeM: 10, cells };
}

function inputOf(overrides: Partial<VariableRateInput> = {}): VariableRateInput {
  return {
    coverage: { plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 0 },
    operationType: "FERTILIZATION",
    metric: "canopyCoverage",
    baseRateKgMu: 15,
    minRateKgMu: 10,
    maxRateKgMu: 25,
    ...overrides,
  };
}

describe("变量速率规划", () => {
  it("路径里程与耗时和单独覆盖规划完全一致，不另算一套", () => {
    const input = inputOf({ rateGrid: gradientGrid() });
    const variable = planVariableRate(input);
    const plain = planCoverage(input.coverage);
    expect(variable.workDistanceM).toBe(plain.workDistanceM);
    expect(variable.transferDistanceM).toBe(plain.transferDistanceM);
    expect(variable.totalDistanceM).toBe(plain.totalDistanceM);
    expect(variable.durationMin).toBe(plain.durationMin);
    expect(variable.lanes.map((lane) => lane.index)).toEqual(plain.lanes.map((lane) => lane.index));
    expect(variable.lanes.map((lane) => lane.lengthM)).toEqual(plain.lanes.map((lane) => lane.lengthM));
  });

  it("南北向作业带逐带取格值：东侧长势强速率高，速率都落在区间内", () => {
    const plan = planVariableRate(inputOf({ rateGrid: gradientGrid() }));
    expect(plan.lanes.length).toBeGreaterThan(5);
    for (const lane of plan.lanes) {
      expect(lane.rateKgMu).toBeGreaterThanOrEqual(10);
      expect(lane.rateKgMu).toBeLessThanOrEqual(25);
      expect(lane.avgGridValue).not.toBeNull();
    }
    // heading 0 的垂直轴指向西，铺带自东向西排：格值随经度升高，首带（东）速率应高于末带（西）
    const first = plan.lanes[0]!;
    const last = plan.lanes[plan.lanes.length - 1]!;
    expect(first.rateKgMu).toBeGreaterThan(last.rateKgMu);
    expect(first.avgGridValue!).toBeGreaterThan(last.avgGridValue!);
  });

  it("invert 口径反转：弱苗区（低格值）反而拿到更高施肥速率", () => {
    const normal = planVariableRate(inputOf({ rateGrid: gradientGrid() }));
    const inverted = planVariableRate(inputOf({ rateGrid: gradientGrid(), invert: true }));
    // 铺带自东向西：末带在西侧弱苗区，invert 后应拿到比正常口径更高的速率
    const lastNormal = normal.lanes[normal.lanes.length - 1]!.rateKgMu;
    const lastInverted = inverted.lanes[inverted.lanes.length - 1]!.rateKgMu;
    expect(lastInverted).toBeGreaterThan(lastNormal);
    // 同一带两种口径的速率关于区间中点对称
    expect(lastInverted + lastNormal).toBeCloseTo(35, 0);
  });

  it("用量汇总：总用量等于逐带用量之和，平均速率按面积加权", () => {
    const plan = planVariableRate(inputOf({ rateGrid: gradientGrid() }));
    const sumAmount = plan.lanes.reduce((sum, lane) => sum + lane.amountKg, 0);
    expect(plan.totalAmountKg).toBeCloseTo(sumAmount, 0);
    const sumArea = plan.lanes.reduce((sum, lane) => sum + lane.areaMu, 0);
    expect(plan.avgRateKgMu).toBeCloseTo(plan.totalAmountKg / sumArea, 1);
    for (const lane of plan.lanes) {
      expect(lane.amountKg).toBeCloseTo(lane.rateKgMu * lane.areaMu, 1);
    }
  });

  it("格值均一时取速率区间中点，不偏向任一极端", () => {
    const grid = gradientGrid();
    for (const cell of grid.cells) cell.value = 50;
    const plan = planVariableRate(inputOf({ rateGrid: grid }));
    for (const lane of plan.lanes) expect(lane.rateKgMu).toBe(17.5);
    expect(plan.avgRateKgMu).toBe(17.5);
  });

  it("空网格降级：全部作业带按基础速率均一作业并给警告，不编造格值", () => {
    const plan = planVariableRate(inputOf());
    for (const lane of plan.lanes) {
      expect(lane.rateKgMu).toBe(15);
      expect(lane.avgGridValue).toBeNull();
    }
    expect(plan.avgRateKgMu).toBe(15);
    expect(plan.warnings.some((warning) => warning.includes("无长势网格样本"))).toBe(true);
  });

  it("参数校验：速率非法、上下限颠倒、网格非法一次说清", () => {
    expect(() => planVariableRate(inputOf({ minRateKgMu: 30, maxRateKgMu: 20 }))).toThrow("minRateKgMu");
    const missing = parseVariableRateRequest({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10 });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join("；")).toContain("baseRateKgMu");
    const badType = parseVariableRateRequest({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, operationType: "SPRAYING", baseRateKgMu: 15, minRateKgMu: 10, maxRateKgMu: 25 });
    expect(badType.ok).toBe(false);
    expect(badType.errors.join("；")).toContain("operationType");
    const badGrid = parseVariableRateRequest({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, baseRateKgMu: 15, minRateKgMu: 10, maxRateKgMu: 25, rateGrid: { cellSizeM: 10, cells: [{ center: [107.42], value: "x" }] } });
    expect(badGrid.ok).toBe(false);
    expect(badGrid.errors.join("；")).toContain("rateGrid.cells");
    const ok = parseVariableRateRequest({ plotCode: "P-RECT", boundary: polygon(RECT), implementWidthM: 10, baseRateKgMu: 15, minRateKgMu: 10, maxRateKgMu: 25, rateGrid: gradientGrid() });
    expect(ok.ok).toBe(true);
    expect(ok.input?.operationType).toBe("FERTILIZATION");
  });
});

describe("变量速率 HTTP", () => {
  it("返回方案并留痕可回查，非法入参 400", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/v1/operations/variable-rate-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plotCode: "P-001", boundary: polygon(RECT), implementWidthM: 10, headingDeg: 0, operationType: "FERTILIZATION", metric: "canopyCoverage", baseRateKgMu: 15, minRateKgMu: 10, maxRateKgMu: 25, rateGrid: gradientGrid() }),
    });
    expect(response.status).toBe(200);
    const plan = (await response.json() as { data: VariableRatePlan }).data;
    expect(plan.planId).toBeTruthy();
    expect(plan.coverage.laneCount).toBeGreaterThan(1);
    expect(plan.totalAmountKg).toBeGreaterThan(0);
    expect(plan.lanes.length).toBe(plan.coverage.laneCount);

    const history = await fetch(`${base}/api/v1/operations/variable-rate-plans`);
    const records = (await history.json() as { data: VariableRatePlanRecord[] }).data;
    expect(records[0]?.id).toBe(plan.planId);
    expect(records[0]?.plan.totalAmountKg).toBe(plan.totalAmountKg);

    const invalid = await fetch(`${base}/api/v1/operations/variable-rate-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plotCode: "P-001", boundary: polygon(RECT), implementWidthM: 10, baseRateKgMu: -1, minRateKgMu: 10, maxRateKgMu: 25 }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { message: string }).message).toContain("baseRateKgMu");
  });

  it("方案留痕按租户隔离", async () => {
    const base = await start();
    const body = JSON.stringify({ plotCode: "P-001", boundary: polygon(RECT), implementWidthM: 10, baseRateKgMu: 15, minRateKgMu: 10, maxRateKgMu: 25 });
    await fetch(`${base}/api/v1/operations/variable-rate-plan`, { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": "tenant-a" }, body });
    const other = await fetch(`${base}/api/v1/operations/variable-rate-plans`, { headers: { "x-tenant-id": "tenant-b" } });
    expect(((await other.json()) as { data: VariableRatePlanRecord[] }).data).toEqual([]);
  });
});