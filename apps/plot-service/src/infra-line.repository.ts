import type { GeoLineString } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 田间线路/管线仓储。
 *
 * 一张图上除了地块面，还需要管线这类线状设施才能看懂灌水走向：
 * 灌水管、施肥管、电力线、机耕道共用一张表，用 lineType 区分，
 * 几何统一存 LineString，前端按类型给不同颜色即可叠加渲染。
 */

/** 线路类型：灌水管、施肥管、电力线、机耕道 */
export type InfraLineType = "IRRIGATION_PIPE" | "FERTILIZATION_PIPE" | "ELECTRIC_LINE" | "ROAD";

export const INFRA_LINE_TYPES: InfraLineType[] = ["IRRIGATION_PIPE", "FERTILIZATION_PIPE", "ELECTRIC_LINE", "ROAD"];

/** 线路记录 */
export interface InfraLine {
  id: string;
  lineCode: string;
  lineName: string;
  lineType: InfraLineType;
  tenantId: string;
  geom: GeoLineString;
  /** 线路长度，单位：米 */
  lengthM: number;
  createdAt: string;
  deletedAt?: string;
}

/** 新增/更新线路入参 */
export interface InfraLineInput {
  lineCode?: string;
  lineName: string;
  lineType: InfraLineType;
  geom: GeoLineString;
  lengthM?: number;
}

export interface InfraLineRepository {
  listByTenant(tenantId: string): Promise<InfraLine[]>;
  findByCode(lineCode: string): Promise<InfraLine | null>;
  create(tx: unknown, record: InfraLine): Promise<InfraLine>;
  remove(tx: unknown, lineCode: string, deletedAt: string): Promise<boolean>;
}

/**
 * 按折点估算线路长度，单位米。
 *
 * 平台坐标是经纬度，这里用等距圆柱近似：纬度方向 1 度约 111.32 公里，
 * 经度方向按纬度余弦收缩。田间尺度（公里级）误差可忽略，
 * 精度要求更高时应改用库内地理函数 ST_Length。
 */
export function estimateLengthM(line: GeoLineString): number {
  const points = line.coordinates;
  if (points.length < 2) return 0;
  const rad = Math.PI / 180;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to) continue;
    const [lng1, lat1] = from;
    const [lng2, lat2] = to;
    if (lng1 === undefined || lat1 === undefined || lng2 === undefined || lat2 === undefined) continue;
    const midLat = ((lat1 + lat2) / 2) * rad;
    const dx = (lng2 - lng1) * 111_320 * Math.cos(midLat);
    const dy = (lat2 - lat1) * 110_540;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return Number(total.toFixed(2));
}

function toLine(row: Record<string, unknown>): InfraLine {
  const record: InfraLine = {
    id: String(row.id),
    lineCode: String(row.line_code),
    lineName: String(row.line_name),
    lineType: String(row.line_type) as InfraLineType,
    tenantId: String(row.tenant_id ?? "tenant-demo"),
    geom: row.geom as GeoLineString,
    lengthM: Number(row.length_m ?? 0),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.deleted_at !== null && row.deleted_at !== undefined) record.deletedAt = toIsoTimestamp(row.deleted_at);
  return record;
}

/** PostgreSQL 实现，表结构由迁移 008 管理 */
export class SqlInfraLineRepository implements InfraLineRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async listByTenant(tenantId: string): Promise<InfraLine[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, line_code, line_name, line_type, tenant_id, geom, length_m, created_at, deleted_at
       FROM infra_lines WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY line_code`,
      tenantId,
    );
    return rows.map(toLine);
  }

  async findByCode(lineCode: string): Promise<InfraLine | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, line_code, line_name, line_type, tenant_id, geom, length_m, created_at, deleted_at
       FROM infra_lines WHERE line_code = $1 AND deleted_at IS NULL LIMIT 1`,
      lineCode,
    );
    const row = rows[0];
    return row ? toLine(row) : null;
  }

  async create(tx: unknown, record: InfraLine): Promise<InfraLine> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO infra_lines (id, line_code, line_name, line_type, tenant_id, geom, length_m, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      record.id,
      record.lineCode,
      record.lineName,
      record.lineType,
      record.tenantId,
      JSON.stringify(record.geom),
      record.lengthM,
      record.createdAt,
    );
    return record;
  }

  async remove(tx: unknown, lineCode: string, deletedAt: string): Promise<boolean> {
    return (await this.executor(tx).$executeRawUnsafe(
      `UPDATE infra_lines SET deleted_at = $2 WHERE line_code = $1 AND deleted_at IS NULL`,
      lineCode,
      deletedAt,
    )) > 0;
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryInfraLineRepository implements InfraLineRepository {
  private readonly rows: InfraLine[] = [];

  constructor(seed: InfraLine[] = []) {
    this.rows.push(...seed);
  }

  async listByTenant(tenantId: string): Promise<InfraLine[]> {
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.deletedAt === undefined)
      .sort((a, b) => a.lineCode.localeCompare(b.lineCode));
  }

  async findByCode(lineCode: string): Promise<InfraLine | null> {
    return this.rows.find((row) => row.lineCode === lineCode && row.deletedAt === undefined) ?? null;
  }

  async create(_tx: unknown, record: InfraLine): Promise<InfraLine> {
    this.rows.push(record);
    return record;
  }

  async remove(_tx: unknown, lineCode: string, deletedAt: string): Promise<boolean> {
    const row = this.rows.find((item) => item.lineCode === lineCode && item.deletedAt === undefined);
    if (!row) return false;
    row.deletedAt = deletedAt;
    return true;
  }
}
