import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createGatewayHttpServer } from "../src/http.js";

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

describe("gateway HTTP API", () => {
  it("转发路径、请求体和关键身份请求头", async () => {
    const upstream = await start(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url, method: request.method, userId: request.headers["x-user-id"], body: Buffer.concat(chunks).toString("utf8") }));
    }));
    const gateway = await start(createGatewayHttpServer({ routes: [{ prefix: "/api/v1/test", target: upstream }] }));
    const response = await fetch(`${gateway}/api/v1/test/commands?x=1`, { method: "POST", headers: { "content-type": "application/json", "x-user-id": "user-admin", "x-confirm-action": "CONFIRM" }, body: JSON.stringify({ ok: true }) });
    const result = await response.json() as { path: string; method: string; userId: string; body: string };
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ path: "/api/v1/test/commands?x=1", method: "POST", userId: "user-admin", body: JSON.stringify({ ok: true }) });
  });

  it("最长前缀路由优先，避免具体路径被父路径吞掉", async () => {
    const parentUpstream = await start(createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ service: "parent" }));
    }));
    const childUpstream = await start(createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ service: "child" }));
    }));
    const gateway = await start(createGatewayHttpServer({
      routes: [
        { prefix: "/api/v1/test", target: parentUpstream },
        { prefix: "/api/v1/test/bounds", target: childUpstream },
      ],
    }));
    const parent = await (await fetch(`${gateway}/api/v1/test/list`)).json();
    const child = await (await fetch(`${gateway}/api/v1/test/bounds`)).json();
    expect(parent).toMatchObject({ service: "parent" });
    expect(child).toMatchObject({ service: "child" });
  });

  it("未知路径返回网关 404", async () => {
    const gateway = await start(createGatewayHttpServer({ routes: [] }));
    const response = await fetch(`${gateway}/api/v1/unknown`);
    expect(response.status).toBe(404);
    expect((await response.json() as { code: string }).code).toBe("GATEWAY-404");
  });
});
