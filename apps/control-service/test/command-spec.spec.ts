import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { buildIrrigationPlan, validateCommandParameters, validateIrrigationParameters, waterVolumeOf } from "../src/command-spec.js";
import { createControlHttpServer } from "../src/http.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe("水肥参数规范", () => {
  it("按亩与毫米换算用水量", () => {
    // 10 亩 × 666.67 平方米 × 10 毫米 = 66.667 立方米
    expect(waterVolumeOf(10, 10)).toBe(66.67);
    expect(waterVolumeOf(0, 10)).toBe(0);
  });

  it("拒绝非法分区、流量与配比", () => {
    expect(validateIrrigationParameters({ zones: [] })).toContain("zones 不能为空");
    expect(validateIrrigationParameters({ zones: [{ areaMu: 0, targetMm: 10 }] })).toContain("第 1 个分区 areaMu 必须大于 0");
    expect(validateIrrigationParameters({ zones: [{ areaMu: 1, targetMm: 120 }] })).toContain("第 1 个分区 targetMm 需在 0 到 100 之间");
    expect(validateIrrigationParameters({ flowM3h: 0 })).toContain("flowM3h 需在 0 到 500 之间");
    expect(validateIrrigationParameters({ recipe: { nitrogen: 0, phosphorus: 0, potassium: 0 } })).toContain("配比氮磷钾不能全为 0");
    expect(validateIrrigationParameters({ stir: { durationMin: 0, rpm: 400 } })).toEqual([
      "搅拌时长需在 1 到 120 分钟之间",
      "搅拌转速需在 0 到 300 转/分之间",
    ]);
    // 播种、除草类指令参数保持自由，不进入水肥校验
    expect(validateCommandParameters("SEEDING", { depth: 3 })).toEqual([]);
    expect(validateCommandParameters("IRRIGATION", { zones: [] })).toHaveLength(1);
  });

  it("生成分区时序、累计供水曲线与配比总量", () => {
    const plan = buildIrrigationPlan({
      plotCode: "511723-000001-01-00001-0000-5",
      flowM3h: 20,
      zones: [
        { zoneCode: "A", areaMu: 10, targetMm: 10 },
        { areaMu: 5, targetMm: 20 },
      ],
      recipe: { nitrogen: 2, phosphorus: 1, potassium: 1 },
      stir: { durationMin: 15, rpm: 60 },
    });

    expect(plan.zones[0]).toMatchObject({ zoneCode: "A", waterVolume: 66.67, startMin: 0, durationMin: 200 });
    expect(plan.zones[1]).toMatchObject({ zoneCode: "ZONE-02", waterVolume: 66.67, startMin: 200, endMin: 400 });
    expect(plan.totalWaterVolume).toBe(133.34);
    expect(plan.totalAreaMu).toBe(15);
    expect(plan.totalDurationMin).toBe(400);
    // 400 分钟超过 4 小时，应给出分次灌溉提示
    expect(plan.warnings).toHaveLength(1);
    expect(plan.curve[0]).toEqual({ minute: 0, flowM3h: 20, cumulativeM3: 0 });
    // 曲线按流量线性累积，末尾接近总量（不足一个采样步长时会略小）
    expect(plan.curve.at(-1)?.cumulativeM3).toBeCloseTo(133.33, 2);
    expect(plan.recipe).toEqual({ nitrogen: 2, phosphorus: 1, potassium: 1, totalKg: 60 });
    expect(plan.stir).toEqual({ durationMin: 15, rpm: 60 });
  });
});

describe("控制指令 HTTP 接口", () => {
  it("水肥参数非法时返回 400 且不入队", async () => {
    const base = await start(createControlHttpServer());
    const response = await fetch(`${base}/api/v1/control/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "user-admin", "x-confirm-action": "CONFIRM" },
      body: JSON.stringify({ deviceId: "device-valve-001", type: "FERTILIZATION", parameters: { zones: [{ areaMu: -1, targetMm: 10 }] } }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { message: string };
    expect(body.message).toContain("areaMu 必须大于 0");
  });

  it("灌溉方案预演返回方案但不写指令表", async () => {
    const base = await start(createControlHttpServer());
    const payload = { plotCode: "511723-000001-01-00001-0000-5", flowM3h: 20, zones: [{ areaMu: 10, targetMm: 10 }] };

    const rejected = await fetch(`${base}/api/v1/control/irrigation-plans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(rejected.status).toBe(409);

    const accepted = await fetch(`${base}/api/v1/control/irrigation-plans`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "user-admin", "x-confirm-action": "CONFIRM" },
      body: JSON.stringify(payload),
    });
    expect(accepted.status).toBe(200);
    const body = await accepted.json() as { data: { totalWaterVolume: number; zones: unknown[] } };
    expect(body.data.totalWaterVolume).toBe(66.67);
    expect(body.data.zones).toHaveLength(1);

    const commands = await fetch(`${base}/api/v1/control/commands`);
    expect((await commands.json() as { data: { total: number } }).data.total).toBe(0);
  });
});
