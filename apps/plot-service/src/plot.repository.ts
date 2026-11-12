import type { GeoPolygon } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

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
  /** 所属片区编码，为空表示未划入片区 */
  zoneCode?: string;
  /** 地块类型：FIELD / GREENHOUSE / ORCHARD / AQUACULTURE，与前端 PlotType 枚举同源 */
  plotType?: string;
  /** 地块状态：DRAFT / ACTIVE / FALLOW / ARCHIVED，与前端 PlotStatus 枚举同源 */
  plotStatus?: string;
  /** 当前种植作物，自由文本 */
  currentCrop?: string;
  /** 负责人姓名 */
  ownerName?: string;
  /** 负责人联系电话 */
  ownerPhone?: string;
  /** 备注 */
  remark?: string;
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
  /** 传入 null 表示移出片区 */
  zoneCode?: string | null;
  plotType?: string | null;
  plotStatus?: string | null;
  /** 以下字段传 null 表示清空，传 undefined 表示不改动 */
  currentCrop?: string | null;
  ownerName?: string | null;
  ownerPhone?: string | null;
  remark?: string | null;
  geom?: GeoPolygon;
  updatedAt: string;
}

/** 查询与写入共用的列清单，新增字段只改这一处，避免三处 SELECT 漂移 */
const PLOT_COLUMNS =
  "parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, zone_code, plot_type, plot_status, current_crop, owner_name, owner_phone, remark, geom, created_at, updated_at, deleted_at";

/** 内存实现，用于示例与测试 */
export class InMemoryPlotRepository implements PlotRepository {
  private readonly rows: PlotRecord[] = [];

  async findByCode(_tx: unknown, parcelCode: string): Promise<PlotRecord | null> {
    const row = this.rows.find((item) => item.parcelCode === parcelCode && item.deletedAt === undefined);
    return row ? toMemoryPlot(row) : null;
  }

  async create(_tx: unknown, record: PlotRecord): Promise<PlotRecord> {
    const row = toMemoryPlot(record);
    this.rows.push(row);
    return toMemoryPlot(row);
  }

  async update(_tx: unknown, parcelCode: string, patch: PlotPatch): Promise<PlotRecord | null> {
    const row = this.rows.find((item) => item.parcelCode === parcelCode && item.deletedAt === undefined);
    if (!row) return null;
    if (patch.parcelName !== undefined) row.parcelName = patch.parcelName;
    if (patch.areaMu !== undefined) row.areaMu = patch.areaMu;
    if (patch.soilType !== undefined) row.soilType = patch.soilType;
    if (patch.zoneCode !== undefined) {
      if (patch.zoneCode === null) delete row.zoneCode;
      else row.zoneCode = patch.zoneCode;
    }
    const assign = (key: "plotType" | "plotStatus" | "currentCrop" | "ownerName" | "ownerPhone" | "remark", value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null) delete row[key];
      else row[key] = value;
    };
    assign("plotType", patch.plotType);
    assign("plotStatus", patch.plotStatus);
    assign("currentCrop", patch.currentCrop);
    assign("ownerName", patch.ownerName);
    assign("ownerPhone", patch.ownerPhone);
    assign("remark", patch.remark);
    if (patch.geom !== undefined) row.geom = patch.geom;
    row.updatedAt = patch.updatedAt;
    return toMemoryPlot(row);
  }

  async remove(_tx: unknown, parcelCode: string, deletedAt: string): Promise<boolean> {
    const row = this.rows.find((item) => item.parcelCode === parcelCode && item.deletedAt === undefined);
    if (!row) return false;
    row.deletedAt = deletedAt;
    row.updatedAt = deletedAt;
    return true;
  }

  async listByTenant(tenantId: string): Promise<PlotRecord[]> {
    // 与 SQL 的 ORDER BY created_at DESC 同序：建档顺序不等于展示顺序，补录旧地块时插入序会串位
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.deletedAt === undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((row) => toMemoryPlot(row));
  }

  /** 全部记录，供断言使用 */
  all(): PlotRecord[] {
    return this.rows.map((row) => toMemoryPlot(row));
  }
}

