import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/**
 * 苗情生育期档案（开发方案 6.2）。
 *
 * 每个地块按生育期（出苗/分蘖/拔节/抽穗/灌浆/成熟…）记录计划节点与实际节点，
 * 前端时间轴据此对比「计划 vs 实际」判断提前或滞后。stage 存编码，中文名与顺序由前端目录给出。
 * 同一地块同一生育期只保留一条档案（uq_plot_growth_stages_plot_stage），登记即幂等更新。
 * 与虫情记录一致不带 tenant_id：地块编码已隔离归属，遥测库单租户部署。
 */

/** 生育期档案记录 */
export interface GrowthStage {
  id: string;
  plotCode: string;
  stage: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
  actualStartAt?: string;
  actualEndAt?: string;
  note: string;
  updatedAt: string;
}

/** 登记/更新生育期入参 */
export interface GrowthStageInput {
  plotCode: string;
  stage: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
  actualStartAt?: string;
  actualEndAt?: string;
  note?: string;
}

export interface GrowthStageRepository {
  list(plotCode?: string): Promise<GrowthStage[]>;
  /** 按 (地块, 生育期) 幂等写入：存在则更新计划/实际节点与备注 */
  save(input: GrowthStageInput): Promise<GrowthStage>;
  remove(id: string): Promise<boolean>;
}

function toGrowthStage(row: Record<string, unknown>): GrowthStage {
  const stage: GrowthStage = {
    id: String(row.id),
    plotCode: String(row.plot_code ?? ""),
    stage: String(row.stage),
    note: String(row.note ?? ""),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  const plannedStart = toIsoTimestamp(row.planned_start_at);
  const plannedEnd = toIsoTimestamp(row.planned_end_at);
  const actualStart = toIsoTimestamp(row.actual_start_at);
  const actualEnd = toIsoTimestamp(row.actual_end_at);
  if (plannedStart) stage.plannedStartAt = plannedStart;
  if (plannedEnd) stage.plannedEndAt = plannedEnd;
  if (actualStart) stage.actualStartAt = actualStart;
  if (actualEnd) stage.actualEndAt = actualEnd;
  return stage;
}

/** PostgreSQL 实现，表结构由迁移 021 管理 */
export class SqlGrowthStageRepository implements GrowthStageRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async list(plotCode?: string): Promise<GrowthStage[]> {
    const rows = plotCode
      ? await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT id, plot_code, stage, planned_start_at, planned_end_at, actual_start_at, actual_end_at, note, updated_at
           FROM plot_growth_stages WHERE plot_code = $1 ORDER BY planned_start_at NULLS LAST, stage`,
          plotCode,
        )
      : await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT id, plot_code, stage, planned_start_at, planned_end_at, actual_start_at, actual_end_at, note, updated_at
           FROM plot_growth_stages ORDER BY plot_code, planned_start_at NULLS LAST, stage`,
        );
    return rows.map(toGrowthStage);
  }

  async save(input: GrowthStageInput): Promise<GrowthStage> {
    const id = ulid();
    const updatedAt = new Date().toISOString();
    await this.client.$executeRawUnsafe(
      `INSERT INTO plot_growth_stages (id, plot_code, stage, planned_start_at, planned_end_at, actual_start_at, actual_end_at, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (plot_code, stage) DO UPDATE SET planned_start_at = EXCLUDED.planned_start_at, planned_end_at = EXCLUDED.planned_end_at,
         actual_start_at = EXCLUDED.actual_start_at, actual_end_at = EXCLUDED.actual_end_at, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
      id,
      input.plotCode,
      input.stage,
      input.plannedStartAt ?? null,
      input.plannedEndAt ?? null,
      input.actualStartAt ?? null,
      input.actualEndAt ?? null,
      input.note ?? "",
      updatedAt,
    );
    // 幂等写入后按唯一键回读，拿到实际生效的 id（新建或既有）
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, plot_code, stage, planned_start_at, planned_end_at, actual_start_at, actual_end_at, note, updated_at
       FROM plot_growth_stages WHERE plot_code = $1 AND stage = $2 LIMIT 1`,
      input.plotCode,
      input.stage,
    );
    const row = rows[0];
    return row ? toGrowthStage(row) : { id, plotCode: input.plotCode, stage: input.stage, note: input.note ?? "", updatedAt };
  }

  async remove(id: string): Promise<boolean> {
    return (await this.client.$executeRawUnsafe(`DELETE FROM plot_growth_stages WHERE id = $1`, id)) > 0;
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryGrowthStageRepository implements GrowthStageRepository {
  private readonly rows = new Map<string, GrowthStage>();

  constructor(seed: GrowthStage[] = []) {
    for (const stage of seed) this.rows.set(`${stage.plotCode}::${stage.stage}`, stage);
  }

  async list(plotCode?: string): Promise<GrowthStage[]> {
    return [...this.rows.values()]
      .filter((row) => (plotCode ? row.plotCode === plotCode : true))
      .sort((a, b) => a.plotCode.localeCompare(b.plotCode) || (a.plannedStartAt ?? "~").localeCompare(b.plannedStartAt ?? "~") || a.stage.localeCompare(b.stage));
  }

  async save(input: GrowthStageInput): Promise<GrowthStage> {
    const key = `${input.plotCode}::${input.stage}`;
    const existing = this.rows.get(key);
    const stage: GrowthStage = {
      id: existing?.id ?? ulid(),
      plotCode: input.plotCode,
      stage: input.stage,
      note: input.note ?? "",
      updatedAt: new Date().toISOString(),
    };
    if (input.plannedStartAt) stage.plannedStartAt = input.plannedStartAt;
    if (input.plannedEndAt) stage.plannedEndAt = input.plannedEndAt;
    if (input.actualStartAt) stage.actualStartAt = input.actualStartAt;
    if (input.actualEndAt) stage.actualEndAt = input.actualEndAt;
    this.rows.set(key, stage);
    return stage;
  }

  async remove(id: string): Promise<boolean> {
    for (const [key, row] of this.rows) {
      if (row.id === id) {
        this.rows.delete(key);
        return true;
      }
    }
    return false;
  }
}