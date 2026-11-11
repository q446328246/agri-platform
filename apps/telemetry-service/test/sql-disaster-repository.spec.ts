import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import { SqlDisasterRepository } from "../src/disaster.repository.js";

const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlDisasterRepository（真实库）", () => {
  it("灾情落库、JSONB 影像引用往返与状态推进持久化", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const disasters = new SqlDisasterRepository(client);
    const plot = `P-DISASTER-${Date.now()}`;
    const ids: string[] = [];
    try {
      const drought = await disasters.create(undefined, {
        disasterType: "drought", plotCode: plot, affectedAreaMu: 12.34, severity: 3,
        occurredAt: "2026-08-01T02:00:00.000Z", suggestion: "应急灌溉", reportedBy: "甲", imageFileIds: ["f1", "f2"],
      });
      const hail = await disasters.create(undefined, { disasterType: "hail", plotCode: plot, affectedAreaMu: 5, severity: 4, occurredAt: "2026-08-03T02:00:00.000Z" });
      ids.push(drought.id, hail.id);

      // JSONB 影像引用回读
      const reread = await disasters.find(drought.id);
      expect(reread).toMatchObject({ status: "REPORTED", affectedAreaMu: 12.34 });
      expect(reread?.imageFileIds).toEqual(["f1", "f2"]);
      expect(reread?.handledAt).toBeUndefined();

      // 统计聚合：面积保留两位，按灾种/分级分组
      const stats = await disasters.stats({ plotCode: plot });
      expect(stats).toMatchObject({ total: 2, open: 2 });
      expect(Number(stats.affectedAreaMu.toFixed(2))).toBe(17.34);
      expect(stats.byType.find((row) => row.disasterType === "drought")).toMatchObject({ count: 1, affectedAreaMu: 12.34 });
      expect(stats.bySeverity.map((row) => row.severity)).toEqual([3, 4]);

      // 状态推进落库，处置时点写入
      const assessed = await disasters.supplement(drought.id, { status: "ASSESSED", lossAssessment: "减产一成", handledBy: "乙" });
      expect(assessed).toMatchObject({ status: "ASSESSED", lossAssessment: "减产一成", handledBy: "乙", suggestion: "应急灌溉" });
      expect(assessed?.handledAt).toBeTruthy();
      expect((await disasters.find(drought.id))?.status).toBe("ASSESSED");

      // 回退被拒绝
      expect(await disasters.supplement(drought.id, { status: "REPORTED" })).toBeNull();
      // 未知记录
      expect(await disasters.supplement("no-such-id", { status: "ASSESSED" })).toBeNull();

      // 归档后不再计入 open
      await disasters.supplement(drought.id, { status: "ARCHIVED" });
      expect(await disasters.stats({ plotCode: plot })).toMatchObject({ total: 2, open: 1 });
    } finally {
      for (const id of ids) await client.$executeRawUnsafe(`DELETE FROM telemetry_disasters WHERE id = $1`, id);
      await client.$disconnect();
    }
  });
});
