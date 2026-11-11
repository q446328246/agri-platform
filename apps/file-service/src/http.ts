import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@agri/contracts";
import { authorizeRequest, BizError, NotFoundError, ValidationError } from "@agri/shared";
import { InMemoryFileRepository } from "./file.repository.js";
import type { FileMeta, FileRepository } from "./file.repository.js";
import { LocalFileObjectStorage } from "./storage.js";
import type { ObjectStorage } from "./storage.js";

export { InMemoryObjectStorage, S3ObjectStorage } from "./storage.js";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;
const MAX_JSON_BYTES = MAX_BASE64_LENGTH + 16 * 1024;

export interface FileHttpOptions {
  storage?: ObjectStorage;
  repository?: FileRepository;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `FILE-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) {
    throw new BizError("FILE-415", "请求类型必须是 application/json", 415);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  // Do not destroy the socket on a limit error: the caller still needs the 413 response.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_JSON_BYTES) throw new BizError("FILE-413", "文件超过 10 MiB 限制", 413);
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ValidationError("请求体不是有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function tenantOf(req: IncomingMessage): string {
  // Only the trusted gateway may supply this header; never accept tenantId from body/query.
  const tenantId = req.headers["x-tenant-id"];
  if (typeof tenantId !== "string" || !tenantId) throw new BizError("FILE-401", "缺少租户身份", 401);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(tenantId)) throw new ValidationError("租户标识无效");
  return tenantId;
}

function pageNumber(query: URLSearchParams, key: string, fallback: number, max: number): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > max) {
    throw new ValidationError("分页参数无效");
  }
  return value;
}

function uploadInput(body: Record<string, unknown>): { name: string; contentType: string; content: Buffer; plotCode?: string } {
  if (typeof body.name !== "string" || !body.name.trim() || body.name !== body.name.trim() ||
      Buffer.byteLength(body.name) > 255 || /^[.]{1,2}$/.test(body.name) ||
      /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/.test(body.name)) {
    throw new ValidationError("文件名无效（须为不超过 255 字节的普通文件名）");
  }
  try { encodeURIComponent(body.name); } catch { throw new ValidationError("文件名包含无效字符"); }
  const contentType = body.contentType ?? "application/octet-stream";
  if (typeof contentType !== "string" || contentType.length > 127 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(contentType)) {
    throw new ValidationError("文件类型无效");
  }
  const base64 = body.contentBase64;
  if (typeof base64 !== "string") throw new ValidationError("缺少 contentBase64 文件内容");
  if (base64.length > MAX_BASE64_LENGTH) throw new BizError("FILE-413", "文件超过 10 MiB 限制", 413);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new ValidationError("文件内容不是规范的 base64");
  }
  const content = Buffer.from(base64, "base64");
  if (content.toString("base64") !== base64) throw new ValidationError("文件内容不是规范的 base64");
  if (content.length > MAX_FILE_BYTES) throw new BizError("FILE-413", "文件超过 10 MiB 限制", 413);
  const input = { name: body.name, contentType: contentType.toLowerCase(), content };
  if (body.plotCode !== undefined) {
    if (typeof body.plotCode !== "string" || !body.plotCode.trim() || body.plotCode.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(body.plotCode)) throw new ValidationError("地块编码无效");
    return { ...input, plotCode: body.plotCode };
  }
  return input;
}

function isSafeInlineImage(type: string, content: Buffer): boolean {
  switch (type) {
    case "image/png": return content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "image/jpeg": return content.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
    case "image/gif": return ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"));
    case "image/webp": return content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" &&
      content.subarray(8, 12).toString("ascii") === "WEBP";
    default: return false; // SVG/HTML/XML/PDF are never served as active same-origin documents.
  }
}

export function createFileHttpServer(options: FileHttpOptions = {}): Server {
  const storage = options.storage ?? new LocalFileObjectStorage();
  const repository = options.repository ?? new InMemoryFileRepository();
  return createServer(async (req, res) => {
    const traceId = req.headers["x-request-id"]?.toString() || randomUUID();
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { status: "ok", service: "file" }, traceId);
        return;
      }
      const denied = authorizeRequest(req, { read: "plot:read", write: "plot:write" });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }
      const tenantId = tenantOf(req);
      if (req.method === "GET" && url.pathname === "/api/v1/files") {
        const page = pageNumber(url.searchParams, "page", 1, Number.MAX_SAFE_INTEGER);
        const size = pageNumber(url.searchParams, "size", 20, 200);
        send(res, 200, await repository.page({ tenantId, page, size }), traceId);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/files") {
        const input = uploadInput(await json(req));
        const id = randomUUID();
        // Independent, server-generated object key; no client-provided id/key can overwrite a file.
        const storageKey = `files/${tenantId}/${randomUUID()}`;
        const file: FileMeta = {
          id, tenantId, name: input.name, contentType: input.contentType, size: input.content.length,
          storageKey, createdAt: new Date().toISOString(),
          ...(input.plotCode === undefined ? {} : { plotCode: input.plotCode }),
        };
        // put is create-only. Only a confirmed successful put may be compensated; a failed
        // conditional put must NEVER cause deletion of a pre-existing object.
        await storage.put(storageKey, input.content);
        let created: FileMeta;
        try {
          created = await repository.create(file);
        } catch (metadataError) {
          // Not a distributed transaction: a crash/ambiguous acknowledgement or failed cleanup
          // can still leave an orphan. Do not scan objects and invent metadata on restart.
          try { await storage.delete(storageKey); }
          catch (cleanupError) { throw new AggregateError([metadataError, cleanupError], "File upload compensation failed"); }
          throw metadataError;
        }
        send(res, 201, created, traceId);
        return;
      }
      const match = url.pathname.match(/^\/api\/v1\/files\/([^/]+)(\/content)?$/);
      const id = match?.[1];
      if (id && (req.method === "GET" || (req.method === "DELETE" && !match?.[2]))) {
        const file = await repository.findById(id, tenantId);
        if (!file) throw new NotFoundError("文件不存在");
        if (req.method === "DELETE") {
          // Delete bytes first: storage failure keeps metadata available for retry. If DB
          // deletion fails afterwards, return 500 and keep the row for an idempotent retry.
          await storage.delete(file.storageKey);
          if (!await repository.delete(id, tenantId)) throw new NotFoundError("文件不存在");
          send(res, 204, null, traceId);
        } else if (match?.[2]) {
          const content = await storage.get(file.storageKey);
          if (content === null) throw new NotFoundError("文件内容不存在");
          const inline = isSafeInlineImage(file.contentType, content);
          const filename = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
          res.writeHead(200, {
            "content-type": inline ? file.contentType : "application/octet-stream",
            "content-length": content.length,
            "content-disposition": `${inline ? "inline" : "attachment"}; filename="download"; filename*=UTF-8''${filename}`,
            "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
            "cache-control": "private, no-store",
          });
          res.end(content);
        } else {
          send(res, 200, file, traceId);
        }
        return;
      }
      throw new NotFoundError("接口不存在");
    } catch (error) {
      const status = error instanceof BizError && error.httpStatus >= 400 && error.httpStatus < 500 ? error.httpStatus : 500;
      if (status === 413) { res.setHeader("connection", "close"); req.resume(); }
      send(res, status, null, traceId, status === 500 ? "文件服务暂时不可用" : (error as BizError).message);
    }
  });
}
