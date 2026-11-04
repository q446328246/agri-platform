import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createFileHttpServer, InMemoryObjectStorage } from "../src/http.js";

const servers: Server[] = [];
async function start(server: Server): Promise<string> { servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未分配端口"); return `http://127.0.0.1:${address.port}`; }
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); });

describe("file HTTP API", () => {
  it("写入文件内容、读取内容并在删除时清理对象", async () => {
    const storage = new InMemoryObjectStorage();
    const base = await start(createFileHttpServer(storage));
    const upload = await fetch(`${base}/api/v1/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "sample.txt", contentType: "text/plain", contentBase64: Buffer.from("达州农场").toString("base64") }) });
    const file = (await upload.json() as { data: { id: string; size: number } }).data;
    expect(upload.status).toBe(201);
    expect(file.size).toBe(Buffer.byteLength("达州农场"));
    const content = await fetch(`${base}/api/v1/files/${file.id}/content`);
    expect(await content.text()).toBe("达州农场");
    const deleted = await fetch(`${base}/api/v1/files/${file.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${base}/api/v1/files/${file.id}/content`)).status).toBe(404);
  });
});
