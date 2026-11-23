import type { PageResult } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { keywordHits, likePattern, toIsoTimestamp, ulid } from "@agri/shared";

export const CAMERA_STATUSES = ["ONLINE", "OFFLINE"] as const;
export type CameraStatus = (typeof CAMERA_STATUSES)[number];

/**
 * 摄像机台账。
 *
 * 摄像机不进 iot-service 设备台账：设备台账管的是「可下发控制指令」的水肥/农机，
 * 摄像机走独立的监看/云台/录像链路，云台指令有独立状态机（QUEUED/SENT/FAILED），
 * 不并入控制指令状态机。流地址是 B 类外部条件，平台只存地址、不保证能拉到流。
 */
export interface Camera {
  id: string;
  tenantId: string;
  name: string;
  /** 绑定地块编码，未绑定为空串 */
  plotCode: string;
  status: CameraStatus;
  /** 实时流地址（HLS m3u8 / mp4） */
  streamUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface CameraQuery {
  page: number;
  size: number;
  /** 命中名称 */
  keyword?: string;
  plotCode?: string;
  status?: CameraStatus;
}

export interface CreateCameraInput {
  tenantId: string;
  name: string;
  plotCode?: string;
  status: CameraStatus;
  streamUrl: string;
}

export interface UpdateCameraInput {
  name?: string;
  /** 传空串表示解绑地块 */
  plotCode?: string;
  status?: CameraStatus;
  streamUrl?: string;
}

export interface CameraRepository {
  list(tenantId: string, query: CameraQuery): Promise<PageResult<Camera>>;
  find(tenantId: string, id: string): Promise<Camera | null>;
  create(tx: Tx | undefined, input: CreateCameraInput): Promise<Camera>;
  update(tx: Tx | undefined, tenantId: string, id: string, patch: UpdateCameraInput): Promise<Camera | null>;
  remove(tx: Tx | undefined, tenantId: string, id: string): Promise<boolean>;
}

/** 内存实现：仅供测试与降级路径，构造默认空库；演示条目由组合根注入 */
export class InMemoryCameraRepository implements CameraRepository {
  private readonly cameras = new Map<string, Camera>();

  constructor(seed: Camera[] = []) {
    for (const camera of seed) this.cameras.set(camera.id, structuredClone(camera));
  }

  async list(tenantId: string, query: CameraQuery): Promise<PageResult<Camera>> {
    const filtered = [...this.cameras.values()]
      .filter((camera) => camera.tenantId === tenantId
        && (query.keyword === undefined || keywordHits(query.keyword, [camera.name]))
        && (query.plotCode === undefined || camera.plotCode === query.plotCode)
        && (query.status === undefined || camera.status === query.status))
      .sort((a, b) => a.id.localeCompare(b.id));
    const start = (query.page - 1) * query.size;
    return {
      items: filtered.slice(start, start + query.size).map((camera) => structuredClone(camera)),
      total: filtered.length,
      page: query.page,
      size: query.size,
      pages: Math.ceil(filtered.length / query.size),
    };
  }

  async find(tenantId: string, id: string): Promise<Camera | null> {
    const camera = this.cameras.get(id);
    return camera && camera.tenantId === tenantId ? structuredClone(camera) : null;
  }

  async create(_tx: Tx | undefined, input: CreateCameraInput): Promise<Camera> {
    const now = new Date().toISOString();
    const camera: Camera = {
      id: ulid(),
      tenantId: input.tenantId,
      name: input.name,
      plotCode: input.plotCode ?? "",
      status: input.status,
      streamUrl: input.streamUrl,
      createdAt: now,
      updatedAt: now,
    };
    this.cameras.set(camera.id, structuredClone(camera));
    return structuredClone(camera);
  }

  async update(_tx: Tx | undefined, tenantId: string, id: string, patch: UpdateCameraInput): Promise<Camera | null> {
    const camera = this.cameras.get(id);
    if (!camera || camera.tenantId !== tenantId) return null;
    if (patch.name !== undefined) camera.name = patch.name;
    if (patch.plotCode !== undefined) camera.plotCode = patch.plotCode;
    if (patch.status !== undefined) camera.status = patch.status;
    if (patch.streamUrl !== undefined) camera.streamUrl = patch.streamUrl;
    camera.updatedAt = new Date().toISOString();
    return structuredClone(camera);
  }

