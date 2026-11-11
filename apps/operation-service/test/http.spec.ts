import { describe, expect, it, afterEach } from "vitest";
import type { Server } from "node:http";

import { createOperationHttpServer } from "../src/http.js";
import { InMemoryTaskRepository } from "../src/task.repository.js";
import type { Task, TaskRepository } from "../src/task.repository.js";

const servers: Server[] = [];

async function start(tasks?: TaskRepository): Promise<string> {
  const server = createOperationHttpServer(tasks ? { tasks } : {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("operation HTTP", () => {
  it("创建任务、筛选并流转状态", async () => {
    const base = await start();
    const created = await fetch(`${base}/api/v1/farm-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "达州示范田灌溉", plotCode: "P-001", type: "IRRIGATION" }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()).data;

    const filtered = await fetch(`${base}/api/v1/farm-tasks?page=1&size=10&keyword=示范田&status=PENDING`);
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).data.items).toHaveLength(1);

    const updated = await fetch(`${base}/api/v1/farm-tasks/${task.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "RUNNING" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.status).toBe("RUNNING");
  });

  it("按 id 取任务详情，不存在的任务返回 404", async () => {
    const base = await start();
    const created = await fetch(`${base}/api/v1/farm-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "详情校验任务", plotCode: "P-DETAIL", type: "WEEDING" }),
    });
    const task = (await created.json()).data;

    const detail = await fetch(`${base}/api/v1/farm-tasks/${task.id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data).toMatchObject({ id: task.id, name: "详情校验任务", plotCode: "P-DETAIL", status: "PENDING" });

    const missing = await fetch(`${base}/api/v1/farm-tasks/task-not-exist`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).message).toContain("任务不存在");
  });

  it("状态流转补记开始与完成作业时间，重复置同一状态不会改写首次时刻", async () => {
    const base = await start();
    const created = await fetch(`${base}/api/v1/farm-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "作业窗口校验任务", plotCode: "P-WINDOW", type: "IRRIGATION" }),
    });
    const task = (await created.json()).data;
    expect(task.startedAt).toBeUndefined();
    expect(task.completedAt).toBeUndefined();

    const setStatus = (status: string, extra: Record<string, unknown> = {}) => fetch(`${base}/api/v1/farm-tasks/${task.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, ...extra }),
    });
    const detail = async () => (await (await fetch(`${base}/api/v1/farm-tasks/${task.id}`)).json()).data;

    await setStatus("RUNNING");
    const running = await detail();
    expect(typeof running.startedAt).toBe("string");
    expect(running.completedAt).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await setStatus("RUNNING");
    expect((await detail()).startedAt).toBe(running.startedAt);

    await setStatus("COMPLETED", { version: running.version, result: { outcome: "success", finishedAreaMu: 12.5, notes: "按计划完成" } });
    const completed = await detail();
    expect(completed.status).toBe("COMPLETED");
    expect(completed.startedAt).toBe(running.startedAt);
    expect(typeof completed.completedAt).toBe("string");
    expect(completed.result).toEqual({ outcome: "success", finishedAreaMu: 12.5, notes: "按计划完成" });
  });

  it("演示任务的历史时间自洽，进行中只有开始时间、已取消不编造作业时间", async () => {
    const base = await start();
    const running = (await (await fetch(`${base}/api/v1/farm-tasks/task-demo-001`)).json()).data;
    expect(running.status).toBe("RUNNING");
    expect(typeof running.startedAt).toBe("string");
    expect(running.completedAt).toBeUndefined();

    const completed = (await (await fetch(`${base}/api/v1/farm-tasks/task-demo-006`)).json()).data;
    expect(new Date(completed.startedAt).getTime()).toBeLessThan(new Date(completed.completedAt).getTime());

    const cancelled = (await (await fetch(`${base}/api/v1/farm-tasks/task-demo-008`)).json()).data;
    expect(cancelled.startedAt).toBeUndefined();
    expect(cancelled.completedAt).toBeUndefined();
  });
});

const JSON_HEADERS = { "content-type": "application/json" };
const RESULT = { outcome: "success", finishedAreaMu: 12.5, notes: "按计划完成" };

async function createTask(base: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Task> {
  const response = await fetch(`${base}/api/v1/farm-tasks`, {
    method: "POST", headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ name: "达州示范田灌溉", plotCode: "P-001", type: "IRRIGATION", ...body }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).data;
}

function setStatus(base: string, id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/farm-tasks/${id}/status`, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
}

describe("任务生命周期约束", () => {
  it("待执行不能直接完成，终态不能再迁移", async () => {
    const base = await start();
    const task = await createTask(base);
    expect((await setStatus(base, task.id, { status: "COMPLETED", result: RESULT })).status).toBe(409);

    await setStatus(base, task.id, { status: "RUNNING" });
    await setStatus(base, task.id, { status: "COMPLETED", result: RESULT });
    const finished = (await (await fetch(`${base}/api/v1/farm-tasks/${task.id}`)).json()).data;
    expect(finished.status).toBe("COMPLETED");
    expect((await setStatus(base, task.id, { status: "RUNNING" })).status).toBe(409);
    expect((await setStatus(base, task.id, { status: "CANCELLED" })).status).toBe(409);

    const another = await createTask(base, { name: "取消后锁定", plotCode: "P-002" });
    await setStatus(base, another.id, { status: "CANCELLED" });
    expect((await setStatus(base, another.id, { status: "RUNNING" })).status).toBe(409);
  });

  it("取消任务记录 cancelledAt，不编造作业时间", async () => {
    const base = await start();
    const task = await createTask(base);
    const cancelled = await setStatus(base, task.id, { status: "CANCELLED", version: task.version });
    expect(cancelled.status).toBe(200);
    const data = (await cancelled.json()).data;
    expect(typeof data.cancelledAt).toBe("string");
    expect(data.startedAt).toBeUndefined();
    expect(data.completedAt).toBeUndefined();
  });

  it("完成必须带合法作业结果，缺失或非法一律 400 且不落状态", async () => {
    const base = await start();
    const task = await createTask(base);
    await setStatus(base, task.id, { status: "RUNNING" });
    expect((await setStatus(base, task.id, { status: "COMPLETED" })).status).toBe(400);
    expect((await setStatus(base, task.id, { status: "COMPLETED", result: { outcome: "ok", finishedAreaMu: 1 } })).status).toBe(400);
    expect((await setStatus(base, task.id, { status: "COMPLETED", result: { outcome: "success", finishedAreaMu: -1 } })).status).toBe(400);
    expect((await setStatus(base, task.id, { status: "COMPLETED", result: { outcome: "success", finishedAreaMu: "十二亩" } })).status).toBe(400);
    const detail = (await (await fetch(`${base}/api/v1/farm-tasks/${task.id}`)).json()).data;
    expect(detail.status).toBe("RUNNING");
    expect(detail.result).toBeUndefined();
  });

  it("过期 version 提交被拒绝，刷新后可重试", async () => {
    const base = await start();
    const task = await createTask(base);
    await setStatus(base, task.id, { status: "RUNNING", version: task.version });
    const stale = await setStatus(base, task.id, { status: "CANCELLED", version: task.version });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("OPS-409-001");
    const current = (await (await fetch(`${base}/api/v1/farm-tasks/${task.id}`)).json()).data;
    expect((await setStatus(base, task.id, { status: "CANCELLED", version: current.version })).status).toBe(200);
  });
});

describe("任务创建与查询校验", () => {
  it("计划窗口与负责人真实落库，结束早于开始拒绝", async () => {
    const base = await start();
    const task = await createTask(base, {
      scheduledAt: "2026-11-10T08:00:00+08:00", scheduledEndAt: "2026-11-10T12:00:00+08:00", assigneeName: "王农机",
    });
    expect(task).toMatchObject({ assigneeName: "王农机", scheduledAt: "2026-11-10T00:00:00.000Z", scheduledEndAt: "2026-11-10T04:00:00.000Z" });
    const invalid = await fetch(`${base}/api/v1/farm-tasks`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ name: "倒挂窗口", plotCode: "P-001", scheduledAt: "2026-11-10T12:00:00Z", scheduledEndAt: "2026-11-10T08:00:00Z" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("必填缺失、非法枚举与非法分页返回 400", async () => {
    const base = await start();
    const missing = await fetch(`${base}/api/v1/farm-tasks`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: "无地块" }) });
    expect(missing.status).toBe(400);
    expect((await fetch(`${base}/api/v1/farm-tasks?status=UNKNOWN`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/farm-tasks?type=UNKNOWN`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/farm-tasks?page=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/farm-tasks?size=201`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/farm-tasks?from=2026-11-10&to=2026-11-09`)).status).toBe(400);
  });

  it("纯日期截止日含当天全部任务，IN_PROGRESS 别名命中 RUNNING", async () => {
    const base = await start();
    await createTask(base, { name: "当天任务", scheduledAt: "2026-11-10T23:30:00Z" });
    const hit = await fetch(`${base}/api/v1/farm-tasks?from=2026-11-10&to=2026-11-10&keyword=当天任务`);
    expect((await hit.json()).data.total).toBe(1);
    const running = await fetch(`${base}/api/v1/farm-tasks?status=IN_PROGRESS`);
    const items = (await running.json()).data.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((task: Task) => task.status === "RUNNING")).toBe(true);
  });
});