/** 内存进出记录一律深拷贝：地块记录嵌了 geom，交出存储引用后调用方改手就会绕过 update 直接改库 */
function toMemoryPlot(record: PlotRecord): PlotRecord {
  return structuredClone(record);
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
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: toIsoTimestamp(row.updated_at),
    };
    if (row.soil_type !== null && row.soil_type !== undefined) record.soilType = String(row.soil_type);
    if (row.zone_code !== null && row.zone_code !== undefined) record.zoneCode = String(row.zone_code);
    if (row.plot_type !== null && row.plot_type !== undefined) record.plotType = String(row.plot_type);
    if (row.plot_status !== null && row.plot_status !== undefined) record.plotStatus = String(row.plot_status);
    if (row.current_crop !== null && row.current_crop !== undefined) record.currentCrop = String(row.current_crop);
    if (row.owner_name !== null && row.owner_name !== undefined) record.ownerName = String(row.owner_name);
    if (row.owner_phone !== null && row.owner_phone !== undefined) record.ownerPhone = String(row.owner_phone);
    if (row.remark !== null && row.remark !== undefined) record.remark = String(row.remark);
    if (row.deleted_at !== null && row.deleted_at !== undefined) record.deletedAt = toIsoTimestamp(row.deleted_at);
    return record;
  }

  async findByCode(tx: unknown, parcelCode: string): Promise<PlotRecord | null> {
    const rows = await this.executor(tx).$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${PLOT_COLUMNS}
       FROM plot_records WHERE parcel_code = $1 AND deleted_at IS NULL LIMIT 1`,
      parcelCode,
    );
    const row = rows[0];
    return row ? this.toRecord(row) : null;
  }

  async create(tx: unknown, record: PlotRecord): Promise<PlotRecord> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO plot_records
       (parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, zone_code, plot_type, plot_status, current_crop, owner_name, owner_phone, remark, geom, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)`,
      record.parcelId,
      record.parcelCode,
      record.parcelName,
      record.tenantId,
      record.farmId,
      record.areaMu,
      record.soilType ?? null,
      record.zoneCode ?? null,
      record.plotType ?? null,
      record.plotStatus ?? null,
      record.currentCrop ?? null,
      record.ownerName ?? null,
      record.ownerPhone ?? null,
      record.remark ?? null,
      JSON.stringify(record.geom),
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  /**
   * 按 patch 里实际出现的字段动态拼 SET 子句：undefined 不改、null 清空。
   * 字段从 5 个涨到 11 个后，固定占位符写法既要一堆 CASE WHEN 布尔开关，
   * 又容易漏改某一位，这里改成循环拼参数，列名到行键的对应关系一次声明。
   */
  async update(tx: unknown, parcelCode: string, patch: PlotPatch): Promise<PlotRecord | null> {
    const executor = this.executor(tx);
    const rows = await executor.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${PLOT_COLUMNS}
       FROM plot_records WHERE parcel_code = $1 AND deleted_at IS NULL LIMIT 1`,
      parcelCode,
    );
    if (!rows[0]) return null;
    // rowValue 用于回传给 toRecord：geom 的参数是 JSON 字符串，返回值要保留对象
    const assignments: Array<{ column: string; rowKey: string; value: unknown; rowValue?: unknown; cast?: string }> = [
      { column: "parcel_name", rowKey: "parcel_name", value: patch.parcelName },
      { column: "area_mu", rowKey: "area_mu", value: patch.areaMu },
      { column: "soil_type", rowKey: "soil_type", value: patch.soilType },
      { column: "zone_code", rowKey: "zone_code", value: patch.zoneCode },
      { column: "plot_type", rowKey: "plot_type", value: patch.plotType },
      { column: "plot_status", rowKey: "plot_status", value: patch.plotStatus },
      { column: "current_crop", rowKey: "current_crop", value: patch.currentCrop },
      { column: "owner_name", rowKey: "owner_name", value: patch.ownerName },
      { column: "owner_phone", rowKey: "owner_phone", value: patch.ownerPhone },
      { column: "remark", rowKey: "remark", value: patch.remark },
      { column: "geom", rowKey: "geom", value: patch.geom ? JSON.stringify(patch.geom) : undefined, rowValue: patch.geom, cast: "::jsonb" },
    ];
    const params: unknown[] = [parcelCode];
    const sets: string[] = [];
    const next: Record<string, unknown> = { ...rows[0] };
    for (const item of assignments) {
      if (item.value === undefined) continue;
      params.push(item.value);
      sets.push(`${item.column} = $${params.length}${item.cast ?? ""}`);
      next[item.rowKey] = item.rowValue ?? item.value;
    }
    params.push(patch.updatedAt);
    sets.push(`updated_at = $${params.length}`);
    next.updated_at = patch.updatedAt;
    await executor.$executeRawUnsafe(
      `UPDATE plot_records SET ${sets.join(", ")} WHERE parcel_code = $1 AND deleted_at IS NULL`,
      ...params,
    );
    return this.toRecord(next);
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
      `SELECT ${PLOT_COLUMNS}
       FROM plot_records WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      tenantId,
    );
    return rows.map((row) => this.toRecord(row));
  }
}
