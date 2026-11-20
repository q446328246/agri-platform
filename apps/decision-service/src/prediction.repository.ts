import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/** 预测指标：墒情趋势、虫害风险、产量估算，与契约 PredictionMetric 同源 */
export type PredictionMetric = "SOIL_MOISTURE" | "PEST_RISK" | "YIELD";

/** 预测等级：正常、预警、严重、数据不足（无依据时不编预测值） */
export type PredictionLevel = "NORMAL" | "WARNING" | "CRITICAL" | "INSUFFICIENT_DATA";

export const PREDICTION_METRICS: PredictionMetric[] = ["SOIL_MOISTURE", "PEST_RISK", "YIELD"];

export const PREDICTION_LEVELS: PredictionLevel[] = ["NORMAL", "WARNING", "CRITICAL", "INSUFFICIENT_DATA"];

/** 预测记录：一次对某地块某指标在某一预测时点的前瞻结果 */
export interface PredictionRecord {
  id: string;
  tenantId: string;
  plotCode: string;
  seasonId: string;
  metric: PredictionMetric;
  /** 预测时点（= 预测起点 + 时距），ISO 8601 UTC */
  predictedAt: string;
  horizonHours: number;
  predictedValue: number;
  level: PredictionLevel;
  unit: string;
  basis: string;
  inputs: Record<string, unknown>;
  threshold?: number;
  direction?: "above" | "below";
  createdAt: string;
}

/** 写入入参：id 与创建时间由仓储生成，调用方不传 */
export interface CreatePredictionInput {
  tenantId: string;
  plotCode: string;
  seasonId: string;
  metric: PredictionMetric;
  predictedAt: string;
  horizonHours: number;
  predictedValue: number;
  level: PredictionLevel;
  unit: string;
  basis: string;
  inputs: Record<string, unknown>;
  threshold?: number;
  direction?: "above" | "below";
}

/** 预测查询条件 */
export interface PredictionQuery {
  plotCode?: string;
  metric?: PredictionMetric;
  level?: PredictionLevel;
  from?: string;
  to?: string;
  limit?: number;
}

export interface PredictionRepository {
  /**
   * 幂等保存：同（租户, 地块, 指标, 预测时点）只保留一条。
   * 返回是否真正新增，扫描器据此判断是否需要发布预警事件。
   */
  save(tx: Tx | undefined, input: CreatePredictionInput): Promise<{ record: PredictionRecord; inserted: boolean }>;
  list(query: PredictionQuery): Promise<PredictionRecord[]>;
  findLatest(plotCode: string, metric: PredictionMetric): Promise<PredictionRecord | null>;
}

function dedupeKey(input: Pick<CreatePredictionInput, "tenantId" | "plotCode" | "metric" | "predictedAt">): string {
  return `${input.tenantId}|${input.plotCode}|${input.metric}|${input.predictedAt}`;
}

function toRecord(row: Record<string, unknown>): PredictionRecord {
  const threshold = row.threshold === null || row.threshold === undefined ? undefined : Number(row.threshold);
  const direction = row.direction === null || row.direction === undefined ? undefined : String(row.direction);
  const record: PredictionRecord = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    plotCode: String(row.plot_code),
    seasonId: String(row.season_id),
    metric: String(row.metric) as PredictionMetric,
    predictedAt: toIsoTimestamp(row.predicted_at),
    horizonHours: Number(row.horizon_hours),
    predictedValue: Number(row.predicted_value),
    level: String(row.level) as PredictionLevel,
    unit: String(row.unit),
    basis: String(row.basis),
    inputs: (row.inputs ?? {}) as Record<string, unknown>,
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (threshold !== undefined) record.threshold = threshold;
  if (direction !== undefined) record.direction = direction === "above" ? "above" : "below";
  return record;
}

/** 内存实现：仅供测试与降级路径，构造默认空库，扫描器不注入种子 */
export class InMemoryPredictionRepository implements PredictionRepository {
  private readonly rows = new Map<string, PredictionRecord>();

