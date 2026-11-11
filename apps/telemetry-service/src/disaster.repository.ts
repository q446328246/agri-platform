import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/**
 * 灾情档案（开发方案 6.4）。
 *
 * 覆盖干旱/洪涝/低温冻害/大风倒伏/冰雹/病虫害六类田间灾情，记录「上报 → 核查 → 处置 → 归档」的处置留痕：
 *   affected_area_mu 由上报人按田块实测填报，与地块边界面积是两套口径，不做互相覆盖；
 *   image_file_ids 只保存文件服务返回的影像标识引用，影像本身不进本库；
 *   状态沿 REPORTED→ASSESSED→HANDLED→ARCHIVED 单向推进，进入 ASSESSED 及以后补处置人与处置时间。
 * 卫星遥感定损与保险理赔对接依赖外部系统，本表只做人工上报与处置记录，不伪造定损回执。
 * 单租户遥测库口径，不带 tenant_id。
 */

/** 灾种编码，取自灾情字典（开发方案 6.4） */
export const DISASTER_TYPES = ["drought", "flood", "frost", "wind", "hail", "pest"] as const;
export type DisasterType = (typeof DISASTER_TYPES)[number];

/** 处置状态：已上报 / 已核查 / 已处置 / 已归档 */
export const DISASTER_STATUSES = ["REPORTED", "ASSESSED", "HANDLED", "ARCHIVED"] as const;
export type DisasterStatus = (typeof DISASTER_STATUSES)[number];

/** 灾害分级 1 轻度、2 中度、3 重度、4 特别重大 */
export type DisasterSeverity = 1 | 2 | 3 | 4;

/** 状态单向推进顺序表：用于拒绝倒退 */
const STATUS_ORDER: Record<DisasterStatus, number> = { REPORTED: 0, ASSESSED: 1, HANDLED: 2, ARCHIVED: 3 };

export interface DisasterRecord {
  id: string;
  disasterType: DisasterType;
  plotCode: string;
  /** 受灾面积（亩），上报人按田块实测填报 */
  affectedAreaMu: number;
  severity: DisasterSeverity;
  occurredAt: string;
  /** 处置建议 */
  suggestion: string;
  status: DisasterStatus;
  /** 损失评估说明，核查/处置阶段补录 */
  lossAssessment: string;
  /** 影像文件标识列表，指向文件服务 */
  imageFileIds: string[];
  reportedBy: string;
  handledBy: string;
  handledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDisasterInput {
  disasterType: DisasterType;
  plotCode: string;
  affectedAreaMu: number;
  severity: DisasterSeverity;
  occurredAt: string;
  suggestion?: string;
  imageFileIds?: string[];
  reportedBy?: string;
}

/** 补充入参：状态只允许向前推进，其余按提供值覆盖 */
export interface SupplementDisasterInput {
  status?: DisasterStatus;
  suggestion?: string;
  lossAssessment?: string;
  affectedAreaMu?: number;
  imageFileIds?: string[];
  handledBy?: string;
}

export interface DisasterFilter {
  plotCode?: string;
  disasterType?: string;
  status?: string;
  limit?: number;
}

export interface DisasterStats {
  total: number;
  open: number;
  affectedAreaMu: number;
  byType: Array<{ disasterType: DisasterType; count: number; affectedAreaMu: number }>;
  bySeverity: Array<{ severity: DisasterSeverity; count: number }>;
}

export interface DisasterRepository {
  create(tx: unknown, input: CreateDisasterInput): Promise<DisasterRecord>;
  list(filter?: DisasterFilter): Promise<DisasterRecord[]>;
  find(id: string): Promise<DisasterRecord | null>;
  /** 补充处置信息并推进状态；状态倒退或记录不存在返回 null */
  supplement(id: string, input: SupplementDisasterInput): Promise<DisasterRecord | null>;
  stats(filter: Pick<DisasterFilter, "plotCode">): Promise<DisasterStats>;
  count(): Promise<number>;
}

function normalizeType(value: unknown): DisasterType {
  return DISASTER_TYPES.includes(value as DisasterType) ? (value as DisasterType) : "drought";
}

function normalizeSeverity(value: unknown): DisasterSeverity {
  const level = Number(value);
  return level === 4 ? 4 : level === 3 ? 3 : level === 2 ? 2 : 1;
}

function normalizeIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function toDisasterRecord(row: Record<string, unknown>): DisasterRecord {
  const record: DisasterRecord = {
    id: String(row.id),
    disasterType: normalizeType(row.disaster_type),
    plotCode: String(row.plot_code ?? ""),
    affectedAreaMu: Number(row.affected_area_mu ?? 0),
    severity: normalizeSeverity(row.severity),
    occurredAt: toIsoTimestamp(row.occurred_at),
    suggestion: String(row.suggestion ?? ""),
    status: (DISASTER_STATUSES.includes(row.status as DisasterStatus) ? row.status : "REPORTED") as DisasterStatus,
    lossAssessment: String(row.loss_assessment ?? ""),
    imageFileIds: normalizeIds(row.image_file_ids),
    reportedBy: String(row.reported_by ?? ""),
    handledBy: String(row.handled_by ?? ""),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  const handledAt = toIsoTimestamp(row.handled_at);
  if (handledAt) record.handledAt = handledAt;
  return record;
}

const SELECT_COLUMNS = `id, disaster_type, plot_code, affected_area_mu, severity, occurred_at, suggestion, status,
  loss_assessment, image_file_ids, reported_by, handled_by, handled_at, created_at, updated_at`;

/** PostgreSQL 实现，表结构由迁移 023 建立 */
export class SqlDisasterRepository implements DisasterRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(tx: unknown, input: CreateDisasterInput): Promise<DisasterRecord> {
    const id = ulid();
    const now = new Date().toISOString();
    const imageFileIds = input.imageFileIds ?? [];
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO telemetry_disasters (id, disaster_type, plot_code, affected_area_mu, severity, occurred_at, suggestion,
         status, loss_assessment, image_file_ids, reported_by, handled_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'REPORTED', '', $8::jsonb, $9, '', $10, $10)`,
      id,
      input.disasterType,
      input.plotCode,
      input.affectedAreaMu,
      input.severity,
      input.occurredAt,
      input.suggestion ?? "",
      JSON.stringify(imageFileIds),
      input.reportedBy ?? "",
      now,
    );
    return {
      id,
      disasterType: input.disasterType,
      plotCode: input.plotCode,
      affectedAreaMu: input.affectedAreaMu,
      severity: input.severity,
      occurredAt: input.occurredAt,
      suggestion: input.suggestion ?? "",
      status: "REPORTED",
      lossAssessment: "",
      imageFileIds,
      reportedBy: input.reportedBy ?? "",
      handledBy: "",
      createdAt: now,
      updatedAt: now,
    };
  }

  async list(filter: DisasterFilter = {}): Promise<DisasterRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.plotCode) { values.push(filter.plotCode); conditions.push(`plot_code = $${values.length}`); }
    if (filter.disasterType) { values.push(filter.disasterType); conditions.push(`disaster_type = $${values.length}`); }
    if (filter.status) { values.push(filter.status); conditions.push(`status = $${values.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    values.push(limit);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SELECT_COLUMNS} FROM telemetry_disasters ${where} ORDER BY occurred_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toDisasterRecord);
  }

