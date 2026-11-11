import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import { SqlPestEventRepository } from "../src/pest.repository.js";

const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlPestEventRepository（真实库）", () => {
  it("治理状态落库、统计聚合与逐日趋势", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const pests = new SqlPestEventRepository(client);
    const plot = `P-PEST-${Date.now()}`;
    const now = new Date().toISOString();
    const ids: string[] = [];
    try {
      const a = await pests.create(undefined, { plotCode: plot, deviceId: "c1", pestType: "稻飞虱", level: 3, confidence: 0.9, detectedAt: now });
      const b = await pests.create(undefined, { plotCode: plot, deviceId: "c2", pestType: "蚜虫", level: 1, confidence: 0.6, detectedAt: now });
      ids.push(a.id, b.id);

      const stats = await pests.stats({ plotCode: plot });
      expect(stats).toMatchObject({ total: 2, pending: 2 });
      expect(stats.byType).toHaveLength(2);
      expect(stats.byLevel.find((row) => row.level === 3)?.count).toBe(1);

      // 治理为已派单：状态、药剂方案与植保任务 id 落库，handled 置真
      const governed = await pests.govern(a.id, { status: "dispatched", pesticide: "吡虫啉", dosage: "10g/亩", governedBy: "张三", taskId: "task-x" });
      expect(governed).toMatchObject({ governanceStatus: "dispatched", pesticide: "吡虫啉", handled: true, taskId: "task-x" });
      expect(governed?.governedAt).toBeTruthy();
      // 再次读取确认持久化
      const reread = await pests.find(a.id);
      expect(reread).toMatchObject({ governanceStatus: "dispatched", pesticide: "吡虫啉", taskId: "task-x" });

      const afterGovern = await pests.stats({ plotCode: plot });
      expect(afterGovern).toMatchObject({ total: 2, pending: 1 });

      const trend = await pests.trend({ plotCode: plot, days: 7 });
      expect(trend).toHaveLength(7);
      expect(trend.reduce((sum, point) => sum + point.count, 0)).toBe(2);

      // 未知记录治理返回 null
      expect(await pests.govern("no-such-id", { status: "planned" })).toBeNull();
    } finally {
      for (const id of ids) await client.$executeRawUnsafe(`DELETE FROM telemetry_pest_events WHERE id = $1`, id);
      await client.$disconnect();
    }
  });
});