  async remove(_tx: Tx | undefined, tenantId: string, id: string): Promise<boolean> {
    const camera = this.cameras.get(id);
    if (!camera || camera.tenantId !== tenantId) return false;
    this.cameras.delete(id);
    return true;
  }
}

/**
 * 演示摄像机：与迁移 070 注入的四台逐字段对齐，编号沿用既有 camera-001~004，
 * 与迁移 010 的虫情演示数据（device_id 引用）保持一致，不换号。
 */
export function demoCameras(tenantId = "tenant-demo"): Camera[] {
  const now = new Date().toISOString();
  return [
    { id: "camera-001", tenantId, name: "东区一号田摄像头", plotCode: "511723-000001-01-00001-0000-5", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-001.m3u8", createdAt: now, updatedAt: now },
    { id: "camera-002", tenantId, name: "西区一号田摄像头", plotCode: "511723-000001-02-00005-0000-C", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-002.m3u8", createdAt: now, updatedAt: now },
    { id: "camera-003", tenantId, name: "联片一号田摄像头", plotCode: "511723-000001-03-00008-0000-P", status: "ONLINE", streamUrl: "https://example.invalid/live/camera-003.m3u8", createdAt: now, updatedAt: now },
    { id: "camera-004", tenantId, name: "场部入口枪机", plotCode: "", status: "OFFLINE", streamUrl: "https://example.invalid/live/camera-004.m3u8", createdAt: now, updatedAt: now },
  ];
}

const columns = "id, tenant_id, name, plot_code, status, stream_url, created_at, updated_at";

function fromRow(row: Record<string, unknown>): Camera {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    plotCode: String(row.plot_code),
    status: row.status as CameraStatus,
    streamUrl: String(row.stream_url),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/** SQL 实现：迁移 070 的 video_cameras */
export class SqlCameraRepository implements CameraRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async list(tenantId: string, query: CameraQuery): Promise<PageResult<Camera>> {
    const values: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (query.keyword !== undefined) {
      values.push(likePattern(query.keyword));
      where.push(`name ILIKE $${values.length} ESCAPE '\\'`);
    }
    if (query.plotCode !== undefined) { values.push(query.plotCode); where.push(`plot_code = $${values.length}`); }
    if (query.status !== undefined) { values.push(query.status); where.push(`status = $${values.length}`); }
    const filter = where.join(" AND ");
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM video_cameras WHERE ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM video_cameras WHERE ${filter} ORDER BY id LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values,
    );
    return { items: rows.map(fromRow), total, page: query.page, size: query.size, pages: Math.ceil(total / query.size) };
  }

  async find(tenantId: string, id: string): Promise<Camera | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns} FROM video_cameras WHERE tenant_id = $1 AND id = $2`, tenantId, id,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async create(tx: Tx | undefined, input: CreateCameraInput): Promise<Camera> {
    const client = tx ?? this.client;
    const now = new Date();
    const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO video_cameras (id, tenant_id, name, plot_code, status, stream_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${columns}`,
      ulid(), input.tenantId, input.name, input.plotCode ?? "", input.status, input.streamUrl, now,
    );
    return fromRow(rows[0]!);
  }

  async update(tx: Tx | undefined, tenantId: string, id: string, patch: UpdateCameraInput): Promise<Camera | null> {
    const client = tx ?? this.client;
    const assignments: string[] = [];
    const values: unknown[] = [];
    const map: Array<[keyof UpdateCameraInput, string]> = [
      ["name", "name"], ["plotCode", "plot_code"], ["status", "status"], ["streamUrl", "stream_url"],
    ];
    for (const [key, column] of map) {
      if (!(key in patch) || patch[key] === undefined) continue;
      assignments.push(`${column} = $${values.length + 1}`);
      values.push(patch[key]);
    }
    if (assignments.length === 0) return this.find(tenantId, id);
    assignments.push(`updated_at = $${values.length + 1}`);
    values.push(new Date());
    const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE video_cameras SET ${assignments.join(", ")} WHERE tenant_id = $${values.length + 1} AND id = $${values.length + 2} RETURNING ${columns}`,
      ...values, tenantId, id,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async remove(tx: Tx | undefined, tenantId: string, id: string): Promise<boolean> {
    const client = tx ?? this.client;
    const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
      `DELETE FROM video_cameras WHERE tenant_id = $1 AND id = $2 RETURNING id`, tenantId, id,
    );
    return rows.length > 0;
  }
}
