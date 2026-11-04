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
});
