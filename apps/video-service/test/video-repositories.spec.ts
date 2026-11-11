import { describe, expect, it } from "vitest";

import { InMemoryAiEventRepository, toDetection } from "../src/ai-event.repository.js";
import type { AiEventRecord } from "../src/ai-event.repository.js";
import { InMemoryPtzRepository } from "../src/ptz.repository.js";
import { AiForwardRelay } from "../src/ai-relay.js";

function aiEvent(overrides: Partial<AiEventRecord> = {}): AiEventRecord {
  return {
    id: "ai-1", tenantId: "tenant-demo", cameraId: "camera-001", plotCode: "P-001",
    pestType: "稻飞虱", level: 2, confidence: 0.9,
    detectedAt: "2026-11-10T02:00:00.000Z", receivedAt: "2026-11-10T02:00:01.000Z",
    forwarded: false, forwardStatus: 0, forwardMessage: "", retryCount: 0,
    ...overrides,
  };
}

describe("InMemoryAiEventRepository", () => {
  it("创建、分页筛选与租户隔离", async () => {
    const repo = new InMemoryAiEventRepository();
    await repo.create(aiEvent({ id: "ai-a", receivedAt: "2026-11-10T02:00:01.000Z" }));
    await repo.create(aiEvent({ id: "ai-b", plotCode: "P-002", receivedAt: "2026-11-10T03:00:01.000Z", forwarded: true, forwardStatus: 201, forwardedAt: "2026-11-10T03:00:02.000Z" }));
    await repo.create(aiEvent({ id: "ai-other", tenantId: "tenant-other" }));

    const all = await repo.page("tenant-demo", { page: 1, size: 10 });
    expect(all.total).toBe(2);
    expect(all.items.map((event) => event.id)).toEqual(["ai-b", "ai-a"]);
    expect((await repo.page("tenant-demo", { page: 1, size: 10, plotCode: "P-002" })).items.map((event) => event.id)).toEqual(["ai-b"]);
    expect((await repo.page("tenant-demo", { page: 1, size: 10, forwarded: false })).items.map((event) => event.id)).toEqual(["ai-a"]);
    expect((await repo.page("tenant-demo", { page: 2, size: 1 })).items).toHaveLength(1);
    expect(await repo.find("tenant-other", "ai-a")).toBeNull();
    expect((await repo.find("tenant-demo", "ai-a"))?.pestType).toBe("稻飞虱");
  });

  it("转发成功清除错误并记录时间，失败累计重试计数", async () => {
    const repo = new InMemoryAiEventRepository();
    await repo.create(aiEvent());
    const failed = await repo.markFailed("tenant-demo", "ai-1", 0, "遥测服务不可达");
    expect(failed?.retryCount).toBe(1);
    expect(failed?.lastError).toBe("遥测服务不可达");
    expect(failed?.forwarded).toBe(false);
    const failedAgain = await repo.markFailed("tenant-demo", "ai-1", 503, "遥测服务返回 503");
    expect(failedAgain?.retryCount).toBe(2);
    const forwarded = await repo.markForwarded("tenant-demo", "ai-1", "2026-11-10T04:00:00.000Z", 201, "已生成虫情告警");
    expect(forwarded?.forwarded).toBe(true);
    expect(forwarded?.forwardedAt).toBe("2026-11-10T04:00:00.000Z");
    expect(forwarded?.lastError).toBeUndefined();
    expect(await repo.markForwarded("tenant-other", "ai-1", "2026-11-10T04:00:00.000Z", 201, "")).toBeNull();
    expect(await repo.markFailed("tenant-other", "ai-1", 0, "")).toBeNull();
  });

  it("补投清单排除已转发与超限事件，按接收时间升序", async () => {
    const repo = new InMemoryAiEventRepository();
    await repo.create(aiEvent({ id: "ai-late", receivedAt: "2026-11-10T05:00:00.000Z" }));
    await repo.create(aiEvent({ id: "ai-early", receivedAt: "2026-11-10T01:00:00.000Z" }));
    await repo.create(aiEvent({ id: "ai-done", forwarded: true }));
    await repo.create(aiEvent({ id: "ai-capped", retryCount: 5 }));
    const retryable = await repo.listRetryable(10, 5);
    expect(retryable.map((event) => event.id)).toEqual(["ai-early", "ai-late"]);
    expect((await repo.listRetryable(1, 5)).map((event) => event.id)).toEqual(["ai-early"]);
  });

  it("toDetection 还原转发所需字段", () => {
    const detection = toDetection(aiEvent({ imageFileId: "file-1" }));
    expect(detection).toEqual({
      cameraId: "camera-001", plotCode: "P-001", pestType: "稻飞虱", level: 2, confidence: 0.9,
      detectedAt: "2026-11-10T02:00:00.000Z", imageFileId: "file-1",
    });
    expect(toDetection(aiEvent()).imageFileId).toBeUndefined();
  });
});

