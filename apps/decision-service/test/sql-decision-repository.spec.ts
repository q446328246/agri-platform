import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import type { PrescriptionExecution } from "../src/execution.repository.js";
import { SqlExecutionRepository } from "../src/execution.repository.js";
import { SqlPrescriptionRepository } from "../src/prescription.repository.js";
import { SqlOutboxStore } from "../src/outbox.repository.js";
import { SqlRuleRepository } from "../src/rule.repository.js";

/**
 * 真实库冒烟：DB_URL 存在时执行，覆盖迁移产出的表结构与 SQL 仓储读写链路。
 */
const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlRuleRepository（真实库）", () => {
  it("写入、读取、更新规则并按优先级排序", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlRuleRepository(client);
    const now = new Date().toISOString();
    const id = `rule-smoke-${Date.now()}`;
    try {
      await repository.create({
        id,
        name: "冒烟规则",
        type: "FERTILIZATION",
        expression: "soilMoisture < 25",
        priority: 1,
        condition: { soilMoistureBelow: 25 },
        action: { type: "FERTILIZATION", amount: 6, unit: "kg/亩", reason: "冒烟测试" },
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      const list = await repository.list();
      expect(list.map((rule) => rule.id)).toContain(id);
      expect(list.find((rule) => rule.id === id)?.condition.soilMoistureBelow).toBe(25);

      const updated = await repository.update(id, { priority: 0, enabled: false, updatedAt: new Date().toISOString() });
      expect(updated?.priority).toBe(0);
      expect(updated?.enabled).toBe(false);
      expect((await repository.findById(id))?.enabled).toBe(false);
    } finally {
      await repository.remove(id, new Date().toISOString());
      await client.$disconnect();
    }
  });
});

describe.runIf(databaseUrl)("SqlPrescriptionRepository（真实库）", () => {
  it("处方留痕写入后可按地块查询，并支持本地消息表入队", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlPrescriptionRepository(client);
    const outbox = new SqlOutboxStore(client);
    const now = new Date().toISOString();
    const id = `rx-smoke-${Date.now()}`;
    try {
      const created = await repository.create(undefined, {
        id,
        plotCode: "511723-000001-01-00001-0000-5",
        plotName: "冒烟示范田",
        status: "RECOMMENDED",
        soilMoisture: 22,
        rainProbability: 10,
        growthStage: "JOINTING",
        inputs: { soilMoisture: 22, rainProbability: 10, source: "smoke" },
        matchedRules: [{ id: "rule-soil-dry", name: "土壤含水率低于阈值补灌", expression: "soilMoisture < 30", action: { type: "IRRIGATION", amount: 18, unit: "mm", reason: "测试" } }],
        actions: [{ gridCode: "511723-000001-01-00001-0000-5", materialCode: "MAT-WATER-IRRIGATION", dosage: 18, windowStart: now, windowEnd: now }],
        generatedAt: now,
      });
      expect(created.issuedAt).toBe(now);

      const records = await repository.listByPlot({ plotCode: "511723-000001-01-00001-0000-5", limit: 20 });
      const hit = records.find((item) => item.id === id);
      expect(hit?.matchedRules[0]?.id).toBe("rule-soil-dry");
      expect(hit?.inputs.source).toBe("smoke");
      expect(hit?.actions[0]?.materialCode).toBe("MAT-WATER-IRRIGATION");

      await client.$transaction(async (tx) => {
        await outbox.enqueue(tx, {
          id: `evt-${Date.now()}`,
          topic: "decision.prescription.issued",
          payload: { parcelId: hit?.plotCode, seasonId: "", planType: "irrigation", items: [] },
          tenantId: "tenant-demo",
          traceId: "smoke",
          producer: "decision",
          createdAt: now,
          retryCount: 0,
        });
      });
      expect((await outbox.listPending(50)).length).toBeGreaterThan(0);
    } finally {
      await client.$executeRawUnsafe(`DELETE FROM decision_prescriptions WHERE id = $1`, id);
      await outbox.markPublished(`evt-${Date.now() - 1}`);
      await client.$executeRawUnsafe("DELETE FROM decision_outbox WHERE trace_id = 'smoke'");
      await client.$disconnect();
    }
  });
});

describe.runIf(databaseUrl)("SqlExecutionRepository（真实库，需迁移 034）", () => {
  it("结单事件按指令幂等落库，可按处方与地块查询", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlExecutionRepository(client);
    const now = new Date().toISOString();
    const stamp = Date.now();
    const recordId = `exec-smoke-${stamp}`;
    const prescriptionId = `exec-smoke-rx-${stamp}`;
    const commandId = `exec-smoke-cmd-${stamp}`;
    const plotCode = "511723-000001-01-00001-0000-5";

    const record = (durationMin: number): PrescriptionExecution => ({
      id: recordId,
      prescriptionId,
      commandId,
      plotCode,
      planType: "irrigation",
      deviceId: "device-irri-001",
      waterVolume: 133.33,
      waterVolumeSource: "PLAN",
      durationMin,
      durationSource: "RUNTIME",
      finishedAt: now,
      eventId: `exec-smoke-evt-${stamp}`,
      recordedAt: now,
    });

    try {
      expect(await repository.record(record(40))).not.toBeNull();
      // 中继重试同一条指令：ON CONFLICT (command_id) DO NOTHING 让首次留痕保持不变
      expect(await repository.record(record(99))).toBeNull();

      const byPrescription = await repository.list({ prescriptionId });
      expect(byPrescription).toHaveLength(1);
      expect(byPrescription[0]).toMatchObject({
        commandId,
        plotCode,
        planType: "irrigation",
        waterVolume: 133.33,
        waterVolumeSource: "PLAN",
        durationMin: 40,
        durationSource: "RUNTIME",
      });

      expect((await repository.list({ plotCode })).map((row) => row.commandId)).toContain(commandId);
      expect((await repository.list({ plotCode: "P-NOT-EXIST" })).some((row) => row.commandId === commandId)).toBe(false);
      expect(await repository.findByCommandId(commandId)).toMatchObject({ prescriptionId });

      // 设备没报用水量：来源与用量成对留空，读取回来也不多出字段
      const unfurnishedId = `exec-smoke-empty-${stamp}`;
      const unfurnishedRecord: PrescriptionExecution = {
        id: `exec-smoke-empty-row-${stamp}`,
        prescriptionId,
        commandId: unfurnishedId,
        plotCode,
        planType: "irrigation",
        deviceId: "device-irri-002",
        durationMin: 12,
        durationSource: "RUNTIME",
        finishedAt: now,
        eventId: `exec-smoke-empty-evt-${stamp}`,
        recordedAt: now,
      };
      expect(await repository.record(unfurnishedRecord)).not.toBeNull();
      const readBack = await repository.findByCommandId(unfurnishedId);
      expect(readBack).toBeDefined();
      expect("waterVolume" in readBack!).toBe(false);
      expect("waterVolumeSource" in readBack!).toBe(false);
    } finally {
      await client.$executeRawUnsafe("DELETE FROM decision_prescription_executions WHERE prescription_id = $1", prescriptionId);
      await client.$disconnect();
    }
  });
});
