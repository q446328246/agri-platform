import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ObjectStorage { put(key: string, content: Buffer): Promise<void>; get(key: string): Promise<Buffer | null>; delete(key: string): Promise<void> }

export class LocalFileObjectStorage implements ObjectStorage {
  constructor(private readonly root = process.env.FILE_STORAGE_DIR ?? path.resolve(process.cwd(), ".data/files")) {}
  private resolve(key: string): string { const target = path.resolve(this.root, key); if (!target.startsWith(path.resolve(this.root) + path.sep)) throw new Error("非法存储键"); return target }
  async put(key: string, content: Buffer): Promise<void> { const target = this.resolve(key); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
  async get(key: string): Promise<Buffer | null> { try { return await readFile(this.resolve(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
  async delete(key: string): Promise<void> { try { await unlink(this.resolve(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Buffer>();
  async put(key: string, content: Buffer): Promise<void> { this.objects.set(key, Buffer.from(content)); }
  async get(key: string): Promise<Buffer | null> { return this.objects.get(key) ?? null; }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

export interface S3StorageOptions { endpoint: string; bucket: string; region?: string; accessKey: string; secretKey: string; fetchImpl?: typeof fetch }

export class S3ObjectStorage implements ObjectStorage {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: S3StorageOptions) { this.endpoint = new URL(options.endpoint.endsWith("/") ? options.endpoint : `${options.endpoint}/`); this.region = options.region ?? "us-east-1"; this.fetchImpl = options.fetchImpl ?? fetch; }
  private uri(key: string): string { return `${this.endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(this.options.bucket)}/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`; }
  private async request(method: string, key: string | null, content?: Buffer): Promise<Response> {
    const now = new Date(); const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); const date = amzDate.slice(0, 8); const payload = content ?? Buffer.alloc(0); const payloadHash = createHash("sha256").update(payload).digest("hex"); const url = new URL(this.endpoint); url.pathname = key === null ? `${this.endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(this.options.bucket)}` : this.uri(key);
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate }; const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join(""); const signedHeaders = Object.keys(headers).sort().join(";"); const canonicalRequest = `${method}\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`; const scope = `${date}/${this.region}/s3/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`; const sign = (keyValue: Buffer | string, value: string) => createHmac("sha256", keyValue).update(value).digest(); const kDate = sign(`AWS4${this.options.secretKey}`, date); const kRegion = sign(kDate, this.region); const kService = sign(kRegion, "s3"); const signingKey = sign(kService, "aws4_request"); const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex"); headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const init: RequestInit = { method, headers };
    if (content !== undefined) init.body = content;
    return this.fetchImpl(url, init);
  }
  async put(key: string, content: Buffer): Promise<void> { const response = await this.request("PUT", key, content); if (!response.ok) throw new Error(`对象存储上传失败: ${response.status}`); }
  async ensureBucket(): Promise<void> { const response = await this.request("PUT", null); if (!response.ok && response.status !== 409) throw new Error(`对象存储 bucket 创建失败: ${response.status}`); }
  async get(key: string): Promise<Buffer | null> { const response = await this.request("GET", key); if (response.status === 404) return null; if (!response.ok) throw new Error(`对象存储读取失败: ${response.status}`); return Buffer.from(await response.arrayBuffer()); }
  async delete(key: string): Promise<void> { const response = await this.request("DELETE", key); if (!response.ok && response.status !== 404) throw new Error(`对象存储删除失败: ${response.status}`); }
}
