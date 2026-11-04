import type { GeoPolygon } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";

/**
 * 地块仓储契约与示例实现。
 *
 * 仓储方法把事务对象作为首个显式参数，使「这条写入是否处于事务中」在调用处
 * 一目了然，不依赖隐式上下文推断，避免事务边界被无意扩大。
 */

/** 地块持久化记录 */
export interface PlotRecord {
  parcelId: string;
  parcelCode: string;
  parcelName: string;
  tenantId: string;
  farmId: string;
  /** 面积，单位：亩 */
  areaMu: number;
  /** 土壤类型编码，可选 */
  soilType?: string;
  /** 边界几何，库内统一 CGCS2000（EPSG:4490） */
  geom: GeoPolygon;
  createdAt: string;
  updatedAt: string;
  /** 软删除时间，为空表示未删除 */
  deletedAt?: string;
}

/** 地块仓储契约 */
export interface PlotRepository {
  /** 按编码查询，未命中返回 null */
  findByCode(tx: unknown, parcelCode: string): Promise<PlotRecord | null>;
  /** 写入地块 */
  create(tx: unknown, record: PlotRecord): Promise<PlotRecord>;
  /** 更新未删除地块，未命中返回 null */
  update(tx: unknown, parcelCode: string, patch: PlotPatch): Promise<PlotRecord | null>;
  /** 软删除未删除地块，未命中返回 false */
  remove(tx: unknown, parcelCode: string, deletedAt: string): Promise<boolean>;
  /** 按租户列出未删除地块 */
  listByTenant(tenantId: string): Promise<PlotRecord[]>;
}

export interface PlotPatch {
  parcelName?: string;
  areaMu?: number;
  soilType?: string;
  geom?: GeoPolygon;
  updatedAt: string;
}

/** 内存实现，用于示例与测试 */
export class InMemoryPlotRepository implements PlotRepository {
  private readonly rows: PlotRecord[] = [];

  async findByCode(_tx: unknown, parcelCode: string): Promise<PlotRecord | null> {
    return this.rows.find((row) => row.parcelCode === parcelCode && row.deletedAt === undefined) ?? null;
  }

  async create(_tx: unknown, record: PlotRecord): Promise<PlotRecord> {
    this.rows.push(record);
    return record;
  }

  async update(_tx: unknown, parcelCode: string, patch: PlotPatch): Promise<PlotRecord | null> {
    const row = this.rows.find((item) => item.parcelCode === parcelCode && item.deletedAt === undefined);
    if (!row) return null;
    if (patch.parcelName !== undefined) row.parcelName = patch.parcelName;
    if (patch.areaMu !== undefined) row.areaMu = patch.areaMu;
    if (patch.soilType !== undefined) row.soilType = patch.soilType;
    if (patch.geom !== undefined) row.geom = patch.geom;
    row.updatedAt = patch.updatedAt;
    return row;
  }

  async remove(_tx: unknown, parcelCode: string, deletedAt: string): Promise<boolean> {
    const row = this.rows.find((item) => item.parcelCode === parcelCode && item.deletedAt === undefined);
    if (!row) return false;
    row.deletedAt = deletedAt;
    row.updatedAt = deletedAt;
    return true;
  }

  async listByTenant(tenantId: string): Promise<PlotRecord[]> {
    return this.rows.filter((row) => row.tenantId === tenantId && row.deletedAt === undefined);
  }

  /** 全部记录，供断言使用 */
  all(): PlotRecord[] {
    return [...this.rows];
  }
}

/** PostgreSQL 适配器。表结构由服务迁移管理，仓储只依赖 @agri/db 的最小客户端契约。 */
export class SqlPlotRepository implements PlotRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  private toRecord(row: Record<string, unknown>): PlotRecord {
    const record: PlotRecord = {
      parcelId: String(row.parcel_id),
      parcelCode: String(row.parcel_code),
      parcelName: String(row.parcel_name),
      tenantId: String(row.tenant_id),
      farmId: String(row.farm_id),
      areaMu: Number(row.area_mu),
      geom: row.geom as GeoPolygon,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.soil_type !== null && row.soil_type !== undefined) record.soilType = String(row.soil_type);
    if (row.deleted_at !== null && row.deleted_at !== undefined) record.deletedAt = String(row.deleted_at);
    return record;
  }

  async findByCode(tx: unknown, parcelCode: string): Promise<PlotRecord | null> {
    const rows = await this.executor(tx).$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, geom, created_at, updated_at, deleted_at
       FROM plot_records WHERE parcel_code = $1 AND deleted_at IS NULL LIMIT 1`,
      parcelCode,
    );
    const row = rows[0];
    return row ? this.toRecord(row) : null;
  }

  async create(tx: unknown, record: PlotRecord): Promise<PlotRecord> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO plot_records
       (parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, geom, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      record.parcelId,
      record.parcelCode,
      record.parcelName,
      record.tenantId,
      record.farmId,
      record.areaMu,
      record.soilType ?? null,
      JSON.stringify(record.geom),
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  async update(tx: unknown, parcelCode: string, patch: PlotPatch): Promise<PlotRecord | null> {
    const executor = this.executor(tx);
    const rows = await executor.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, geom, created_at, updated_at, deleted_at
       FROM plot_records WHERE parcel_code = $1 AND deleted_at IS NULL LIMIT 1`,
      parcelCode,
    );
    if (!rows[0]) return null;
    await executor.$executeRawUnsafe(
      `UPDATE plot_records SET parcel_name = COALESCE($2, parcel_name), area_mu = COALESCE($3, area_mu),
       soil_type = COALESCE($4, soil_type), geom = COALESCE($5::jsonb, geom), updated_at = $6
       WHERE parcel_code = $1 AND deleted_at IS NULL`,
      parcelCode,
      patch.parcelName ?? null,
      patch.areaMu ?? null,
      patch.soilType ?? null,
      patch.geom ? JSON.stringify(patch.geom) : null,
      patch.updatedAt,
    );
    return this.toRecord({ ...rows[0], parcel_name: patch.parcelName ?? rows[0].parcel_name, area_mu: patch.areaMu ?? rows[0].area_mu, soil_type: patch.soilType ?? rows[0].soil_type, geom: patch.geom ?? rows[0].geom, updated_at: patch.updatedAt });
  }

  async remove(tx: unknown, parcelCode: string, deletedAt: string): Promise<boolean> {
    return (await this.executor(tx).$executeRawUnsafe(
      `UPDATE plot_records SET deleted_at = $2, updated_at = $2 WHERE parcel_code = $1 AND deleted_at IS NULL`,
      parcelCode,
      deletedAt,
    )) > 0;
  }

  async listByTenant(tenantId: string): Promise<PlotRecord[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, geom, created_at, updated_at, deleted_at
       FROM plot_records WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      tenantId,
    );
    return rows.map((row) => this.toRecord(row));
  }
}