describe("任务租户隔离与持久化", () => {
  it("跨租户列表为空、详情与状态操作 404", async () => {
    const base = await start();
    const task = await createTask(base, {}, { "x-tenant-id": "tenant-a" });
    const other = { "x-tenant-id": "tenant-b" };
    const listed = await (await fetch(`${base}/api/v1/farm-tasks`, { headers: other })).json();
    expect(listed.data.total).toBe(0);
    expect((await fetch(`${base}/api/v1/farm-tasks/${task.id}`, { headers: other })).status).toBe(404);
    expect((await setStatus(base, task.id, { status: "RUNNING" }, other)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/farm-tasks/${task.id}`, { headers: { "x-tenant-id": "tenant-a" } })).status).toBe(200);
  });

  it("共享仓储的新实例保留任务与完成事件（重启不丢）", async () => {
    const repository = new InMemoryTaskRepository();
    const first = await start(repository);
    const task = await createTask(first, { type: "FERTILIZATION" }, { "x-tenant-id": "tenant-a" });
    await setStatus(first, task.id, { status: "RUNNING" }, { "x-tenant-id": "tenant-a" });
    const completed = await setStatus(first, task.id, { status: "COMPLETED", result: RESULT }, { "x-tenant-id": "tenant-a" });
    expect(completed.status).toBe(200);

    const second = await start(repository);
    const detail = await (await fetch(`${second}/api/v1/farm-tasks/${task.id}`, { headers: { "x-tenant-id": "tenant-a" } })).json();
    expect(detail.data).toMatchObject({ status: "COMPLETED", result: RESULT });
    expect(repository.completedEvents).toHaveLength(1);
    expect(repository.completedEvents[0]).toMatchObject({
      tenantId: "tenant-a",
      payload: { taskId: task.id, parcelId: "P-001", taskType: "fertilization", result: "success", finishedAreaMu: 12.5 },
    });
  });

  it("导航方案按租户隔离", async () => {
    const base = await start();
    const planBody = { start: { lng: 107.4, lat: 30.9 }, stops: [{ code: "A", lng: 107.41, lat: 30.91 }, { code: "B", lng: 107.42, lat: 30.92 }] };
    const planned = await fetch(`${base}/api/v1/operations/path-plan`, { method: "POST", headers: { ...JSON_HEADERS, "x-tenant-id": "tenant-a" }, body: JSON.stringify(planBody) });
    expect(planned.status).toBe(200);
    const own = await (await fetch(`${base}/api/v1/operations/path-plans`, { headers: { "x-tenant-id": "tenant-a" } })).json();
    expect(own.data).toHaveLength(1);
    const other = await (await fetch(`${base}/api/v1/operations/path-plans`, { headers: { "x-tenant-id": "tenant-b" } })).json();
    expect(other.data).toHaveLength(0);
  });
});
