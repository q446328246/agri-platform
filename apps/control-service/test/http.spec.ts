import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createControlHttpServer } from "../src/http.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe("control HTTP API", () => {
  it("健康检查和查询接口返回统一响应", async () => {
    const base = await start(createControlHttpServer());
    const health = await fetch(`${base}/health`);
    const result = await health.json() as { code: string; data: { service: string } };
    expect(health.status).toBe(200);
    expect(result).toMatchObject({ code: "OK", data: { service: "control" } });

    const commands = await fetch(`${base}/api/v1/control/commands`);
    expect(commands.status).toBe(200);
    expect((await commands.json() as { data: { total: number } }).data.total).toBe(0);
  });

  it("没有身份或二次确认时拒绝控制指令，确认后进入队列", async () => {
    const base = await start(createControlHttpServer());
    const payload = JSON.stringify({ deviceId: "device-soil-003", type: "IRRIGATION", parameters: { duration: 5 } });
    const rejected = await fetch(`${base}/api/v1/control/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    expect(rejected.status).toBe(409);

    const accepted = await fetch(`${base}/api/v1/control/commands`, { method: "POST", headers: { "content-type": "application/json", "x-user-id": "user-admin", "x-confirm-action": "CONFIRM" }, body: payload });
    const result = await accepted.json() as { data: { operatorId: string; status: string; type: string } };
    expect(accepted.status).toBe(202);
    expect(result.data).toMatchObject({ operatorId: "user-admin", status: "QUEUED", type: "IRRIGATION" });
  });
});
