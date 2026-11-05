import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/** 处方状态：RECOMMENDED 已生成建议，NO_ACTION 评估后无需作业 */
export type PrescriptionStatus = "RECOMMENDED" | "NO_ACTION";

/** 处方明细，对齐契约中的 PrescriptionItem，materialCode 取自农资字典 */
export interface PrescriptionItem {
  gridCode?: string;
  materialCode: string;
  /** 用量，单位随 materialCode */
  dosage: number;
  windowStart: string;
  windowEnd: string;
}

/** 处方记录：保留输入数据快照与命中规则，满足决策留痕 */
export interface PrescriptionRecord {
  id: string;
  plotCode: string;
  plotName: string;
  status: PrescriptionStatus;
  soilMoisture?: number;
  rainProbability?: number;
  growthStage: string;
  inputs: Record<string, unknown>;
  matchedRules: Array<{ id: string; name: string; expression: string; action: unknown }>;
  actions: PrescriptionItem[];
  generatedAt: string;
  issuedAt?: string;
}

/** 写入入参 */
export interface CreatePrescriptionInput {
  id: string;
  plotCode: string;
  plotName: string;
  status: PrescriptionStatus;
  soilMoisture?: number;
  rainProbability?: number;
  growthStage: string;
  inputs: Record<string, unknown>;
  matchedRules: Array<{ id: string; name: string; expression: string; action: unknown }>;
  actions: PrescriptionItem[];
  generatedAt: string;
}

/** 处方历史查询条件 */
export interface PrescriptionQuery {
  plotCode?: string;
  status?: PrescriptionStatus;
  limit?: number;
}

export interface PrescriptionRepository {
  create(tx: unknown, input: CreatePrescriptionInput): Promise<PrescriptionRecord>;
  listByPlot(query: PrescriptionQuery): Promise<PrescriptionRecord[]>;
  findById(id: string): Promise<PrescriptionRecord | null>;
}

function nullable(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : value;
}

function toRecord(row: Record<string, unknown>): PrescriptionRecord {
  const soilMoisture = row.soil_moisture === null || row.soil_moisture === undefined ? undefined : Number(row.soil_moisture);
  const rainProbability = row.rain_probability === null || row.rain_probability === undefined ? undefined : Number(row.rain_probability);
  const record: PrescriptionRecord = {
    id: String(row.id),
    plotCode: String(row.plot_code),
    plotName: String(row.plot_name),
    status: row.status === "NO_ACTION" ? "NO_ACTION" : "RECOMMENDED",
    growthStage: String(row.growth_stage),
    inputs: (row.inputs_json ?? {}) as Record<string, unknown>,
    matchedRules: (row.matched_rules_json ?? []) as PrescriptionRecord["matchedRules"],
    actions: (row.actions_json ?? []) as PrescriptionItem[],
    generatedAt: toIsoTimestamp(row.generated_at),
  };
  if (soilMoisture !== undefined) record.soilMoisture = soilMoisture;
  if (rainProbability !== undefined) record.rainProbability = rainProbability;
  if (row.issued_at !== null && row.issued_at !== undefined) record.issuedAt = toIsoTimestamp(row.issued_at);
  return record;
}

/** PostgreSQL 实现，决策留痕数据写入 decision_prescriptions */
export class SqlPrescriptionRepository implements PrescriptionRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(tx: unknown, input: CreatePrescriptionInput): Promise<PrescriptionRecord> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO decision_prescriptions
       (id, plot_code, plot_name, status, soil_moisture, rain_probability, growth_stage,
        inputs_json, matched_rules_json, actions_json, generated_at, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)`,
      input.id,
      input.plotCode,
      input.plotName,
      input.status,
      nullable(input.soilMoisture),
      nullable(input.rainProbability),
      input.growthStage,
      JSON.stringify(input.inputs),
      JSON.stringify(input.matchedRules),
      JSON.stringify(input.actions),
      input.generatedAt,
      input.actions.length > 0 ? input.generatedAt : null,
    );
    return {
      ...input,
      ...(input.soilMoisture !== undefined ? { soilMoisture: input.soilMoisture } : {}),
      ...(input.rainProbability !== undefined ? { rainProbability: input.rainProbability } : {}),
      ...(input.actions.length > 0 ? { issuedAt: input.generatedAt } : {}),
    };
  }

  async listByPlot(query: PrescriptionQuery): Promise<PrescriptionRecord[]> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.plotCode !== undefined && query.plotCode !== "") {
      values.push(query.plotCode);
      conditions.push(`plot_code = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, plot_code, plot_name, status, soil_moisture, rain_probability, growth_stage,
              inputs_json, matched_rules_json, actions_json, generated_at, issued_at
       FROM decision_prescriptions ${where}
       ORDER BY generated_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toRecord);
  }

  async findById(id: string): Promise<PrescriptionRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, plot_code, plot_name, status, soil_moisture, rain_probability, growth_stage,
              inputs_json, matched_rules_json, actions_json, generated_at, issued_at
       FROM decision_prescriptions WHERE id = $1 LIMIT 1`,
      id,
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }
}

/** 内存实现：本地模式与测试使用 */
export class InMemoryPrescriptionRepository implements PrescriptionRepository {
  private readonly rows: PrescriptionRecord[] = [];

  constructor(records: PrescriptionRecord[] = []) {
    this.rows.push(...records);
  }

  async create(_tx: unknown, input: CreatePrescriptionInput): Promise<PrescriptionRecord> {
    const record = await Promise.resolve({
      ...input,
      ...(input.soilMoisture !== undefined ? { soilMoisture: input.soilMoisture } : {}),
      ...(input.rainProbability !== undefined ? { rainProbability: input.rainProbability } : {}),
      ...(input.actions.length > 0 ? { issuedAt: input.generatedAt } : {}),
    });
    this.rows.unshift(record);
    return record;
  }

  async listByPlot(query: PrescriptionQuery): Promise<PrescriptionRecord[]> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    return this.rows
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .filter((row) => (query.status ? row.status === query.status : true))
      .slice(0, limit);
  }

  async findById(id: string): Promise<PrescriptionRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  all(): PrescriptionRecord[] {
    return [...this.rows];
  }
}

/** 生成处方标识：ULID，按时间有序便于排序 */
export function newPrescriptionId(): string {
  return ulid();
}