describe("InMemoryPtzRepository", () => {
  it("创建、按摄像头筛选与租户隔离", async () => {
    const repo = new InMemoryPtzRepository();
    const base = { tenantId: "tenant-demo", cameraId: "camera-001", action: "LEFT" as const, status: "QUEUED" as const, message: "", createdAt: "2026-11-10T02:00:00.000Z" };
    await repo.create({ ...base, id: "ptz-a", speed: 5 });
    await repo.create({ ...base, id: "ptz-b", cameraId: "camera-002", createdAt: "2026-11-10T03:00:00.000Z" });
    await repo.create({ ...base, id: "ptz-other", tenantId: "tenant-other" });
    const all = await repo.page("tenant-demo", { page: 1, size: 10 });
    expect(all.total).toBe(2);
    expect(all.items.map((command) => command.id)).toEqual(["ptz-b", "ptz-a"]);
    expect((await repo.page("tenant-demo", { page: 1, size: 10, cameraId: "camera-001" })).items.map((command) => command.id)).toEqual(["ptz-a"]);
    expect((await repo.find("tenant-demo", "ptz-a"))?.speed).toBe(5);
    expect(await repo.find("tenant-other", "ptz-a")).toBeNull();
  });

  it("settle 记录真实投递结果，回退 QUEUED 清除投递时间", async () => {
    const repo = new InMemoryPtzRepository();
    await repo.create({ id: "ptz-a", tenantId: "tenant-demo", cameraId: "camera-001", action: "UP", status: "QUEUED", message: "", createdAt: "2026-11-10T02:00:00.000Z" });
    const sent = await repo.settle("tenant-demo", "ptz-a", "SENT", "摄像机网关已接收（200）", "2026-11-10T02:00:05.000Z");
    expect(sent?.status).toBe("SENT");
    expect(sent?.deliveredAt).toBe("2026-11-10T02:00:05.000Z");
    const failed = await repo.settle("tenant-demo", "ptz-a", "FAILED", "摄像机网关返回 503");
    expect(failed?.status).toBe("FAILED");
    expect(failed?.deliveredAt).toBeDefined();
    const requeued = await repo.settle("tenant-demo", "ptz-a", "QUEUED", "通道未配置");
    expect(requeued?.status).toBe("QUEUED");
    expect(requeued?.deliveredAt).toBeUndefined();
    expect(await repo.settle("tenant-other", "ptz-a", "SENT", "")).toBeNull();
  });
});

describe("AiForwardRelay", () => {
  it("按接收顺序补投：失败计数、成功停投", async () => {
    const repo = new InMemoryAiEventRepository();
    await repo.create(aiEvent({ id: "ai-a", receivedAt: "2026-11-10T02:00:01.000Z" }));
    await repo.create(aiEvent({ id: "ai-b", receivedAt: "2026-11-10T02:00:02.000Z" }));
    let attempts = 0;
    const relay = new AiForwardRelay(repo, {
      baseUrl: "http://unused",
      forward: async () => {
        attempts += 1;
        return attempts === 1
          ? { forwarded: false, status: 0, message: "遥测服务不可达" }
          : { forwarded: true, status: 201, message: "已生成虫情告警" };
      },
    });
    expect(await relay.tick()).toBe(1);
    const a = await repo.find("tenant-demo", "ai-a");
    expect(a?.forwarded).toBe(false);
    expect(a?.retryCount).toBe(1);
    expect(a?.lastError).toBe("遥测服务不可达");
    expect((await repo.find("tenant-demo", "ai-b"))?.forwarded).toBe(true);
    expect(await relay.tick()).toBe(1);
    expect((await repo.find("tenant-demo", "ai-a"))?.forwarded).toBe(true);
    expect(await relay.tick()).toBe(0);
    expect(attempts).toBe(3);
  });

  it("超过自动重试上限后不再补投，人工重试不受限", async () => {
    const repo = new InMemoryAiEventRepository();
    await repo.create(aiEvent({ id: "ai-capped", retryCount: 5 }));
    const relay = new AiForwardRelay(repo, { baseUrl: "http://unused", maxRetries: 5, forward: async () => ({ forwarded: true, status: 201, message: "" }) });
    expect(await relay.tick()).toBe(0);
    const manual = await repo.markForwarded("tenant-demo", "ai-capped", "2026-11-10T06:00:00.000Z", 201, "人工补投成功");
    expect(manual?.forwarded).toBe(true);
  });
});