  async save(_tx: Tx | undefined, input: CreatePredictionInput): Promise<{ record: PredictionRecord; inserted: boolean }> {
    const key = dedupeKey(input);
    const existing = this.rows.get(key);
    if (existing) return { record: structuredClone(existing), inserted: false };
    const record: PredictionRecord = {
      id: ulid(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.rows.set(key, structuredClone(record));
    return { record, inserted: true };
  }

  async list(query: PredictionQuery): Promise<PredictionRecord[]> {
    const rows = [...this.rows.values()]
      .filter((row) => (query.plotCode === undefined || row.plotCode === query.plotCode)
        && (query.metric === undefined || row.metric === query.metric)
        && (query.level === undefined || row.level === query.level)
        && (query.from === undefined || row.predictedAt >= query.from)
        && (query.to === undefined || row.predictedAt <= query.to))
      .sort((a, b) => (a.predictedAt < b.predictedAt ? 1 : -1));
    return rows.slice(0, query.limit ?? 100).map((row) => structuredClone(row));
  }

  async findLatest(plotCode: string, metric: PredictionMetric): Promise<PredictionRecord | null> {
    const hits = [...this.rows.values()].filter((row) => row.plotCode === plotCode && row.metric === metric);
    if (hits.length === 0) return null;
    hits.sort((a, b) => (a.predictedAt < b.predictedAt ? 1 : -1));
    return structuredClone(hits[0]!);
  }
}

/** 查询执行器：客户端与事务共用 $queryRawUnsafe 这一最小能力面 */
type QueryExecutor = Pick<PrismaClientLike, "$queryRawUnsafe">;

/** SQL 实现：迁移 063 的 decision_predictions，唯一索引保证幂等 */
export class SqlPredictionRepository implements PredictionRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async save(tx: Tx | undefined, input: CreatePredictionInput): Promise<{ record: PredictionRecord; inserted: boolean }> {
    const executor: QueryExecutor = tx ?? this.client;
    const row = await this.insert(executor, input);
    if (row !== undefined) return { record: toRecord(row), inserted: true };
    // 冲突时返回既有行，inserted=false：扫描器据此不重复发布预警
    const existing = await this.findByKey(executor, input);
    return { record: toRecord(existing!), inserted: false };
  }

  private async insert(executor: QueryExecutor, input: CreatePredictionInput): Promise<Record<string, unknown> | undefined> {
    const columns = [
      "id", "tenant_id", "plot_code", "season_id", "metric", "predicted_at", "horizon_hours",
      "predicted_value", "level", "unit", "basis", "inputs",
    ];
    const values = [
      ulid(), String(input.tenantId), String(input.plotCode), String(input.seasonId), String(input.metric),
      new Date(input.predictedAt), Number(input.horizonHours), Number(input.predictedValue), String(input.level),
      String(input.unit), String(input.basis), JSON.stringify(input.inputs ?? {}),
    ];
    // 可选列用条件拼接：不传就不出现在 INSERT 里
    if (input.threshold !== undefined) { columns.push("threshold"); values.push(input.threshold); }
    if (input.direction !== undefined) { columns.push("direction"); values.push(input.direction); }
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await executor.$queryRawUnsafe(
      `INSERT INTO decision_predictions (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (tenant_id, plot_code, metric, predicted_at) DO NOTHING RETURNING *`,
      ...values,
    ) as Record<string, unknown>[];
    return rows[0];
  }

  private async findByKey(executor: QueryExecutor, input: CreatePredictionInput): Promise<Record<string, unknown> | undefined> {
    const rows = await executor.$queryRawUnsafe(
      `SELECT * FROM decision_predictions
       WHERE tenant_id = $1 AND plot_code = $2 AND metric = $3 AND predicted_at = $4
       LIMIT 1`,
      String(input.tenantId), String(input.plotCode), String(input.metric), new Date(input.predictedAt),
    ) as Record<string, unknown>[];
    return rows[0];
  }

  async list(query: PredictionQuery): Promise<PredictionRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (query.plotCode !== undefined) add("plot_code = ?", query.plotCode);
    if (query.metric !== undefined) add("metric = ?", query.metric);
    if (query.level !== undefined) add("level = ?", query.level);
    if (query.from !== undefined) add("predicted_at >= ?", new Date(query.from));
    if (query.to !== undefined) add("predicted_at <= ?", new Date(query.to));
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(200, Math.max(1, query.limit ?? 100));
    params.push(limit);
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM decision_predictions${where} ORDER BY predicted_at DESC, created_at DESC LIMIT $${params.length}`,
      ...params,
    ) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  async findLatest(plotCode: string, metric: PredictionMetric): Promise<PredictionRecord | null> {
    const rows = await this.client.$queryRawUnsafe(
      `SELECT * FROM decision_predictions WHERE plot_code = $1 AND metric = $2
       ORDER BY predicted_at DESC LIMIT 1`,
      plotCode, metric,
    ) as Record<string, unknown>[];
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
