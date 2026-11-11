import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import { SqlRuleRepository } from "../src/rule.repository.js";
import type { RuleLevel, TelemetryRule } from "../src/rule.repository.js";

const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlRuleRepository（真实库）", () => {
  it("地块分级阈值幂等写入、专属优先全局兜底与按级删除", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const rules = new SqlRuleRepository(client);
    const metric = `tierMetric-${Date.now()}`;
    const plot = `P-TIER-${Date.now()}`;
    const now = new Date().toISOString();
    const make = (level: RuleLevel, threshold: number, plotCode: string): TelemetryRule => ({
      id: `rule-${metric}-${plotCode || "global"}-${level}`, metric, plotCode, direction: "below", threshold, level, message: level, enabled: true, updatedAt: now,
    });
    try {
      await rules.save(make("INFO", 40, plot));
      await rules.save(make("WARNING", 30, plot));
      await rules.save(make("CRITICAL", 20, plot));
      // 同键再写为更新而非新增
      await rules.save(make("WARNING", 28, plot));
      const tiers = await rules.findEnabled(metric, plot);
      expect(tiers).toHaveLength(3);
      expect(tiers.find((rule) => rule.level === "WARNING")?.threshold).toBe(28);

      // 全局兜底：未配置地块取全局规则
      await rules.save(make("WARNING", 30, ""));
      const fallback = await rules.findEnabled(metric, "P-UNCONFIGURED");
      expect(fallback).toHaveLength(1);
      expect(fallback[0]?.plotCode).toBe("");

      // 地块专属优先：已配置地块只返回专属三级
      const priority = await rules.findEnabled(metric, plot);
      expect(priority).toHaveLength(3);
      expect(priority.every((rule) => rule.plotCode === plot)).toBe(true);

      // 按级删除只移除该级
      expect(await rules.remove(metric, plot, "CRITICAL")).toBe(true);
      expect(await rules.findEnabled(metric, plot)).toHaveLength(2);
    } finally {
      await rules.remove(metric, plot);
      await rules.remove(metric, "");
      await client.$disconnect();
    }
  });
});