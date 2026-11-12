import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 种植季/茬口档案仓储。
 *
 * 与「苗情生育期」（同一季作物内部的时间轴）不同，这里记录的是地块在某一季种了什么、
 * 什么时候下地、什么时候收，用来还原一块地多年来的轮作（茬口）序列，
 * 为倒茬、连作障碍判断提供决策依据——只是排档，不替农户决定种什么。
 *
 * 产量、日期均为农户据实回填的手填值，系统不做估算；空串表示尚未确定（如「计划中」还没定栽期）。
 */

/** 种植季状态：计划中 / 种植中 / 已采收 */
export type CropSeasonStatus = "planned" | "growing" | "harvested";

export const CROP_SEASON_STATUSES: CropSeasonStatus[] = ["planned", "growing", "harvested"];

/** 种植季记录 */
export interface CropSeason {
  id: string;
  seasonCode: string;
  /** 所属地块编码（plots.parcel_code），纯文本引用，与片区/管线一致不建外键 */
  plotCode: string;
  /** 作物名称，自由文本 */
  crop: string;
  /** 品种，可选 */
  variety: string;
  /** 种植年份，用于跨年度轮作排序 */
  seasonYear: number;
  /** 第几茬（同一年多季时的次序），默认 1 */
  seasonIndex: number;
  /** 栽插/播种日期，YYYY-MM-DD，空串表示未定 */
  plantDate: string;
  /** 采收日期，YYYY-MM-DD，空串表示尚未采收 */
  harvestDate: string;
  status: CropSeasonStatus;
  /** 产量（公斤），null 表示未记录 */
  yieldKg: number | null;
  note: string;
  tenantId: string;
  createdAt: string;
  deletedAt?: string;
}

/** 新增入参 */
export interface CropSeasonInput {
  seasonCode?: string;
  plotCode: string;
  crop: string;
  variety?: string;
  seasonYear: number;
  seasonIndex?: number;
  plantDate?: string;
  harvestDate?: string;
  status?: CropSeasonStatus;
  yieldKg?: number | null;
  note?: string;
}

/** 局部更新入参：传 null 清空可空字段，传 undefined 不改动 */
export interface CropSeasonPatch {
  plotCode?: string;
  crop?: string;
  variety?: string;
  seasonYear?: number;
  seasonIndex?: number;
  plantDate?: string;
  harvestDate?: string;
  status?: CropSeasonStatus;
  yieldKg?: number | null;
  note?: string;
}

export interface CropSeasonRepository {
  listByTenant(tenantId: string): Promise<CropSeason[]>;
  /** 按地块返回轮作序列，茬口正序（年份→茬次→栽期→建档时间） */
  listByPlot(tenantId: string, plotCode: string): Promise<CropSeason[]>;
  findByCode(seasonCode: string): Promise<CropSeason | null>;
  create(tx: unknown, record: CropSeason): Promise<CropSeason>;
  update(tx: unknown, seasonCode: string, patch: CropSeasonPatch): Promise<CropSeason | null>;
  remove(tx: unknown, seasonCode: string, deletedAt: string): Promise<boolean>;
}

/** 轮作正序比较：先年份、再同年茬次、再栽期，缺日期沉底，最后按建档时间兜底 */
export function compareRotation(a: CropSeason, b: CropSeason): number {
  if (a.seasonYear !== b.seasonYear) return a.seasonYear - b.seasonYear;
  if (a.seasonIndex !== b.seasonIndex) return a.seasonIndex - b.seasonIndex;
  if (a.plantDate !== b.plantDate) {
    if (a.plantDate === "") return 1;
    if (b.plantDate === "") return -1;
    return a.plantDate.localeCompare(b.plantDate);
  }
  return a.createdAt.localeCompare(b.createdAt);
}

