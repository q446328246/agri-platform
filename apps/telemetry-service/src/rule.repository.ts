import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 遥测阈值规则。
 *
 * 规则从代码搬到表里，是为了让「苗情/虫情/灾情」共用同一套判定口径：
 * 上报读数时按 metric 找命中的规则，方向决定是上限还是下限，级别决定告警与消息级别。
 * 同一指标只保留一条规则（uq_telemetry_rules_metric），避免一次上报生成多条重复告警。
 */

/** 越限方向：above 高于上限、below 低于下限 */
export type RuleDirection = "above" | "below";

/** 告警级别 */
export type RuleLevel = "INFO" | "WARNING" | "CRITICAL";

/** 阈值规则记录 */
export interface TelemetryRule {
  id: string;
  metric: string;
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
  direction: RuleDirection;
  threshold: number;
  level: RuleLevel;
  message: string;
  enabled?: boolean;
}

export interface RuleRepository {
  list(): Promise<TelemetryRule[]>;
  /** 按指标取启用中的规则，未命中返回 null */
  findEnabled(metric: string): Promise<TelemetryRule | null>;
  /** 按指标幂等写入：存在则更新阈值与文案 */
  save(rule: TelemetryRule): Promise<TelemetryRule>;
  remove(metric: string): Promise<boolean>;
  /** 表为空时写入默认规则，返回写入条数 */
  seed(rules: TelemetryRule[]): Promise<number>;
}

/** 默认阈值规则：与迁移 008 的种子保持一致，内存模式与空表时回填 */
export const DEFAULT_TELEMETRY_RULES: Array<Omit<TelemetryRule, "updatedAt">> = [
  { id: "rule-soil-moisture", metric: "soilMoisture", direction: "below", threshold: 30, level: "WARNING", message: "土壤含水率低于灌溉阈值", enabled: true },
  { id: "rule-air-temperature", metric: "airTemperature", direction: "above", threshold: 40, level: "WARNING", message: "空气温度超出适宜区间", enabled: true },
  { id: "rule-wind-speed", metric: "windSpeed", direction: "above", threshold: 10, level: "CRITICAL", message: "风速超过作业安全阈值", enabled: true },
  { id: "rule-rainfall", metric: "rainfall", direction: "above", threshold: 50, level: "WARNING", message: "降雨量超过排涝阈值", enabled: true },
  { id: "rule-canopy-coverage", metric: "canopyCoverage", direction: "below", threshold: 60, level: "WARNING", message: "苗情覆盖度低于长势下限", enabled: true },
  { id: "rule-pest-count", metric: "pestCount", direction: "above", threshold: 5, level: "WARNING", message: "虫口密度达到防治指标", enabled: true },
  { id: "rule-disease-index", metric: "diseaseIndex", direction: "above", threshold: 15, level: "CRITICAL", message: "病情指数超过防控上限", enabled: true },
];

/** 判定读数是否越限 */
export function breaches(rule: TelemetryRule, value: number): boolean {
  return rule.direction === "above" ? value > rule.threshold : value < rule.threshold;
}

function toRule(row: Record<string, unknown>): TelemetryRule {
  return {
    id: String(row.id),
    metric: String(row.metric),
    direction: String(row.direction) === "below" ? "below" : "above",
    threshold: Number(row.threshold),
    level: String(row.level) === "CRITICAL" ? "CRITICAL" : String(row.level) === "INFO" ? "INFO" : "WARNING",
    message: String(row.message),
    enabled: Boolean(row.enabled),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/** PostgreSQL 实现，表结构由迁移 008 管理 */
export class SqlRuleRepository implements RuleRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async list(): Promise<TelemetryRule[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, metric, direction, threshold, level, message, enabled, updated_at FROM telemetry_rules ORDER BY metric`,
    );
    return rows.map(toRule);
  }

  async findEnabled(metric: string): Promise<TelemetryRule | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, metric, direction, threshold, level, message, enabled, updated_at
       FROM telemetry_rules WHERE metric = $1 AND enabled = TRUE LIMIT 1`,
      metric,
    );
    const row = rows[0];
    return row ? toRule(row) : null;
  }

  async save(rule: TelemetryRule): Promise<TelemetryRule> {
    await this.client.$executeRawUnsafe(
      `INSERT INTO telemetry_rules (id, metric, direction, threshold, level, message, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (metric) DO UPDATE SET direction = EXCLUDED.direction, threshold = EXCLUDED.threshold,
         level = EXCLUDED.level, message = EXCLUDED.message, enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
      rule.id,
      rule.metric,
      rule.direction,
      rule.threshold,
      rule.level,
      rule.message,
      rule.enabled,
      rule.updatedAt,
    );
    return rule;
  }

  async remove(metric: string): Promise<boolean> {
    return (await this.client.$executeRawUnsafe(`DELETE FROM telemetry_rules WHERE metric = $1`, metric)) > 0;
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
    for (const rule of seed) this.rows.set(rule.metric, rule);
  }

  async list(): Promise<TelemetryRule[]> {
    return [...this.rows.values()].sort((a, b) => a.metric.localeCompare(b.metric));
  }

  async findEnabled(metric: string): Promise<TelemetryRule | null> {
    const rule = this.rows.get(metric);
    return rule && rule.enabled ? rule : null;
  }

  async save(rule: TelemetryRule): Promise<TelemetryRule> {
    this.rows.set(rule.metric, rule);
    return rule;
  }

  async remove(metric: string): Promise<boolean> {
    return this.rows.delete(metric);
  }

  async seed(rules: TelemetryRule[]): Promise<number> {
    if (this.rows.size > 0) return 0;
    for (const rule of rules) this.rows.set(rule.metric, rule);
    return rules.length;
  }
}
