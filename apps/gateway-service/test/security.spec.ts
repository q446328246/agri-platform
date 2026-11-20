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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

const SECURITY_HEADERS = ["x-content-type-options", "x-frame-options", "x-xss-protection", "referrer-policy"] as const;

describe("网关安全响应头与错误处理（F2）", () => {
  it("网关自身响应（健康检查与未匹配路由）附带安全响应头", async () => {
    const gateway = await start(createGatewayHttpServer({ routes: [{ prefix: "/api/v1/test", target: "http://127.0.0.1:1" }] }));

    const health = await fetch(`${gateway}/health`);
    expect(health.status).toBe(200);
    for (const name of SECURITY_HEADERS) expect(health.headers.get(name)).toBeTruthy();

    const notFound = await fetch(`${gateway}/api/v1/nowhere`);
    expect(notFound.status).toBe(404);
    for (const name of SECURITY_HEADERS) expect(notFound.headers.get(name)).toBeTruthy();
  });

  it("转发响应附带安全响应头，认证路径禁止缓存", async () => {
    const upstream = await start(createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=60" });
      response.end(JSON.stringify({ ok: true }));
    }));
    const gateway = await start(createGatewayHttpServer({
      routes: [
        { prefix: "/api/v1/test", target: upstream },
        { prefix: "/api/v1/auth", target: upstream },
      ],
    }));

    const forwarded = await fetch(`${gateway}/api/v1/test/data`);
    expect(forwarded.status).toBe(200);
    for (const name of SECURITY_HEADERS) expect(forwarded.headers.get(name)).toBeTruthy();

    const auth = await fetch(`${gateway}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(auth.status).toBe(200);
    // 上游给了 max-age，认证响应必须覆盖为 no-store
    expect(auth.headers.get("cache-control")).toBe("no-store");
  });

  it("下游不可用时返回通用文案，不泄露内部细节", async () => {
    const gateway = await start(createGatewayHttpServer({ routes: [{ prefix: "/api/v1/test", target: "http://127.0.0.1:1" }] }));

    const response = await fetch(`${gateway}/api/v1/test/data`);
    expect(response.status).toBe(502);
    const body = await response.json() as { message: string };
    expect(body.message).toBe("下游服务不可用");
    expect(body.message).not.toContain("ECONNREFUSED");
  });
});
