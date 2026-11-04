import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createDecisionHttpServer } from "../src/http.js";
import { InMemoryPrescriptionRepository } from "../src/prescription.repository.js";
import { InMemoryRuleRepository } from "../src/rule.repository.js";
import { RuleEngine } from "../src/rule.engine.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const rules = new InMemoryRuleRepository();
  const prescriptions = new InMemoryPrescriptionRepository();
  const server = createDecisionHttpServer({ rules, prescriptions });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function get(base: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

async function send(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}

describe("决策服务规则仓储", () => {
  it("新增、修改、停用规则即时反映在最新规则集（热更新）", async () => {
    const repository = new InMemoryRuleRepository();
    const seed = await repository.list();
    expect(seed.map((rule) => rule.id)).toContain("rule-soil-dry");

    const created = await repository.create({
      id: "rule-2",
      name: "拔节期补灌",
      type: "IRRIGATION",
      expression: "soilMoisture < 40 && growthStage == 'JOINTING'",
      priority: 5,
      condition: { soilMoistureBelow: 40, growthStage: "JOINTING" },
      action: { type: "IRRIGATION", amount: 25, unit: "mm", reason: "拔节期需水关键期" },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(created.id).toBe("rule-2");

    const updated = await repository.update("rule-2", { priority: 1, enabled: false, updatedAt: new Date().toISOString() });
    expect(updated?.enabled).toBe(false);

    const list = await repository.list();
    expect(list.find((rule) => rule.id === "rule-2")?.enabled).toBe(false);
    expect(await repository.count()).toBe(2);

    expect(await repository.remove("rule-2", new Date().toISOString())).toBe(true);
    expect(await repository.count()).toBe(1);
  });
});

describe("决策规则求值", () => {
  it("求值返回命中规则，且修改规则后再次求值结果变化（规则热更新）", async () => {
    const repository = new InMemoryRuleRepository();
    const engine = new RuleEngine(repository);
    const input = { plotCode: "P-1", soilMoisture: 22, rainProbability: 10, growthStage: "JOINTING" };

    const before = await engine.evaluate(input);
    expect(before.matchedRules.map((rule) => rule.id)).toEqual(["rule-soil-dry"]);
    expect(before.items[0]).toMatchObject({ materialCode: "MAT-WATER-IRRIGATION", dosage: 18 });

    await repository.create({
      id: "rule-jointing",
      name: "拔节期补灌",
      type: "IRRIGATION",
      expression: "soilMoisture < 40 && growthStage == 'JOINTING'",
      priority: 1,
      condition: { soilMoistureBelow: 40, growthStage: "JOINTING" },
      action: { type: "IRRIGATION", amount: 25, unit: "mm", reason: "拔节期需水关键期" },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const after = await engine.evaluate(input);
    expect(after.matchedRules.map((rule) => rule.id)).toEqual(["rule-jointing", "rule-soil-dry"]);
    expect(after.items).toHaveLength(2);

    // 停用后不再命中
    await repository.update("rule-jointing", { enabled: false, updatedAt: new Date().toISOString() });
    const disabled = await engine.evaluate(input);
    expect(disabled.matchedRules.map((rule) => rule.id)).toEqual(["rule-soil-dry"]);
  });

  it("条件不满足时不生成动作", async () => {
    const engine = new RuleEngine(new InMemoryRuleRepository());
    const result = await engine.evaluate({ plotCode: "P-1", soilMoisture: 80, rainProbability: 10 });
    expect(result.matchedRules).toEqual([]);
    expect(result.items).toEqual([]);
  });
});

describe("决策服务 HTTP 接口", () => {
  it("规则增改查与热更新后处方依据最新规则", async () => {
    await withServer(async (base) => {
      const created = await send(base, "POST", "/api/v1/decision/rules", {
        name: "肥力偏低追肥",
        type: "FERTILIZATION",
        expression: "soilMoisture < 20",
        priority: 1,
        condition: { soilMoistureBelow: 20 },
        action: { type: "FERTILIZATION", amount: 8, unit: "kg/亩", reason: "墒情偏低随水追肥" },
      });
      expect(created.status).toBe(201);
      const ruleId = created.body.data.id as string;

      const list = await get(base, "/api/v1/decision/rules?page=1&size=20");
      expect(list.body.data.items.some((rule: { id: string }) => rule.id === ruleId)).toBe(true);

      // 停用该规则，处方不再包含施肥动作
      const patched = await send(base, "PUT", `/api/v1/decision/rules/${ruleId}`, { enabled: false });
      expect(patched.status).toBe(200);
      expect(patched.body.data.enabled).toBe(false);

      const generated = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "511723-000001-01-00001-0000-5", plotName: "示范田", soilMoisture: 18, rainProbability: 10 });
      expect(generated.status).toBe(201);
      expect(generated.body.data.status).toBe("RECOMMENDED");
      // 留痕：输入数据快照与命中规则都在
      expect(generated.body.data.inputs.soilMoisture).toBe(18);
      expect(generated.body.data.matchedRules.map((rule: { id: string }) => rule.id)).toContain("rule-soil-dry");
      expect(generated.body.data.matchedRules.some((rule: { id: string }) => rule.id === ruleId)).toBe(false);

      const history = await get(base, `/api/v1/decision/prescriptions?plotCode=511723-000001-01-00001-0000-5`);
      expect(history.body.data.items.length).toBeGreaterThan(0);
      expect(history.body.data.items[0].matchedRules).toBeInstanceOf(Array);

      const missing = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-2", soilMoisture: 90, rainProbability: 90 });
      expect(missing.body.data.status).toBe("NO_ACTION");
      expect(missing.body.data.actions).toEqual([]);
    });
  });
});
