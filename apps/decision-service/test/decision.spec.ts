import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { PrescriptionIssuedPayload } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore, InMemoryOutboxStore } from "@agri/mq";

import { createDecisionHttpServer } from "../src/http.js";
import type { DecisionDependencies } from "../src/http.js";
import { InMemoryPrescriptionRepository } from "../src/prescription.repository.js";
import { defaultRule, InMemoryRuleRepository } from "../src/rule.repository.js";
import type { Rule } from "../src/rule.repository.js";
import { RuleEngine } from "../src/rule.engine.js";
import type { RuleEvaluationInput } from "../src/rule.engine.js";

async function withServer(run: (base: string) => Promise<void>, dependencies: DecisionDependencies = {}): Promise<void> {
  const rules = new InMemoryRuleRepository();
  const prescriptions = new InMemoryPrescriptionRepository();
  const server = createDecisionHttpServer({ rules, prescriptions, ...dependencies });
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

describe("缺测输入不会触发自动规则", () => {
  it.each([undefined, null, "", "   ", false, [], {}, NaN, Infinity, -Infinity, "Infinity"])("缺测/非法数值 %j 不会被当成零", async (value) => {
    const engine = new RuleEngine(new InMemoryRuleRepository());
    for (const input of [{ soilMoisture: value, rainProbability: 0 }, { soilMoisture: 0, rainProbability: value }]) {
      expect((await engine.evaluate(input as RuleEvaluationInput)).items).toEqual([]);
    }
  });

  it("允许显式零和数字字符串，不依赖缺失字段的规则仍可命中", async () => {
    const rules = new InMemoryRuleRepository();
    const engine = new RuleEngine(rules);
    expect((await engine.evaluate({ soilMoisture: 0, rainProbability: 0 })).items).toHaveLength(1);
    expect((await engine.evaluate({ soilMoisture: "18", rainProbability: "0" } as unknown as RuleEvaluationInput)).items).toHaveLength(1);
    await rules.update("rule-soil-dry", { condition: { growthStage: "JOINTING" }, updatedAt: new Date().toISOString() });
    expect((await engine.evaluate({ growthStage: "JOINTING" })).items).toHaveLength(1);
  });
});

describe("处方分组发布与输入留痕", () => {
  it.each([false, true])("NO_ACTION 只留痕不发布（内存 outbox=%s）", async (useOutbox) => {
    const prescriptions = new InMemoryPrescriptionRepository();
    const outbox = new InMemoryOutboxStore();
    const events = new InMemoryEventLogStore();
    const publisher = new EventLogPublisher(events, { tenantId: "test", traceId: "test", producer: "decision" });
    await withServer(async (base) => {
      const result = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-1", soilMoisture: 90, rainProbability: 90 });
      expect(result.status).toBe(201);
      expect(result.body.data.status).toBe("NO_ACTION");
      expect(prescriptions.all()).toHaveLength(1);
      expect(prescriptions.all()[0]?.actions).toEqual([]);
      expect(outbox.all()).toEqual([]);
      expect(events.all()).toEqual([]);
    }, { prescriptions, publisher, ...(useOutbox ? { outbox } : {}) });
  });

  it.each([false, true])("混合动作按 action.type 分组，完整保留同类型多项（内存 outbox=%s）", async (useOutbox) => {
    const seed = defaultRule(new Date().toISOString());
    const types: Rule["action"]["type"][] = ["IRRIGATION", "FERTILIZATION", "IRRIGATION", "PEST_WARNING"];
    // 故意保留相同 rule.type，证明分类依据是动作类型。
    const rules = new InMemoryRuleRepository(types.map((type, index) => ({ ...seed, id: `rule-${index}`, priority: index, action: { ...seed.action, type, amount: index + 10 } })));
    const outbox = new InMemoryOutboxStore();
    const events = new InMemoryEventLogStore();
    const publisher = new EventLogPublisher(events, { tenantId: "test", traceId: "test", producer: "decision" });
    await withServer(async (base) => {
      const result = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-1", soilMoisture: 18, rainProbability: 0 });
      expect(result.status).toBe(201);
      const records = useOutbox ? outbox.all() : events.all().map((row) => row.event);
      const payloads = records.map((record) => record.payload as PrescriptionIssuedPayload);
      expect(payloads.map((payload) => payload.planType)).toEqual(["irrigation", "fertilization", "pesticide"]);
      expect(payloads.map((payload) => payload.items.map((item) => item.dosage))).toEqual([[10, 12], [11], [13]]);
      expect(payloads[0]?.items).toEqual([result.body.data.actions[0], result.body.data.actions[2]]);
      expect(payloads.every((payload) => payload.prescriptionId === result.body.data.id && payload.parcelId === "P-1" && payload.items.length > 0)).toBe(true);
      expect(payloads.flatMap((payload) => payload.items).every((item) => item.gridCode === "P-1" && item.windowStart && item.windowEnd)).toBe(true);
      const ids = records.map((record) => "eventId" in record ? record.eventId : record.id);
      expect(new Set(ids).size).toBe(3);
      if (useOutbox) expect(events.all()).toEqual([]);
    }, { rules, publisher, ...(useOutbox ? { outbox } : {}) });
  });

  it.each([undefined, null, "", "   ", false, "Infinity"])("请求缺测 %j 不编造 0 或 100，并标记 missing", async (value) => {
    await withServer(async (base) => {
      for (const body of [{ soilMoisture: 18, rainProbability: value }, { soilMoisture: value, rainProbability: 0 }]) {
        const result = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-1", ...body });
        expect(result.status).toBe(201);
        expect(result.body.data.status).toBe("NO_ACTION");
        const missingField = body.soilMoisture === 18 ? "rainProbability" : "soilMoisture";
        expect(result.body.data).not.toHaveProperty(missingField);
        expect(result.body.data.inputs).not.toHaveProperty(missingField);
        expect(result.body.data.inputs[`${missingField}Source`]).toBe("missing");
      }
    });
  });

  it("天气/遥测失败或返回非法值按缺测留痕，不影响已有手动数值", async () => {
    const fetchSoilMoisture = vi.fn(async (): Promise<number | undefined> => { throw new Error("telemetry unavailable"); });
    const fetchRainProbability = vi.fn(async (): Promise<number | undefined> => { throw new Error("weather unavailable"); });
    const seed = defaultRule(new Date().toISOString());
    // 阈值高于 100 也不能让旧的 soil=100 默认值触发。
    const rules = new InMemoryRuleRepository([{ ...seed, condition: { soilMoistureBelow: 120 } }]);
    await withServer(async (base) => {
      const missing = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-1" });
      expect(missing.status).toBe(201);
      expect(missing.body.data.status).toBe("NO_ACTION");
      expect(missing.body.data.inputs).toMatchObject({ soilMoistureSource: "missing", rainProbabilitySource: "missing" });
      fetchSoilMoisture.mockResolvedValueOnce(NaN);
      fetchRainProbability.mockResolvedValueOnce(Infinity);
      const invalid = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-1" });
      expect(invalid.body.data.status).toBe("NO_ACTION");
      expect(invalid.body.data.inputs).toMatchObject({ soilMoistureSource: "missing", rainProbabilitySource: "missing" });
      const valid = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-1", soilMoisture: "18", rainProbability: "0" });
      expect(valid.body.data.status).toBe("RECOMMENDED");
      expect(valid.body.data.inputs).toMatchObject({ soilMoisture: 18, rainProbability: 0, soilMoistureSource: "request", rainProbabilitySource: "request" });
      expect(fetchSoilMoisture).toHaveBeenCalledTimes(2);
      expect(fetchRainProbability).toHaveBeenCalledTimes(2);
    }, { rules, fetchSoilMoisture, fetchRainProbability });
  });

  it("有效遥测与天气可以补齐缺测，真实零仍保留来源", async () => {
    await withServer(async (base) => {
      const result = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-1", soilMoisture: null, rainProbability: "" });
      expect(result.body.data.status).toBe("RECOMMENDED");
      expect(result.body.data.inputs).toMatchObject({ soilMoisture: 18, rainProbability: 0, soilMoistureSource: "telemetry", rainProbabilitySource: "weather" });
    }, { fetchSoilMoisture: async () => 18, fetchRainProbability: async () => 0 });
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
