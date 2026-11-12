import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 遥测阈值规则。
 *
 * 规则从代码搬到表里，是为了让「苗情/虫情/灾情」共用同一套判定口径：
 * 上报读数时按 metric 找命中的规则，方向决定是上限还是下限，级别决定告警与消息级别。
 *
 * 分级阈值（开发方案 6.1）：同一指标在同一地块上可配置「提示—预警—告警」三级，
 * 每级一条规则（uq_telemetry_rules_metric_plot_level）。plot_code 为空串表示全局默认，
 * 地块未单独配置时回落到全局规则；上报命中多级时只按最严重的一级生成一条告警。
 */

/** 越限方向：above 高于上限、below 低于下限 */
export type RuleDirection = "above" | "below";

/** 告警级别：提示 / 预警 / 告警 */
export type RuleLevel = "INFO" | "WARNING" | "CRITICAL";

/** 阈值规则记录 */
export interface TelemetryRule {
  id: string;
  metric: string;
  /** 适用地块编码；空串表示全局默认规则 */
  plotCode: string;
  direction: RuleDirection;
  threshold: number;
  level: RuleLevel;
  message: string;
  enabled: boolean;
  updatedAt: string;
}

/** 新增/更新规则入参 */
export interface RuleInput {
  metric: string;
  plotCode?: string;
  direction: RuleDirection;
  threshold: number;
  level: RuleLevel;
  message: string;
  enabled?: boolean;
}

export interface RuleRepository {
  list(): Promise<TelemetryRule[]>;
  /** 取指标在某地块上启用中的分级规则：地块专属优先，未配置则回落全局；返回命中的各级规则 */
  findEnabled(metric: string, plotCode?: string): Promise<TelemetryRule[]>;
  /** 按 (指标, 地块, 级别) 幂等写入：存在则更新阈值与文案 */
  save(rule: TelemetryRule): Promise<TelemetryRule>;
  /** 删除规则：缺省级别时删除该指标在该地块上的全部各级规则 */
  remove(metric: string, plotCode?: string, level?: RuleLevel): Promise<boolean>;
  /** 表为空时写入默认规则，返回写入条数 */
  seed(rules: TelemetryRule[]): Promise<number>;
}

/** 级别严重度排序：用于一次上报命中多级时取最严重的一级 */
export const RULE_SEVERITY: Record<RuleLevel, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/** 默认阈值规则：与迁移 008 的种子保持一致（全局单级），内存模式与空表时回填 */
export const DEFAULT_TELEMETRY_RULES: Array<Omit<TelemetryRule, "updatedAt">> = [
  { id: "rule-soil-moisture", metric: "soilMoisture", plotCode: "", direction: "below", threshold: 30, level: "WARNING", message: "土壤含水率低于灌溉阈值", enabled: true },
  { id: "rule-air-temperature", metric: "airTemperature", plotCode: "", direction: "above", threshold: 40, level: "WARNING", message: "空气温度超出适宜区间", enabled: true },
  { id: "rule-wind-speed", metric: "windSpeed", plotCode: "", direction: "above", threshold: 10, level: "CRITICAL", message: "风速超过作业安全阈值", enabled: true },
  { id: "rule-rainfall", metric: "rainfall", plotCode: "", direction: "above", threshold: 50, level: "WARNING", message: "降雨量超过排涝阈值", enabled: true },
  { id: "rule-canopy-coverage", metric: "canopyCoverage", plotCode: "", direction: "below", threshold: 60, level: "WARNING", message: "苗情覆盖度低于长势下限", enabled: true },
  { id: "rule-pest-count", metric: "pestCount", plotCode: "", direction: "above", threshold: 5, level: "WARNING", message: "虫口密度达到防治指标", enabled: true },
  { id: "rule-disease-index", metric: "diseaseIndex", plotCode: "", direction: "above", threshold: 15, level: "CRITICAL", message: "病情指数超过防控上限", enabled: true },
];

/** 判定读数是否越限 */
export function breaches(rule: TelemetryRule, value: number): boolean {
  return rule.direction === "above" ? value > rule.threshold : value < rule.threshold;
}

/** 规则唯一键：指标 + 地块 + 级别 */
function ruleKey(metric: string, plotCode: string, level: RuleLevel): string {
  return `${metric}::${plotCode}::${level}`;
}

