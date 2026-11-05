import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { createDecisionHttpServer } from "../src/http.js";
import { InMemoryOutcomeRepository } from "../src/outcome.repository.js";
import { InMemoryPrescriptionRepository } from "../src/prescription.repository.js";
import { InMemoryRuleRepository } from "../src/rule.repository.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const rules = new InMemoryRuleRepository();
  const prescriptions = new InMemoryPrescriptionRepository();
  const outcomes = new InMemoryOutcomeRepository();
  const server = createDecisionHttpServer({ rules, prescriptions, outcomes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function send(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function createPrescription(base: string, soilMoisture: number): Promise<string> {
  const created = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-511723-00001", soilMoisture, rainProbability: 10 });
  expect(created.status).toBe(201);
  expect(created.body.data.status).toBe("RECOMMENDED");
  return created.body.data.id as string;
}

describe("处方效果回流", () => {
  it("执行后未达目标时建议提高阈值，写回后规则热更新", async () => {
    await withServer(async (base) => {
      const id = await createPrescription(base, 20);

      const missing = await send(base, "GET", `/api/v1/decision/prescriptions/${id}/outcome`);
      expect(missing.status).toBe(404);

      const invalid = await send(base, "POST", `/api/v1/decision/prescriptions/${id}/outcome`, { note: "缺少数值" });
      expect(invalid.status).toBe(400);

      // 执行后含水率仅回升 1，仍低于目标 30，给出提高阈值的建议
      const evaluated = await send(base, "POST", `/api/v1/decision/prescriptions/${id}/outcome`, { soilMoistureAfter: 21, note: "补灌后复测" });
      expect(evaluated.status).toBe(201);
      expect(evaluated.body.data.outcome.effective).toBe(false);
      expect(evaluated.body.data.outcome.delta).toBe(1);
      expect(evaluated.body.data.outcome.suggestion.suggestedThreshold).toBe(35);
      expect(evaluated.body.data.outcome.applied).toBe(false);
      expect(evaluated.body.data.rule).toBeNull();

      // 应用建议：规则条件与展示表达式同步更新
      const applied = await send(base, "POST", `/api/v1/decision/prescriptions/${id}/outcome`, { soilMoistureAfter: 21, applySuggestion: true });
      expect(applied.body.data.outcome.applied).toBe(true);
      expect(applied.body.data.rule.condition.soilMoistureBelow).toBe(35);
      expect(applied.body.data.rule.expression).toContain("soilMoisture < 35");

      // 阈值提高后，含水率 32 也会触发补灌处方
      const afterTuning = await send(base, "POST", "/api/v1/decision/prescriptions", { plotCode: "P-511723-00001", soilMoisture: 32, rainProbability: 10 });
      expect(afterTuning.body.data.status).toBe("RECOMMENDED");

      const latest = await send(base, "GET", `/api/v1/decision/prescriptions/${id}/outcome`);
      expect(latest.status).toBe(200);
      expect(latest.body.data.applied).toBe(true);
      expect(latest.body.data.prescriptionId).toBe(id);

      const unknown = await send(base, "POST", "/api/v1/decision/prescriptions/not-exist/outcome", { soilMoistureAfter: 30 });
      expect(unknown.status).toBe(404);
    });
  });

  it("执行后远超目标时建议降低阈值，避免过量灌溉", async () => {
    await withServer(async (base) => {
      const id = await createPrescription(base, 25);
      const evaluated = await send(base, "POST", `/api/v1/decision/prescriptions/${id}/outcome`, { soilMoistureAfter: 48 });
      expect(evaluated.body.data.outcome.effective).toBe(true);
      expect(evaluated.body.data.outcome.suggestion.suggestedThreshold).toBe(25);
      expect(evaluated.body.data.outcome.suggestion.reason).toContain("过量灌溉");
    });
  });
});
