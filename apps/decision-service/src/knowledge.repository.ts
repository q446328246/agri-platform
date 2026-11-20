import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/**
 * 农艺知识库（C4）。
 *
 * 结构化沉淀农艺口径与处置知识，供智能问答检索引用：问答按关键词命中启用中的
 * 条目，回答内容与依据可追溯。D 类确认的农艺口径（灌溉定额、料液密度、补灌定额、
 * 面积分摊）以 CRITERIA 类条目沉淀，与迁移 061 的种子同口径。
 *
 * 检索口径：条目 keywords 逗号分隔，问题包含任一关键词即命中，按 sort 排序取前 N 条。
 */

/** 知识条目分类 */
export type KnowledgeCategory = "CROP" | "INDICATOR" | "DISPOSAL" | "CRITERIA";

export const KNOWLEDGE_CATEGORIES: readonly KnowledgeCategory[] = ["CROP", "INDICATOR", "DISPOSAL", "CRITERIA"];

/** 知识条目 */
export interface AgronomyKnowledge {
  id: string;
  tenantId: string;
  category: KnowledgeCategory;
  title: string;
  /** 检索关键词，逗号分隔 */
  keywords: string;
  content: string;
  /** 依据来源 */
  source?: string;
  enabled: boolean;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

/** 新增/更新入参；id 与时间戳由仓储生成或保留 */
export interface KnowledgeInput {
  category: KnowledgeCategory;
  title: string;
  keywords: string;
  content: string;
  source?: string;
  enabled?: boolean;
  sort?: number;
}

export interface KnowledgeRepository {
  /** 租户全部条目，按 sort、创建时间排序，供管理列表 */
  list(tenantId: string): Promise<AgronomyKnowledge[]>;
  findById(tenantId: string, id: string): Promise<AgronomyKnowledge | null>;
  /** 按问题关键词检索启用中的条目：命中任一关键词即返回，按 sort 排序 */
  search(tenantId: string, question: string, limit?: number): Promise<AgronomyKnowledge[]>;
  /** 新增或整行更新（同 id 覆盖）；返回落库后的条目 */
  save(tenantId: string, id: string, input: KnowledgeInput): Promise<AgronomyKnowledge>;
  /** 删除条目；不存在或跨租户返回 false */
  remove(tenantId: string, id: string): Promise<boolean>;
  /** 租户条目数；0 表示知识库为空 */
  count(tenantId: string): Promise<number>;
  /** 表为空时写入默认知识，返回写入条数 */
  seed(entries: AgronomyKnowledge[]): Promise<number>;
}

const COLUMNS = "id, tenant_id, category, title, keywords, content, source, enabled, sort, created_at, updated_at";

function toRecord(row: Record<string, unknown>): AgronomyKnowledge {
  const record: AgronomyKnowledge = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    category: String(row.category) as KnowledgeCategory,
    title: String(row.title),
    keywords: String(row.keywords),
    content: String(row.content),
    enabled: Boolean(row.enabled),
    sort: Number(row.sort),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  if (row.source !== null && row.source !== undefined && row.source !== "") record.source = String(row.source);
  return record;
}

/** 默认知识：与迁移 061 种子同口径，内存模式与空表时回填 */
export const DEFAULT_KNOWLEDGE: Array<Omit<AgronomyKnowledge, "tenantId" | "createdAt" | "updatedAt">> = [
  { id: "kb-irrigation-quota", category: "CRITERIA", title: "灌溉定额", keywords: "灌溉,定额,灌水,水量,补水", content: "大田旱作作物单次灌溉参考范围 10–40 毫米：一般 10–30 毫米/次，干旱补灌可至 40–50 毫米；水肥一体随水施肥时，灌水定额与施肥定额同源。按作物与生育期分别确认后固化。", source: "D1 农艺口径确认（2026-11-20）", enabled: true, sort: 1 },
  { id: "kb-fertilizer-density", category: "CRITERIA", title: "料液密度", keywords: "料液,密度,施肥,千克,升", content: "水溶肥类料液密度常见 1.0–1.3 kg/L（略高于水），以产品标签/现场配方为准；平台侧配置默认 1.0 kg/L，设备直接报千克时不使用该值。", source: "D1 农艺口径确认（2026-11-20）", enabled: true, sort: 2 },
  { id: "kb-supplement-irrigation", category: "CRITERIA", title: "越限补灌定额", keywords: "补灌,越限,含水率,处置", content: "土壤含水率低于阈值触发补灌，采用固定补灌定额口径一：参考范围 10–20 毫米/次（按土壤质地与作物需水确认），平台缺省 15 毫米；按含水率缺口估算的口径二作为二期。", source: "D3 农艺口径确认（2026-11-20）", enabled: true, sort: 3 },
  { id: "kb-area-allocation", category: "CRITERIA", title: "多明细分区面积分摊", keywords: "分摊,面积,分区,网格,明细", content: "一个指令对应多地块/分区时采用规则 A：明细 gridCode → 网格台账面积，多明细逐明细建分区，各分区面积取各自网格台账面积，平台不另设分摊算法。", source: "D2 农艺口径确认（2026-11-20）", enabled: true, sort: 4 },
  { id: "kb-soil-moisture-threshold", category: "INDICATOR", title: "土壤含水率阈值", keywords: "含水率,墒情,土壤,水分", content: "土壤含水率低于 30% 触发补灌规则（全局默认阈值，地块可单独配置分级规则）；高于上限时自动停灌未领取的灌溉指令。", source: "阈值规则默认口径（迁移 008）", enabled: true, sort: 5 },
  { id: "kb-rain-probability", category: "INDICATOR", title: "降雨概率口径", keywords: "降雨,天气,概率,雨", content: "降雨概率高于 60% 时不生成补灌处方，避免浇后降雨造成深层渗漏或渍害；降雨概率取自气象服务预报。", source: "处方生成规则默认口径", enabled: true, sort: 6 },
  { id: "kb-canopy-coverage", category: "INDICATOR", title: "苗情覆盖度阈值", keywords: "苗情,覆盖度,长势,冠层", content: "冠层覆盖度低于 60% 触发苗情预警，提示关注长势与水肥供给；覆盖度读数来自田间设备上报。", source: "阈值规则默认口径（迁移 008）", enabled: true, sort: 7 },
  { id: "kb-pest-control", category: "DISPOSAL", title: "虫情防治处置", keywords: "虫情,虫害,防治,农药,植保", content: "虫口密度达到防治指标（5 头/百株）时触发虫情告警，处置走植保作业：生成植保处方并派单，药剂用量按处方与地块面积执行。", source: "虫情规则默认口径（迁移 008）", enabled: true, sort: 8 },
];

/** PostgreSQL 实现，表结构由迁移 061 建立 */
export class SqlKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async list(tenantId: string): Promise<AgronomyKnowledge[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM agronomy_knowledge WHERE tenant_id = $1 ORDER BY sort, created_at`,
      tenantId,
    );
    return rows.map(toRecord);
  }

  async findById(tenantId: string, id: string): Promise<AgronomyKnowledge | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM agronomy_knowledge WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      tenantId,
      id,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async search(tenantId: string, question: string, limit = 5): Promise<AgronomyKnowledge[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM agronomy_knowledge
       WHERE tenant_id = $1 AND enabled = TRUE
       ORDER BY sort, created_at`,
      tenantId,
    );
    return matchKnowledge(rows.map(toRecord), question, limit);
  }

  async save(tenantId: string, id: string, input: KnowledgeInput): Promise<AgronomyKnowledge> {
    const now = new Date().toISOString();
    const rows = await this.executor(undefined).$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO agronomy_knowledge (id, tenant_id, category, title, keywords, content, source, enabled, sort, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, title = EXCLUDED.title,
         keywords = EXCLUDED.keywords, content = EXCLUDED.content, source = EXCLUDED.source,
         enabled = EXCLUDED.enabled, sort = EXCLUDED.sort, updated_at = EXCLUDED.updated_at
       RETURNING ${COLUMNS}`,
      id,
      tenantId,
      input.category,
      input.title,
      input.keywords,
      input.content,
      input.source ?? null,
      input.enabled ?? true,
      input.sort ?? 0,
      now,
      now,
    );
    const saved = rows[0];
    if (!saved) throw new Error("农艺知识条目写入失败");
    return toRecord(saved);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return (await this.client.$executeRawUnsafe("DELETE FROM agronomy_knowledge WHERE tenant_id = $1 AND id = $2", tenantId, id)) > 0;
  }

  async count(tenantId: string): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(
      "SELECT COUNT(*)::int AS total FROM agronomy_knowledge WHERE tenant_id = $1",
      tenantId,
    );
    return Number(rows[0]?.total ?? 0);
  }

  async seed(entries: AgronomyKnowledge[]): Promise<number> {
    if ((await this.totalCount()) > 0) return 0;
    let written = 0;
    for (const entry of entries) {
      await this.save(entry.tenantId, entry.id, {
        category: entry.category,
        title: entry.title,
        keywords: entry.keywords,
        content: entry.content,
        ...(entry.source !== undefined ? { source: entry.source } : {}),
        enabled: entry.enabled,
        sort: entry.sort,
      });
      written += 1;
    }
    return written;
  }

  private async totalCount(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>("SELECT COUNT(*)::int AS total FROM agronomy_knowledge");
    return Number(rows[0]?.total ?? 0);
  }
}

/** 关键词检索：条目 keywords 逗号分隔，问题包含任一关键词即命中，按 sort 排序取前 N 条 */
export function matchKnowledge(entries: AgronomyKnowledge[], question: string, limit: number): AgronomyKnowledge[] {
  const trimmed = question.trim();
  if (!trimmed) return [];
  return entries
    .filter((entry) => entry.enabled && entry.keywords.split(",").some((keyword) => keyword.trim() !== "" && trimmed.includes(keyword.trim())))
    .slice(0, Math.max(1, limit));
}

/** 内存实现：测试与本地演示 */
export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly rows = new Map<string, AgronomyKnowledge>();

  constructor(entries: AgronomyKnowledge[] = []) {
    for (const entry of entries) this.rows.set(`${entry.tenantId}::${entry.id}`, entry);
  }

  async list(tenantId: string): Promise<AgronomyKnowledge[]> {
    return [...this.rows.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt))
      .map((entry) => structuredClone(entry));
  }

  async findById(tenantId: string, id: string): Promise<AgronomyKnowledge | null> {
    const entry = this.rows.get(`${tenantId}::${id}`);
    return entry ? structuredClone(entry) : null;
  }

  async search(tenantId: string, question: string, limit?: number): Promise<AgronomyKnowledge[]> {
    return matchKnowledge(await this.list(tenantId), question, limit ?? 5);
  }

  async save(tenantId: string, id: string, input: KnowledgeInput): Promise<AgronomyKnowledge> {
    const now = new Date().toISOString();
    const existing = this.rows.get(`${tenantId}::${id}`);
    const saved: AgronomyKnowledge = {
      id,
      tenantId,
      category: input.category,
      title: input.title,
      keywords: input.keywords,
      content: input.content,
      ...(input.source !== undefined ? { source: input.source } : {}),
      enabled: input.enabled ?? true,
      sort: input.sort ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(`${tenantId}::${id}`, saved);
    return structuredClone(saved);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return this.rows.delete(`${tenantId}::${id}`);
  }

  async count(tenantId: string): Promise<number> {
    return [...this.rows.values()].filter((entry) => entry.tenantId === tenantId).length;
  }

  async seed(entries: AgronomyKnowledge[]): Promise<number> {
    if (this.rows.size > 0) return 0;
    let written = 0;
    for (const entry of entries) {
      this.rows.set(`${entry.tenantId}::${entry.id}`, entry);
      written += 1;
    }
    return written;
  }
}

/** 生成知识条目标识：ULID，按时间有序便于排序 */
export function newKnowledgeId(): string {
  return ulid();
}