  async find(id: string): Promise<DisasterRecord | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${SELECT_COLUMNS} FROM telemetry_disasters WHERE id = $1 LIMIT 1`,
      id,
    );
    const row = rows[0];
    return row ? toDisasterRecord(row) : null;
  }

  async supplement(id: string, input: SupplementDisasterInput): Promise<DisasterRecord | null> {
    const existing = await this.find(id);
    if (!existing) return null;
    if (input.status && STATUS_ORDER[input.status] < STATUS_ORDER[existing.status]) return null;
    const now = new Date().toISOString();
    const advanced = input.status ?? existing.status;
    const touchesHandling = input.status !== undefined && input.status !== "REPORTED";
    const updated: DisasterRecord = {
      ...existing,
      status: advanced,
      suggestion: input.suggestion ?? existing.suggestion,
      lossAssessment: input.lossAssessment ?? existing.lossAssessment,
      affectedAreaMu: input.affectedAreaMu ?? existing.affectedAreaMu,
      imageFileIds: input.imageFileIds ?? existing.imageFileIds,
      handledBy: touchesHandling && input.handledBy !== undefined ? input.handledBy : existing.handledBy,
      updatedAt: now,
    };
    // 一进入核查及以后就记录处置时点，后续再补充也保留首次处置时间
    const handledAt = touchesHandling ? (existing.handledAt ?? now) : existing.handledAt;
    if (handledAt) updated.handledAt = handledAt;
    await this.client.$executeRawUnsafe(
      `UPDATE telemetry_disasters SET status = $2, suggestion = $3, loss_assessment = $4, affected_area_mu = $5,
         image_file_ids = $6::jsonb, handled_by = $7, handled_at = COALESCE($8, handled_at), updated_at = $9 WHERE id = $1`,
      id,
      updated.status,
      updated.suggestion,
      updated.lossAssessment,
      updated.affectedAreaMu,
      JSON.stringify(updated.imageFileIds),
      updated.handledBy,
      handledAt ?? null,
      now,
    );
    return updated;
  }

  async stats(filter: Pick<DisasterFilter, "plotCode">): Promise<DisasterStats> {
    const values: unknown[] = [];
    const where = filter.plotCode ? ((values.push(filter.plotCode), `WHERE plot_code = $${values.length}`)) : "";
    const [totals, byType, bySeverity] = await Promise.all([
      this.client.$queryRawUnsafe<Array<{ total: number; open: number; area: number | null }>>(
        `SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status <> 'ARCHIVED')::int AS open,
           SUM(affected_area_mu) FILTER (WHERE status <> 'ARCHIVED') AS area
         FROM telemetry_disasters ${where}`,
        ...values,
      ),
      this.client.$queryRawUnsafe<Array<{ disaster_type: string; count: number; area: number | null }>>(
        `SELECT disaster_type, COUNT(*)::int AS count, SUM(affected_area_mu) AS area
         FROM telemetry_disasters ${where} GROUP BY disaster_type ORDER BY count DESC`,
        ...values,
      ),
      this.client.$queryRawUnsafe<Array<{ severity: number; count: number }>>(
        `SELECT severity, COUNT(*)::int AS count FROM telemetry_disasters ${where} GROUP BY severity ORDER BY severity`,
        ...values,
      ),
    ]);
    return {
      total: Number(totals[0]?.total ?? 0),
      open: Number(totals[0]?.open ?? 0),
      affectedAreaMu: Number(totals[0]?.area ?? 0),
      byType: byType.map((row) => ({ disasterType: normalizeType(row.disaster_type), count: Number(row.count), affectedAreaMu: Number(row.area ?? 0) })),
      bySeverity: bySeverity.map((row) => ({ severity: normalizeSeverity(row.severity), count: Number(row.count) })),
    };
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(
      `SELECT COUNT(*)::int AS total FROM telemetry_disasters WHERE status <> 'ARCHIVED'`,
    );
    return Number(rows[0]?.total ?? 0);
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryDisasterRepository implements DisasterRepository {
  private readonly rows: DisasterRecord[] = [];

  constructor(seed: DisasterRecord[] = []) {
    this.rows.push(...seed);
  }

  async create(_tx: unknown, input: CreateDisasterInput): Promise<DisasterRecord> {
    const now = new Date().toISOString();
    const record: DisasterRecord = {
      id: ulid(),
      disasterType: input.disasterType,
      plotCode: input.plotCode,
      affectedAreaMu: input.affectedAreaMu,
      severity: input.severity,
      occurredAt: input.occurredAt,
      suggestion: input.suggestion ?? "",
      status: "REPORTED",
      lossAssessment: "",
      imageFileIds: input.imageFileIds ?? [],
      reportedBy: input.reportedBy ?? "",
      handledBy: "",
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(record);
    return record;
  }

  async list(filter: DisasterFilter = {}): Promise<DisasterRecord[]> {
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    return this.rows
      .filter((row) => (filter.plotCode ? row.plotCode === filter.plotCode : true))
      .filter((row) => (filter.disasterType ? row.disasterType === filter.disasterType : true))
      .filter((row) => (filter.status ? row.status === filter.status : true))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  }

  async find(id: string): Promise<DisasterRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async supplement(id: string, input: SupplementDisasterInput): Promise<DisasterRecord | null> {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return null;
    if (input.status && STATUS_ORDER[input.status] < STATUS_ORDER[row.status]) return null;
    const now = new Date().toISOString();
    const touchesHandling = input.status !== undefined && input.status !== "REPORTED";
    row.status = input.status ?? row.status;
    if (input.suggestion !== undefined) row.suggestion = input.suggestion;
    if (input.lossAssessment !== undefined) row.lossAssessment = input.lossAssessment;
    if (input.affectedAreaMu !== undefined) row.affectedAreaMu = input.affectedAreaMu;
    if (input.imageFileIds !== undefined) row.imageFileIds = input.imageFileIds;
    if (touchesHandling && input.handledBy !== undefined) row.handledBy = input.handledBy;
    if (touchesHandling && !row.handledAt) row.handledAt = now;
    row.updatedAt = now;
    return row;
  }

  async stats(filter: Pick<DisasterFilter, "plotCode">): Promise<DisasterStats> {
    const matched = this.rows.filter((row) => (filter.plotCode ? row.plotCode === filter.plotCode : true));
    const open = matched.filter((row) => row.status !== "ARCHIVED");
    const typeMap = new Map<DisasterType, { count: number; area: number }>();
    for (const row of matched) {
      const entry = typeMap.get(row.disasterType) ?? { count: 0, area: 0 };
      entry.count += 1;
      entry.area += row.affectedAreaMu;
      typeMap.set(row.disasterType, entry);
    }
    const severityMap = new Map<DisasterSeverity, number>();
    for (const row of matched) severityMap.set(row.severity, (severityMap.get(row.severity) ?? 0) + 1);
    return {
      total: matched.length,
      open: open.length,
      affectedAreaMu: open.reduce((sum, row) => sum + row.affectedAreaMu, 0),
      byType: [...typeMap.entries()].sort((a, b) => b[1].count - a[1].count).map(([disasterType, entry]) => ({ disasterType, count: entry.count, affectedAreaMu: entry.area })),
      bySeverity: [...severityMap.entries()].sort((a, b) => a[0] - b[0]).map(([severity, count]) => ({ severity, count })),
    };
  }

  async count(): Promise<number> {
    return this.rows.filter((row) => row.status !== "ARCHIVED").length;
  }
}
