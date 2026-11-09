import { describe, expect, it, afterEach } from "vitest";
import type { Server } from "node:http";

import { createOperationHttpServer } from "../src/http.js";

const servers: Server[] = [];

async function start(): Promise<string> {
  const server = createOperationHttpServer();
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

    const setStatus = (status: string) => fetch(`${base}/api/v1/farm-tasks/${task.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const detail = async () => (await (await fetch(`${base}/api/v1/farm-tasks/${task.id}`)).json()).data;

    await setStatus("RUNNING");
    const running = await detail();
    expect(typeof running.startedAt).toBe("string");
    expect(running.completedAt).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await setStatus("RUNNING");
    expect((await detail()).startedAt).toBe(running.startedAt);

    await setStatus("COMPLETED");
    const completed = await detail();
    expect(completed.status).toBe("COMPLETED");
    expect(completed.startedAt).toBe(running.startedAt);
    expect(typeof completed.completedAt).toBe("string");
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
