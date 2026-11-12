import type { GeoPolygon } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 片区仓储。
 *
 * 片区是地块编码 area 段的业务实体：同一片区的地块共享灌排设施与作业计划，
 * 一张图上也需要按片区看面积与分布。归属关系存在 plot_records.zone_code 上，
 * 这里只管片区本身的建档、改名、配色与软删除。
 */

/** 片区记录 */
export interface PlotZone {
  id: string;
  /** 片区编码，如 ZONE-01；在地块上以 zoneCode 引用 */
  zoneCode: string;
  zoneName: string;
  tenantId: string;
  farmId: string;
  /** 地图配色，前端直接使用 */
  color: string;
  description?: string;
  /** 实测边界；为空时前端按成员地块外轮廓绘制 */
  geom?: GeoPolygon;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** 新增/更新片区入参 */
export interface ZoneInput {
  zoneCode?: string;
  zoneName: string;
  farmId?: string;
  color?: string;
  description?: string;
  geom?: GeoPolygon;
}

export interface ZonePatch {
  zoneName?: string;
  color?: string;
  description?: string;
  geom?: GeoPolygon;
  updatedAt: string;
}

export interface ZoneRepository {
  listByTenant(tenantId: string): Promise<PlotZone[]>;
  findByCode(zoneCode: string): Promise<PlotZone | null>;
  create(tx: unknown, zone: PlotZone): Promise<PlotZone>;
  update(tx: unknown, zoneCode: string, patch: ZonePatch): Promise<PlotZone | null>;
  remove(tx: unknown, zoneCode: string, deletedAt: string): Promise<boolean>;
}

/** 内存实现，用于示例与测试 */
export class InMemoryZoneRepository implements ZoneRepository {
  private readonly rows: PlotZone[] = [];

  async listByTenant(tenantId: string): Promise<PlotZone[]> {
    // 与 SQL 的 ORDER BY zone_code 同序，并且一律深拷贝：片区记录嵌了 geom，交出存储引用等于绕过 update 改库
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.deletedAt === undefined)
      .sort((a, b) => a.zoneCode.localeCompare(b.zoneCode))
      .map((row) => structuredClone(row));
  }

  async findByCode(zoneCode: string): Promise<PlotZone | null> {
    const row = this.rows.find((item) => item.zoneCode === zoneCode && item.deletedAt === undefined);
    return row ? structuredClone(row) : null;
  }

  async create(_tx: unknown, zone: PlotZone): Promise<PlotZone> {
    const row = structuredClone(zone);
    this.rows.push(row);
    return structuredClone(row);
  }

  async update(_tx: unknown, zoneCode: string, patch: ZonePatch): Promise<PlotZone | null> {
    const row = this.rows.find((item) => item.zoneCode === zoneCode && item.deletedAt === undefined);
    if (!row) return null;
    if (patch.zoneName !== undefined) row.zoneName = patch.zoneName;
    if (patch.color !== undefined) row.color = patch.color;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.geom !== undefined) row.geom = structuredClone(patch.geom);
    row.updatedAt = patch.updatedAt;
    return structuredClone(row);
  }

  async remove(_tx: unknown, zoneCode: string, deletedAt: string): Promise<boolean> {
    const row = this.rows.find((item) => item.zoneCode === zoneCode && item.deletedAt === undefined);
    if (!row) return false;
    row.deletedAt = deletedAt;
    row.updatedAt = deletedAt;
    return true;
  }
}

function toZone(row: Record<string, unknown>): PlotZone {
  const zone: PlotZone = {
    id: String(row.id),
    zoneCode: String(row.zone_code),
    zoneName: String(row.zone_name),
    tenantId: String(row.tenant_id),
    farmId: String(row.farm_id),
    color: String(row.color ?? "#00d4ff"),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  if (row.description !== null && row.description !== undefined) zone.description = String(row.description);
  if (row.geom !== null && row.geom !== undefined) zone.geom = row.geom as GeoPolygon;
  if (row.deleted_at !== null && row.deleted_at !== undefined) zone.deletedAt = toIsoTimestamp(row.deleted_at);
  return zone;
}

const COLUMNS = "id, zone_code, zone_name, tenant_id, farm_id, color, description, geom, created_at, updated_at, deleted_at";

/** PostgreSQL 实现，表结构由迁移 009 管理 */
export class SqlZoneRepository implements ZoneRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async listByTenant(tenantId: string): Promise<PlotZone[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM plot_zones WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY zone_code ASC`,
      tenantId,
    );
    return rows.map(toZone);
  }

  async findByCode(zoneCode: string): Promise<PlotZone | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM plot_zones WHERE zone_code = $1 AND deleted_at IS NULL LIMIT 1`,
      zoneCode,
    );
    const row = rows[0];
    return row ? toZone(row) : null;
  }

  async create(tx: unknown, zone: PlotZone): Promise<PlotZone> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO plot_zones (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      zone.id,
      zone.zoneCode,
      zone.zoneName,
      zone.tenantId,
      zone.farmId,
      zone.color,
      zone.description ?? null,
      zone.geom ? JSON.stringify(zone.geom) : null,
      zone.createdAt,
      zone.updatedAt,
      zone.deletedAt ?? null,
    );
    return zone;
  }

  async update(tx: unknown, zoneCode: string, patch: ZonePatch): Promise<PlotZone | null> {
    const executor = this.executor(tx);
    const rows = await executor.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM plot_zones WHERE zone_code = $1 AND deleted_at IS NULL LIMIT 1`,
      zoneCode,
    );
    const row = rows[0];
    if (!row) return null;
    await executor.$executeRawUnsafe(
      `UPDATE plot_zones SET zone_name = COALESCE($2, zone_name), color = COALESCE($3, color),
       description = COALESCE($4, description), geom = COALESCE($5::jsonb, geom), updated_at = $6
       WHERE zone_code = $1 AND deleted_at IS NULL`,
      zoneCode,
      patch.zoneName ?? null,
      patch.color ?? null,
      patch.description ?? null,
      patch.geom ? JSON.stringify(patch.geom) : null,
      patch.updatedAt,
    );
    return toZone({
      ...row,
      zone_name: patch.zoneName ?? row.zone_name,
      color: patch.color ?? row.color,
      description: patch.description ?? row.description,
      geom: patch.geom ?? row.geom,
      updated_at: patch.updatedAt,
    });
  }

  async remove(tx: unknown, zoneCode: string, deletedAt: string): Promise<boolean> {
    return (await this.executor(tx).$executeRawUnsafe(
      `UPDATE plot_zones SET deleted_at = $2, updated_at = $2 WHERE zone_code = $1 AND deleted_at IS NULL`,
      zoneCode,
      deletedAt,
    )) > 0;
  }
}
