import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { ConflictError, ValidationError } from "@agri/shared";

export interface FileMeta {
  id: string;
  tenantId: string;
  name: string;
  contentType: string;
  size: number;
  storageKey: string;
  plotCode?: string;
  createdAt: string;
}

export interface FileQuery {
  tenantId: string;
  page: number;
  size: number;
}

export interface FileRepository {
  /** Insert only: never replace an existing file or its storage key. */
  create(file: FileMeta): Promise<FileMeta>;
  page(query: FileQuery): Promise<PageResult<FileMeta>>;
  findById(id: string, tenantId: string): Promise<FileMeta | null>;
  delete(id: string, tenantId: string): Promise<boolean>;
}

function requireTenant(tenantId: string): void {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new ValidationError("缺少租户标识");
}

function validateQuery(query: FileQuery): void {
  requireTenant(query.tenantId);
  if (!Number.isSafeInteger(query.page) || query.page < 1 ||
      !Number.isSafeInteger(query.size) || query.size < 1 || query.size > 200 ||
      !Number.isSafeInteger((query.page - 1) * query.size)) {
    throw new ValidationError("分页参数无效");
  }
}

function toRecord(row: Record<string, unknown>): FileMeta {
  const file: FileMeta = {
    id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name),
    contentType: String(row.content_type), size: Number(row.size), storageKey: String(row.storage_key),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
  if (row.plot_code != null) file.plotCode = String(row.plot_code);
  return file;
}

const columns = "id, tenant_id, name, content_type, size, storage_key, plot_code, created_at";

/** Table is managed exclusively by migration 017; no startup DDL or synthetic metadata. */
export class SqlFileRepository implements FileRepository {
  constructor(private readonly client: Pick<PrismaClientLike, "$queryRawUnsafe">) {}

  async create(file: FileMeta): Promise<FileMeta> {
    requireTenant(file.tenantId);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO file_metadata (${columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${columns}`,
      file.id, file.tenantId, file.name, file.contentType, file.size, file.storageKey,
      file.plotCode ?? null, file.createdAt,
    );
    if (!rows[0]) throw new Error("File metadata insert returned no row");
    return toRecord(rows[0]);
  }

  async page(query: FileQuery): Promise<PageResult<FileMeta>> {
    validateQuery(query);
    // One statement gives count and items the same snapshot, including out-of-range pages.
    // The unique id tie-breaker makes ordering deterministic when timestamps are equal.
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `WITH tenant_files AS NOT MATERIALIZED (
         SELECT ${columns} FROM file_metadata WHERE tenant_id = $1
       ), paged AS (
         SELECT * FROM tenant_files ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
       )
       SELECT totals.total, paged.* FROM (SELECT COUNT(*) AS total FROM tenant_files) totals
       LEFT JOIN paged ON TRUE ORDER BY paged.created_at DESC, paged.id DESC`,
      query.tenantId, query.size, (query.page - 1) * query.size,
    );
    const total = Number(rows[0]?.total ?? 0);
    return {
      items: rows.filter((row) => row.id != null).map(toRecord), total,
      page: query.page, size: query.size, pages: Math.ceil(total / query.size),
    };
  }

  async findById(id: string, tenantId: string): Promise<FileMeta | null> {
    requireTenant(tenantId);
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${columns} FROM file_metadata WHERE id = $1 AND tenant_id = $2`, id, tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    requireTenant(tenantId);
    const rows = await this.client.$queryRawUnsafe<Array<{ id: string }>>(
      "DELETE FROM file_metadata WHERE id = $1 AND tenant_id = $2 RETURNING id", id, tenantId,
    );
    return rows.length > 0;
  }
}

/** Explicitly ephemeral; independent server instances do not share a global array. */
export class InMemoryFileRepository implements FileRepository {
  private readonly files = new Map<string, FileMeta>();

  async create(file: FileMeta): Promise<FileMeta> {
    requireTenant(file.tenantId);
    if (this.files.has(file.id) || [...this.files.values()].some((item) => item.storageKey === file.storageKey)) {
      throw new ConflictError("文件已存在");
    }
    const record = { ...file };
    this.files.set(file.id, record);
    return { ...record };
  }

  async page(query: FileQuery): Promise<PageResult<FileMeta>> {
    validateQuery(query);
    const files = [...this.files.values()].filter((file) => file.tenantId === query.tenantId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const start = (query.page - 1) * query.size;
    return {
      items: files.slice(start, start + query.size).map((file) => ({ ...file })),
      total: files.length, page: query.page, size: query.size, pages: Math.ceil(files.length / query.size),
    };
  }

  async findById(id: string, tenantId: string): Promise<FileMeta | null> {
    requireTenant(tenantId);
    const file = this.files.get(id);
    return file?.tenantId === tenantId ? { ...file } : null;
  }

  async delete(id: string, tenantId: string): Promise<boolean> {
    requireTenant(tenantId);
    return this.files.get(id)?.tenantId === tenantId ? this.files.delete(id) : false;
  }
}
