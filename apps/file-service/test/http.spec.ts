import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createFileHttpServer, InMemoryObjectStorage, MAX_FILE_BYTES } from "../src/http.js";
import { InMemoryFileRepository } from "../src/file.repository.js";
import type { FileMeta, FileRepository } from "../src/file.repository.js";

const servers: Server[] = [];
async function start(server: Server): Promise<string> { servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务未分配端口"); return `http://127.0.0.1:${address.port}`; }
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); });

const TENANT = { "x-tenant-id": "tenant-a" };
const JSON_HEADERS = { "content-type": "application/json", ...TENANT };

function upload(base: string, body: Record<string, unknown>, headers: Record<string, string> = JSON_HEADERS) {
  return fetch(`${base}/api/v1/files`, { method: "POST", headers, body: JSON.stringify(body) });
}

function sampleBody(overrides: Record<string, unknown> = {}) {
  return { name: "sample.txt", contentType: "text/plain", contentBase64: Buffer.from("达州农场").toString("base64"), ...overrides };
}

describe("file HTTP API", () => {
  it("写入文件内容、读取内容并在删除时清理对象", async () => {
    const storage = new InMemoryObjectStorage();
    const base = await start(createFileHttpServer({ storage }));
    const response = await upload(base, sampleBody());
    const file = (await response.json() as { data: FileMeta }).data;
    expect(response.status).toBe(201);
    expect(file.size).toBe(Buffer.byteLength("达州农场"));
    expect(file.tenantId).toBe("tenant-a");
    const content = await fetch(`${base}/api/v1/files/${file.id}/content`, { headers: TENANT });
    expect(content.headers.get("content-disposition")).toContain("attachment");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await content.text()).toBe("达州农场");
    const deleted = await fetch(`${base}/api/v1/files/${file.id}`, { method: "DELETE", headers: TENANT });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${base}/api/v1/files/${file.id}/content`, { headers: TENANT })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/files/${file.id}`, { method: "DELETE", headers: TENANT })).status).toBe(404);
  });

  it("size 只认实际内容字节数，客户端 size 字段不能伪造", async () => {
    const base = await start(createFileHttpServer({ storage: new InMemoryObjectStorage() }));
    const response = await upload(base, sampleBody({ size: 999999 }));
    expect((await response.json() as { data: FileMeta }).data.size).toBe(Buffer.byteLength("达州农场"));
  });

  it("缺少租户身份拒绝访问，请求体 tenantId 不能冒充", async () => {
    const base = await start(createFileHttpServer({ storage: new InMemoryObjectStorage() }));
    const anonymous = await fetch(`${base}/api/v1/files`, { headers: { "content-type": "application/json" } });
    expect(anonymous.status).toBe(401);
    const spoofed = await upload(base, sampleBody({ tenantId: "tenant-b" }), { "content-type": "application/json", "x-tenant-id": "tenant-a" });
    expect(spoofed.status).toBe(201);
    expect((await spoofed.json() as { data: FileMeta }).data.tenantId).toBe("tenant-a");
  });

  it("跨租户列表为空，读取/下载/删除一律 404 且不动原文件", async () => {
    const storage = new InMemoryObjectStorage();
    const repository = new InMemoryFileRepository();
    const base = await start(createFileHttpServer({ storage, repository }));
    const created = (await (await upload(base, sampleBody())).json() as { data: FileMeta }).data;
    const other = { "x-tenant-id": "tenant-b" };
    const listed = await (await fetch(`${base}/api/v1/files`, { headers: other })).json() as { data: { total: number } };
    expect(listed.data.total).toBe(0);
    expect((await fetch(`${base}/api/v1/files/${created.id}`, { headers: other })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/files/${created.id}/content`, { headers: other })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/files/${created.id}`, { method: "DELETE", headers: other })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/files/${created.id}/content`, { headers: TENANT })).status).toBe(200);
  });

  it("共享仓储的新实例仍能看到已上传文件（重启不丢元数据）", async () => {
    const storage = new InMemoryObjectStorage();
    const repository = new InMemoryFileRepository();
    const first = await start(createFileHttpServer({ storage, repository }));
    const created = (await (await upload(first, sampleBody())).json() as { data: FileMeta }).data;
    const second = await start(createFileHttpServer({ storage, repository }));
    const listed = await (await fetch(`${second}/api/v1/files`, { headers: TENANT })).json() as { data: { items: FileMeta[]; total: number } };
    expect(listed.data.total).toBe(1);
    expect(listed.data.items[0]?.id).toBe(created.id);
    expect(await (await fetch(`${second}/api/v1/files/${created.id}/content`, { headers: TENANT })).text()).toBe("达州农场");
  });

  it("元数据写入失败只补偿本次新对象，不删已有对象", async () => {
    const storage = new InMemoryObjectStorage();
    const repository = new InMemoryFileRepository();
    let failNext = false;
    const flaky: FileRepository = {
      create: async (file) => { if (failNext) throw new Error("db down"); return repository.create(file); },
      page: repository.page.bind(repository),
      findById: repository.findById.bind(repository),
      delete: repository.delete.bind(repository),
    };
    const base = await start(createFileHttpServer({ storage, repository: flaky }));
    const first = (await (await upload(base, sampleBody())).json() as { data: FileMeta }).data;
    const deleteSpy = vi.spyOn(storage, "delete");
    failNext = true;
    const response = await upload(base, sampleBody({ name: "second.txt" }));
    expect(response.status).toBe(500);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy.mock.calls[0]?.[0]).not.toBe(first.storageKey);
    expect((await fetch(`${base}/api/v1/files/${first.id}/content`, { headers: TENANT })).status).toBe(200);
    const listed = await (await fetch(`${base}/api/v1/files`, { headers: TENANT })).json() as { data: { total: number } };
    expect(listed.data.total).toBe(1);
  });

  it("非法 base64、非法文件名与超限内容分别拒绝", async () => {
    const base = await start(createFileHttpServer({ storage: new InMemoryObjectStorage() }));
    expect((await upload(base, sampleBody({ contentBase64: "!!!not-base64!!!" }))).status).toBe(400);
    expect((await upload(base, sampleBody({ name: "../escape.txt" }))).status).toBe(400);
    expect((await upload(base, sampleBody({ name: "  " }))).status).toBe(400);
    const oversize = Buffer.alloc(MAX_FILE_BYTES + 1, 7).toString("base64");
    const tooBig = await upload(base, sampleBody({ contentBase64: oversize }));
    expect(tooBig.status).toBe(413);
  });

  it("图片按魔数内联展示，SVG 等主动内容强制附件下载", async () => {
    const base = await start(createFileHttpServer({ storage: new InMemoryObjectStorage() }));
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("rest")]);
    const pngResponse = await upload(base, { name: "a.png", contentType: "image/png", contentBase64: png.toString("base64") });
    const pngFile = (await pngResponse.json() as { data: FileMeta }).data;
    const pngContent = await fetch(`${base}/api/v1/files/${pngFile.id}/content`, { headers: TENANT });
    expect(pngContent.headers.get("content-type")).toBe("image/png");
    expect(pngContent.headers.get("content-disposition")).toContain("inline");
    const svgResponse = await upload(base, { name: "a.svg", contentType: "image/svg+xml", contentBase64: Buffer.from("<svg onload=alert(1)>").toString("base64") });
    const svgFile = (await svgResponse.json() as { data: FileMeta }).data;
    const svgContent = await fetch(`${base}/api/v1/files/${svgFile.id}/content`, { headers: TENANT });
    expect(svgContent.headers.get("content-type")).toBe("application/octet-stream");
    expect(svgContent.headers.get("content-disposition")).toContain("attachment");
    expect(svgContent.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("不存在的文件返回 404 而非 200/null", async () => {
    const base = await start(createFileHttpServer({ storage: new InMemoryObjectStorage() }));
    const missing = await fetch(`${base}/api/v1/files/no-such-id`, { headers: TENANT });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { data: null }).data).toBeNull();
  });
});

describe("InMemoryFileRepository", () => {
  it("create 只插入，重复 id 或 storageKey 冲突拒绝", async () => {
    const repository = new InMemoryFileRepository();
    const file: FileMeta = { id: "f1", tenantId: "tenant-a", name: "a.txt", contentType: "text/plain", size: 1, storageKey: "files/tenant-a/k1", createdAt: new Date().toISOString() };
    await repository.create(file);
    await expect(repository.create(file)).rejects.toThrow();
    await expect(repository.create({ ...file, id: "f2" })).rejects.toThrow();
  });

  it("分页按租户过滤且时间倒序", async () => {
    const repository = new InMemoryFileRepository();
    const now = Date.now();
    for (const [index, tenantId] of [["1", "tenant-a"], ["2", "tenant-a"], ["3", "tenant-b"]] as const) {
      await repository.create({ id: `f${index}`, tenantId, name: `f${index}.txt`, contentType: "text/plain", size: 1, storageKey: `files/${tenantId}/k${index}`, createdAt: new Date(now + Number(index) * 1000).toISOString() });
    }
    const page = await repository.page({ tenantId: "tenant-a", page: 1, size: 1 });
    expect(page.total).toBe(2);
    expect(page.pages).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual(["f2"]);
    expect((await repository.page({ tenantId: "tenant-b", page: 1, size: 20 })).items.map((item) => item.id)).toEqual(["f3"]);
  });
});