/** 日期合法性：空串或 YYYY-MM-DD（按日历校验，挡住 2026-02-30 之类） */
export function isValidFarmDate(value: string): boolean {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

const SEASON_COLUMNS =
  "id, season_code, plot_code, crop, variety, season_year, season_index, plant_date, harvest_date, status, yield_kg, note, tenant_id, created_at, deleted_at";

function toSeason(row: Record<string, unknown>): CropSeason {
  const record: CropSeason = {
    id: String(row.id),
    seasonCode: String(row.season_code),
    plotCode: String(row.plot_code),
    crop: String(row.crop),
    variety: String(row.variety ?? ""),
    seasonYear: Number(row.season_year ?? 0),
    seasonIndex: Number(row.season_index ?? 1),
    plantDate: String(row.plant_date ?? ""),
    harvestDate: String(row.harvest_date ?? ""),
    status: String(row.status ?? "planned") as CropSeasonStatus,
    yieldKg: row.yield_kg === null || row.yield_kg === undefined ? null : Number(row.yield_kg),
    note: String(row.note ?? ""),
    tenantId: String(row.tenant_id ?? "tenant-demo"),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.deleted_at !== null && row.deleted_at !== undefined) record.deletedAt = toIsoTimestamp(row.deleted_at);
  return record;
}

/** PostgreSQL 实现，表结构由迁移 026 管理 */
export class SqlCropSeasonRepository implements CropSeasonRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async listByTenant(tenantId: string): Promise<CropSeason[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SEASON_COLUMNS} FROM crop_seasons WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY season_year DESC, season_index DESC, created_at DESC`,
      tenantId,
    );
    return rows.map(toSeason);
  }

  async listByPlot(tenantId: string, plotCode: string): Promise<CropSeason[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SEASON_COLUMNS} FROM crop_seasons WHERE tenant_id = $1 AND plot_code = $2 AND deleted_at IS NULL`,
      tenantId,
      plotCode,
    );
    return rows.map(toSeason).sort(compareRotation);
  }

  async findByCode(seasonCode: string): Promise<CropSeason | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SEASON_COLUMNS} FROM crop_seasons WHERE season_code = $1 AND deleted_at IS NULL LIMIT 1`,
      seasonCode,
    );
    const row = rows[0];
    return row ? toSeason(row) : null;
  }

  async create(tx: unknown, record: CropSeason): Promise<CropSeason> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO crop_seasons (id, season_code, plot_code, crop, variety, season_year, season_index, plant_date, harvest_date, status, yield_kg, note, tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      record.id,
      record.seasonCode,
      record.plotCode,
      record.crop,
      record.variety,
      record.seasonYear,
      record.seasonIndex,
      record.plantDate,
      record.harvestDate,
      record.status,
      record.yieldKg,
      record.note,
      record.tenantId,
      record.createdAt,
    );
    return record;
  }

  async update(tx: unknown, seasonCode: string, patch: CropSeasonPatch): Promise<CropSeason | null> {
    const executor = this.executor(tx);
    const rows = await executor.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SEASON_COLUMNS} FROM crop_seasons WHERE season_code = $1 AND deleted_at IS NULL LIMIT 1`,
      seasonCode,
    );
    const row = rows[0];
    if (!row) return null;
    const next = toSeason(row);
    const sets: string[] = [];
    const params: unknown[] = [seasonCode];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.plotCode !== undefined) { add("plot_code", patch.plotCode); next.plotCode = patch.plotCode; }
    if (patch.crop !== undefined) { add("crop", patch.crop); next.crop = patch.crop; }
    if (patch.variety !== undefined) { add("variety", patch.variety); next.variety = patch.variety; }
    if (patch.seasonYear !== undefined) { add("season_year", patch.seasonYear); next.seasonYear = patch.seasonYear; }
    if (patch.seasonIndex !== undefined) { add("season_index", patch.seasonIndex); next.seasonIndex = patch.seasonIndex; }
    if (patch.plantDate !== undefined) { add("plant_date", patch.plantDate); next.plantDate = patch.plantDate; }
    if (patch.harvestDate !== undefined) { add("harvest_date", patch.harvestDate); next.harvestDate = patch.harvestDate; }
    if (patch.status !== undefined) { add("status", patch.status); next.status = patch.status; }
    if (patch.yieldKg !== undefined) { add("yield_kg", patch.yieldKg); next.yieldKg = patch.yieldKg; }
    if (patch.note !== undefined) { add("note", patch.note); next.note = patch.note; }
    if (sets.length > 0) {
      await executor.$executeRawUnsafe(
        `UPDATE crop_seasons SET ${sets.join(", ")} WHERE season_code = $1 AND deleted_at IS NULL`,
        ...params,
      );
    }
    return next;
  }

  async remove(tx: unknown, seasonCode: string, deletedAt: string): Promise<boolean> {
    return (await this.executor(tx).$executeRawUnsafe(
      `UPDATE crop_seasons SET deleted_at = $2 WHERE season_code = $1 AND deleted_at IS NULL`,
      seasonCode,
      deletedAt,
    )) > 0;
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryCropSeasonRepository implements CropSeasonRepository {
  private readonly rows: CropSeason[] = [];

  constructor(seed: CropSeason[] = []) {
    this.rows.push(...seed.map((row) => structuredClone(row)));
  }

  async listByTenant(tenantId: string): Promise<CropSeason[]> {
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.deletedAt === undefined)
      .sort((a, b) => b.seasonYear - a.seasonYear || b.seasonIndex - a.seasonIndex || b.createdAt.localeCompare(a.createdAt))
      .map((row) => structuredClone(row));
  }

  async listByPlot(tenantId: string, plotCode: string): Promise<CropSeason[]> {
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.plotCode === plotCode && row.deletedAt === undefined)
      .sort(compareRotation)
      .map((row) => structuredClone(row));
  }

  async findByCode(seasonCode: string): Promise<CropSeason | null> {
    const row = this.rows.find((item) => item.seasonCode === seasonCode && item.deletedAt === undefined);
    return row ? structuredClone(row) : null;
  }

  async create(_tx: unknown, record: CropSeason): Promise<CropSeason> {
    const row = structuredClone(record);
    this.rows.push(row);
    return structuredClone(row);
  }

  async update(_tx: unknown, seasonCode: string, patch: CropSeasonPatch): Promise<CropSeason | null> {
    const row = this.rows.find((item) => item.seasonCode === seasonCode && item.deletedAt === undefined);
    if (!row) return null;
    if (patch.plotCode !== undefined) row.plotCode = patch.plotCode;
    if (patch.crop !== undefined) row.crop = patch.crop;
    if (patch.variety !== undefined) row.variety = patch.variety;
    if (patch.seasonYear !== undefined) row.seasonYear = patch.seasonYear;
    if (patch.seasonIndex !== undefined) row.seasonIndex = patch.seasonIndex;
    if (patch.plantDate !== undefined) row.plantDate = patch.plantDate;
    if (patch.harvestDate !== undefined) row.harvestDate = patch.harvestDate;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.yieldKg !== undefined) row.yieldKg = patch.yieldKg;
    if (patch.note !== undefined) row.note = patch.note;
    return structuredClone(row);
  }

  async remove(_tx: unknown, seasonCode: string, deletedAt: string): Promise<boolean> {
    const row = this.rows.find((item) => item.seasonCode === seasonCode && item.deletedAt === undefined);
    if (!row) return false;
    row.deletedAt = deletedAt;
    return true;
  }
}
