import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import { SqlGrowthStageRepository } from "../src/growth.repository.js";

const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlGrowthStageRepository（真实库）", () => {
  it("生育期档案幂等写入、按地块回看与删除", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const growth = new SqlGrowthStageRepository(client);
    const plot = `P-GROWTH-${Date.now()}`;
    let createdId = "";
    try {
      const created = await growth.save({
        plotCode: plot,
        stage: "tillering",
        plannedStartAt: "2026-06-09T16:00:00.000Z",
        plannedEndAt: "2026-06-24T16:00:00.000Z",
        note: "分蘖期计划",
      });
      createdId = created.id;
      expect(created.plannedStartAt).toBe("2026-06-09T16:00:00.000Z");
      expect(created.actualStartAt).toBeUndefined();

      // 同地块同生育期补登实际节点：更新而非新增，id 不变
      const updated = await growth.save({ plotCode: plot, stage: "tillering", actualStartAt: "2026-06-11T16:00:00.000Z", note: "实际晚 2 天" });
      expect(updated.id).toBe(createdId);
      expect(updated.actualStartAt).toBe("2026-06-11T16:00:00.000Z");
      // 未再传计划节点应被清空（幂等覆盖整条档案）
      expect(updated.plannedStartAt).toBeUndefined();

      const list = await growth.list(plot);
      expect(list).toHaveLength(1);
      expect(list[0]?.note).toBe("实际晚 2 天");
    } finally {
      if (createdId) await growth.remove(createdId);
      await client.$disconnect();
    }
  });
});