function toRule(row: Record<string, unknown>): TelemetryRule {
  return {
    id: String(row.id),
    metric: String(row.metric),
    plotCode: String(row.plot_code ?? ""),
    direction: String(row.direction) === "below" ? "below" : "above",
    threshold: Number(row.threshold),
    level: String(row.level) === "CRITICAL" ? "CRITICAL" : String(row.level) === "INFO" ? "INFO" : "WARNING",
    message: String(row.message),
    enabled: Boolean(row.enabled),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/** 从命中的各级规则里挑出地块专属（优先）或全局规则集 */
function pickApplicable(rules: TelemetryRule[], plotCode: string): TelemetryRule[] {
  const specific = plotCode ? rules.filter((rule) => rule.plotCode === plotCode) : [];
  return specific.length > 0 ? specific : rules.filter((rule) => rule.plotCode === "");
}

/** PostgreSQL 实现，表结构由迁移 008 建立、020 增加地块维度 */
export class SqlRuleRepository implements RuleRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async list(): Promise<TelemetryRule[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, metric, plot_code, direction, threshold, level, message, enabled, updated_at
       FROM telemetry_rules ORDER BY metric, plot_code, level`,
    );
    return rows.map(toRule);
  }

  async findEnabled(metric: string, plotCode?: string): Promise<TelemetryRule[]> {
    const plot = plotCode ?? "";
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, metric, plot_code, direction, threshold, level, message, enabled, updated_at
       FROM telemetry_rules WHERE metric = $1 AND enabled = TRUE AND (plot_code = $2 OR plot_code = '')`,
      metric,
      plot,
    );
    return pickApplicable(rows.map(toRule), plot);
  }

  async save(rule: TelemetryRule): Promise<TelemetryRule> {
    // ON CONFLICT 保留的是原有行的 id（指标+地块+级别这一档只有一行），
    // 所以返回值必须回读那一行：把调用方带来的新 id 原样返回，前端下一步按 id 操作就找不到规则了。
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO telemetry_rules (id, metric, plot_code, direction, threshold, level, message, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (metric, plot_code, level) DO UPDATE SET direction = EXCLUDED.direction, threshold = EXCLUDED.threshold,
         message = EXCLUDED.message, enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
       RETURNING id, metric, plot_code, direction, threshold, level, message, enabled, updated_at`,
      rule.id,
      rule.metric,
      rule.plotCode,
      rule.direction,
      rule.threshold,
      rule.level,
      rule.message,
      rule.enabled,
      rule.updatedAt,
    );
    const saved = rows[0];
    if (!saved) throw new Error("阈值规则写入失败");
    return toRule(saved);
  }

  async remove(metric: string, plotCode?: string, level?: RuleLevel): Promise<boolean> {
    const plot = plotCode ?? "";
    if (level) {
      return (await this.client.$executeRawUnsafe(`DELETE FROM telemetry_rules WHERE metric = $1 AND plot_code = $2 AND level = $3`, metric, plot, level)) > 0;
    }
    return (await this.client.$executeRawUnsafe(`DELETE FROM telemetry_rules WHERE metric = $1 AND plot_code = $2`, metric, plot)) > 0;
  }

  async seed(rules: TelemetryRule[]): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM telemetry_rules`);
    if (Number(rows[0]?.total ?? 0) > 0) return 0;
    let written = 0;
    for (const rule of rules) {
      await this.save(rule);
      written += 1;
    }
    return written;
  }
}

/** 内存实现：测试与本地演示 */
export class InMemoryRuleRepository implements RuleRepository {
  private readonly rows = new Map<string, TelemetryRule>();

  constructor(seed: TelemetryRule[] = []) {
    for (const rule of seed) this.rows.set(ruleKey(rule.metric, rule.plotCode, rule.level), rule);
  }

  async list(): Promise<TelemetryRule[]> {
    // 与 SQL 的 ORDER BY metric, plot_code, level 逐字段比较，而不是把三段拼成一串比
    return [...this.rows.values()].sort(
      (a, b) => a.metric.localeCompare(b.metric) || a.plotCode.localeCompare(b.plotCode) || a.level.localeCompare(b.level),
    );
  }

  async findEnabled(metric: string, plotCode?: string): Promise<TelemetryRule[]> {
    const plot = plotCode ?? "";
    const enabled = [...this.rows.values()].filter((rule) => rule.metric === metric && rule.enabled);
    return pickApplicable(enabled, plot);
  }

  async save(rule: TelemetryRule): Promise<TelemetryRule> {
    // 与 SQL 的 ON CONFLICT DO UPDATE 同一口径：同一档规则保留原有 id 与键字段，
    // 只覆盖方向、阈值、文案、开关与更新时间。整行替换会让每次保存都换掉规则 id。
    const existing = this.rows.get(ruleKey(rule.metric, rule.plotCode, rule.level));
    const saved: TelemetryRule = existing
      ? { ...existing, direction: rule.direction, threshold: rule.threshold, message: rule.message, enabled: rule.enabled, updatedAt: rule.updatedAt }
      : { ...rule };
    this.rows.set(ruleKey(saved.metric, saved.plotCode, saved.level), saved);
    return { ...saved };
  }

  async remove(metric: string, plotCode?: string, level?: RuleLevel): Promise<boolean> {
    const plot = plotCode ?? "";
    let removed = false;
    for (const [key, rule] of [...this.rows.entries()]) {
      if (rule.metric === metric && rule.plotCode === plot && (!level || rule.level === level)) {
        this.rows.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  async seed(rules: TelemetryRule[]): Promise<number> {
    if (this.rows.size > 0) return 0;
    for (const rule of rules) this.rows.set(ruleKey(rule.metric, rule.plotCode, rule.level), rule);
    return rules.length;
  }
}