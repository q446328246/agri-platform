import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";
import { EventTopic } from "@agri/contracts";

import { SqlTaskRepository } from "../src/task.repository.js";
import { SqlOperationOutbox } from "../src/outbox.repository.js";

/**
 * 真实库冒烟：DB_URL 存在时执行，覆盖迁移 016 的表结构、状态机约束、
 * 完成事件与状态更新的单语句原子写入，以及本地消息表的发布标记。
 */
const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlTaskRepository + SqlOperationOutbox（真实库）", () => {
  it("创建、筛选、租户隔离、状态流转与完成事件原子入队", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlTaskRepository(client);
    const outbox = new SqlOperationOutbox(client);
    const tenantId = "tenant-smoke-ops";
    const suffix = Date.now();
    const taskId = `task-smoke-${suffix}`;
    const cancelId = `task-smoke-cancel-${suffix}`;
    const now = Date.now();
    const scheduledAt = new Date(now - 3_600_000).toISOString();
    const scheduledEndAt = new Date(now + 3_600_000).toISOString();
    const createdAt = new Date(now).toISOString();
    const startedAt = new Date(now + 1_000).toISOString();
    const completedAt = new Date(now + 2_000).toISOString();
    const cancelledAt = new Date(now + 3_000).toISOString();
    const result = { outcome: "success" as const, finishedAreaMu: 12.5, notes: "冒烟完成" };
    try {
      const created = await repository.create({
        id: taskId, tenantId, plotCode: "P-SMOKE", type: "FERTILIZATION", name: "SQL冒烟施肥任务",
        status: "PENDING", scheduledAt, scheduledEndAt, assigneeName: "冒烟员", createdAt, version: 1,
      });
      expect(created.status).toBe("PENDING");
      expect(created.version).toBe(1);
      expect(created.scheduledAt).toBe(scheduledAt);
      expect(created.scheduledEndAt).toBe(scheduledEndAt);

      const byKeyword = await repository.page(tenantId, { page: 1, size: 10, keyword: "sql冒烟施肥" });
      expect(byKeyword.items.map((task) => task.id)).toContain(taskId);
      const byFilter = await repository.page(tenantId, { page: 1, size: 10, status: "PENDING", type: "FERTILIZATION", plotCode: "P-SMOKE" });
      expect(byFilter.items.map((task) => task.id)).toContain(taskId);
      const inWindow = await repository.page(tenantId, { page: 1, size: 10, plotCode: "P-SMOKE", from: new Date(now - 7_200_000).toISOString(), to: new Date(now + 7_200_000).toISOString() });
      expect(inWindow.items.map((task) => task.id)).toContain(taskId);
      const outWindow = await repository.page(tenantId, { page: 1, size: 10, plotCode: "P-SMOKE", from: new Date(now + 7_200_000).toISOString() });
      expect(outWindow.items.map((task) => task.id)).not.toContain(taskId);

      expect(await repository.find("tenant-smoke-other", taskId)).toBeNull();
      expect((await repository.find(tenantId, taskId))?.assigneeName).toBe("冒烟员");

      const running = await repository.transition(created, "RUNNING", startedAt, "smoke-trace");
      expect(running?.status).toBe("RUNNING");
      expect(running?.startedAt).toBe(startedAt);
      expect(running?.version).toBe(2);
      const runningOutbox = await client.$queryRawUnsafe<Array<{ total: string }>>("SELECT count(*) AS total FROM operation_outbox WHERE task_id = $1", taskId);
      expect(Number(runningOutbox[0]?.total)).toBe(0);

      const completed = await repository.transition(running!, "COMPLETED", completedAt, "smoke-trace", result);
      expect(completed?.status).toBe("COMPLETED");
      expect(completed?.startedAt).toBe(startedAt);
      expect(completed?.completedAt).toBe(completedAt);
      expect(completed?.result).toEqual(result);
      expect(completed?.version).toBe(3);

      const queued = await client.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM operation_outbox WHERE task_id = $1", taskId);
      expect(queued).toHaveLength(1);
      const pending = await outbox.listPending(200);
      const record = pending.find((item) => item.id === queued[0]?.id);
      expect(record?.topic).toBe(EventTopic.OperationTaskCompleted);
      expect(record?.tenantId).toBe(tenantId);
      expect(record?.traceId).toBe("smoke-trace");
      expect(record?.producer).toBe("operation");
      expect(record?.payload).toMatchObject({ taskId, parcelId: "P-SMOKE", taskType: "fertilization", result: "success", finishedAreaMu: 12.5, finishedAt: completedAt });

      await outbox.markFailed(record!.id, "冒烟投递失败");
      const retried = (await outbox.listPending(200)).find((item) => item.id === record!.id);
      expect(retried?.retryCount).toBe(1);
      expect(retried?.lastError).toBe("冒烟投递失败");
      await outbox.markPublished(record!.id);
      expect((await outbox.listPending(200)).some((item) => item.id === record!.id)).toBe(false);

      // 过期 version 与终态回退都不得改写数据
      expect(await repository.transition(running!, "COMPLETED", completedAt, "smoke-trace", result)).toBeNull();
      expect(await repository.transition(completed!, "RUNNING", startedAt, "smoke-trace")).toBeNull();
      expect((await repository.find(tenantId, taskId))?.version).toBe(3);

      // 缺 result 不允许完成；取消分支记录取消时间且不产生事件
      const cancelTask = await repository.create({
        id: cancelId, tenantId, plotCode: "P-SMOKE", type: "WEEDING", name: "SQL冒烟取消任务",
        status: "PENDING", createdAt, version: 1,
      });
      const cancelRunning = await repository.transition(cancelTask, "RUNNING", startedAt, "smoke-trace");
      expect(await repository.transition(cancelRunning!, "COMPLETED", completedAt, "smoke-trace")).toBeNull();
      const cancelled = await repository.transition(cancelRunning!, "CANCELLED", cancelledAt, "smoke-trace");
      expect(cancelled?.status).toBe("CANCELLED");
      expect(cancelled?.cancelledAt).toBe(cancelledAt);
      const cancelOutbox = await client.$queryRawUnsafe<Array<{ total: string }>>("SELECT count(*) AS total FROM operation_outbox WHERE task_id = $1", cancelId);
      expect(Number(cancelOutbox[0]?.total)).toBe(0);

      await expect(outbox.enqueue()).rejects.toThrow("原子");
    } finally {
      for (const id of [taskId, cancelId]) {
        await client.$executeRawUnsafe("DELETE FROM operation_outbox WHERE task_id = $1", id);
        await client.$executeRawUnsafe("DELETE FROM operation_tasks WHERE id = $1", id);
      }
      await client.$disconnect();
    }
  });
});