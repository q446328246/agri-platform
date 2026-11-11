import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import { SqlAiEventRepository } from "../src/ai-event.repository.js";
import { SqlPtzRepository } from "../src/ptz.repository.js";

/**
 * 真实库冒烟：DB_URL 存在时执行，覆盖迁移 018 的识别事件与云台指令表结构、
 * 转发状态更新、重试计数与补投清单。
 */
const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlAiEventRepository + SqlPtzRepository（真实库）", () => {
  it("识别事件落库、筛选、转发状态与补投清单", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const events = new SqlAiEventRepository(client);
    const ptz = new SqlPtzRepository(client);
    const tenantId = "tenant-smoke-video";
    const suffix = Date.now();
    const eventId = `ai-smoke-${suffix}`;
    const cappedId = `ai-smoke-capped-${suffix}`;
    const commandId = `ptz-smoke-${suffix}`;
    const detectedAt = "2026-11-10T02:00:00.000Z";
    const receivedAt = "2026-11-10T02:00:01.000Z";
    try {
      const created = await events.create({
        id: eventId, tenantId, cameraId: "camera-001", plotCode: "P-SMOKE", pestType: "稻飞虱",
        level: 2, confidence: 0.9, imageFileId: "file-smoke", detectedAt, receivedAt,
        forwarded: false, forwardStatus: 0, forwardMessage: "", retryCount: 0,
      });
      expect(created.id).toBe(eventId);
      expect(created.confidence).toBe(0.9);
      expect(created.imageFileId).toBe("file-smoke");
      expect(created.detectedAt).toBe(detectedAt);
      expect(created.receivedAt).toBe(receivedAt);

      const byPlot = await events.page(tenantId, { page: 1, size: 10, plotCode: "P-SMOKE" });
      expect(byPlot.items.map((event) => event.id)).toContain(eventId);
      expect((await events.page(tenantId, { page: 1, size: 10, forwarded: false })).items.map((event) => event.id)).toContain(eventId);
      expect((await events.page(tenantId, { page: 1, size: 10, forwarded: true })).items.map((event) => event.id)).not.toContain(eventId);
      expect(await events.find("tenant-smoke-other", eventId)).toBeNull();

      const failed = await events.markFailed(tenantId, eventId, 0, "遥测服务不可达");
      expect(failed?.retryCount).toBe(1);
      expect(failed?.lastError).toBe("遥测服务不可达");
      expect(failed?.forwarded).toBe(false);
      expect((await events.listRetryable(100, 5)).map((event) => event.id)).toContain(eventId);

      await events.create({
        id: cappedId, tenantId, cameraId: "camera-001", plotCode: "P-SMOKE", pestType: "螟虫",
        level: 1, confidence: 0.8, detectedAt, receivedAt: "2026-11-10T01:00:00.000Z",
        forwarded: false, forwardStatus: 0, forwardMessage: "", retryCount: 5,
      });
      expect((await events.listRetryable(100, 5)).map((event) => event.id)).not.toContain(cappedId);

      const forwardedAt = "2026-11-10T04:00:00.000Z";
      const forwarded = await events.markForwarded(tenantId, eventId, forwardedAt, 201, "已生成虫情告警");
      expect(forwarded?.forwarded).toBe(true);
      expect(forwarded?.forwardStatus).toBe(201);
      expect(forwarded?.forwardedAt).toBe(forwardedAt);
      expect(forwarded?.lastError).toBeUndefined();
      expect((await events.listRetryable(100, 5)).map((event) => event.id)).not.toContain(eventId);
      expect(await events.markForwarded("tenant-smoke-other", eventId, forwardedAt, 201, "")).toBeNull();

      const command = await ptz.create({
        id: commandId, tenantId, cameraId: "camera-001", action: "LEFT", speed: 5,
        status: "QUEUED", message: "", createdAt: receivedAt,
      });
      expect(command.speed).toBe(5);
      expect(command.status).toBe("QUEUED");
      expect(command.createdAt).toBe(receivedAt);
      const history = await ptz.page(tenantId, { page: 1, size: 10, cameraId: "camera-001" });
      expect(history.items.map((item) => item.id)).toContain(commandId);
      expect(await ptz.find("tenant-smoke-other", commandId)).toBeNull();

      const deliveredAt = "2026-11-10T02:00:05.000Z";
      const sent = await ptz.settle(tenantId, commandId, "SENT", "摄像机网关已接收（200）", deliveredAt);
      expect(sent?.status).toBe("SENT");
      expect(sent?.deliveredAt).toBe(deliveredAt);
      const requeued = await ptz.settle(tenantId, commandId, "QUEUED", "通道未配置");
      expect(requeued?.status).toBe("QUEUED");
      expect(requeued?.deliveredAt).toBeUndefined();
      expect(await ptz.settle("tenant-smoke-other", commandId, "SENT", "")).toBeNull();
    } finally {
      await client.$queryRawUnsafe("DELETE FROM video_ai_events WHERE tenant_id = $1", tenantId);
      await client.$queryRawUnsafe("DELETE FROM video_ptz_commands WHERE tenant_id = $1", tenantId);
      await client.$disconnect();
    }
  });
});