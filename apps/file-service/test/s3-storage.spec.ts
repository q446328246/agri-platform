import { describe, expect, it, vi } from "vitest";
import { S3ObjectStorage } from "../src/storage.js";

describe("S3ObjectStorage", () => {
  it("生成 MinIO 兼容的签名请求并上传对象", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const storage = new S3ObjectStorage({ endpoint: "http://minio.test:9000", bucket: "agri", accessKey: "access", secretKey: "secret", fetchImpl });
    await storage.put("local/demo.txt", Buffer.from("demo"));
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/agri/local/demo.txt");
    expect(init.method).toBe("PUT");
    expect(String((init.headers as Record<string, string>).authorization)).toContain("AWS4-HMAC-SHA256 Credential=access/");
  });
  it("读取对象时把 404 转换为空", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const storage = new S3ObjectStorage({ endpoint: "http://minio.test:9000", bucket: "agri", accessKey: "access", secretKey: "secret", fetchImpl });
    await expect(storage.get("missing.txt")).resolves.toBeNull();
  });
});
