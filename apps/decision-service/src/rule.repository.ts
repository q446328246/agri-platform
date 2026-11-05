import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 决策规则仓储。
 *
 * 规则以数据形式存储（对应脚手架说明 5.5.1「规则热更新」）：
 * 服务启动读取一次，之后每次求值都从仓储读取最新规则集，
 * 因此通过接口新增、修改、停用规则后立即生效，无需重启服务。
 */

/** 规则类型 */
export type RuleType = "IRRIGATION" | "FERTILIZATION" | "PEST_WARNING";

/** 规则条件：全部字段缺省表示不过滤，给出的字段必须同时满足 */
export interface RuleCondition {
  /** 土壤含水率低于该值（百分比） */
  soilMoistureBelow?: number;
  /** 未来降雨概率低于该值（百分比） */
  rainProbabilityBelow?: number;
  /** 作物生育期，缺省不限 */
  growthStage?: string;
}

/** 规则动作 */
export interface RuleAction {
  type: RuleType;
  /** 用量：灌溉为 mm，施肥为 kg/亩 */
  amount: number;
  unit: string;
  reason: string;
}

/** 决策规则 */
export interface Rule {
  id: string;
  name: string;
  type: RuleType;
  enabled: boolean;
  /** 人类可读表达式，用于展示与留痕 */
  expression: string;
  /** 求值优先级，数值小的先匹配 */
  priority: number;
  condition: RuleCondition;
  action: RuleAction;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** 新增规则入参 */
export interface CreateRuleInput {
  id: string;
  name: string;
  type: RuleType;
  expression: string;
  priority: number;
  condition: RuleCondition;
  action: RuleAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 修改规则入参：只更新给出的字段 */
export interface UpdateRuleInput {
  name?: string;
  type?: RuleType;
  enabled?: boolean;
  expression?: string;
  priority?: number;
  condition?: RuleCondition;
  action?: RuleAction;
  updatedAt: string;
}

/** 规则仓储契约 */
export interface RuleRepository {
  list(): Promise<Rule[]>;
  findById(id: string): Promise<Rule | null>;
  create(input: CreateRuleInput): Promise<Rule>;
  update(id: string, patch: UpdateRuleInput): Promise<Rule | null>;
  remove(id: string, deletedAt: string): Promise<boolean>;
  count(): Promise<number>;
}

export const RULE_TYPES: RuleType[] = ["IRRIGATION", "FERTILIZATION", "PEST_WARNING"];

export function isRuleType(value: unknown): value is RuleType {
  return typeof value === "string" && (RULE_TYPES as string[]).includes(value);
}

/** 把前端传入的条件/动作规范化，缺省字段填默认值，避免脏数据进入求值 */
export function normalizeCondition(value: unknown): RuleCondition {
  const input = (value ?? {}) as Record<string, unknown>;
  const condition: RuleCondition = {};
  if (input.soilMoistureBelow !== undefined && Number.isFinite(Number(input.soilMoistureBelow))) condition.soilMoistureBelow = Number(input.soilMoistureBelow);
  if (input.rainProbabilityBelow !== undefined && Number.isFinite(Number(input.rainProbabilityBelow))) condition.rainProbabilityBelow = Number(input.rainProbabilityBelow);
  if (typeof input.growthStage === "string" && input.growthStage.trim().length > 0) condition.growthStage = input.growthStage.trim();
  return condition;
}

export function normalizeAction(value: unknown, fallbackType: RuleType): RuleAction {
  const input = (value ?? {}) as Record<string, unknown>;
  return {
    type: isRuleType(input.type) ? input.type : fallbackType,
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : 0,
    unit: String(input.unit ?? ""),
    reason: String(input.reason ?? ""),
  };
}

/** 默认规则：土壤含水率偏低且短期无明显降雨时补灌 */
export function defaultRule(now: string): Rule {
  return {
    id: "rule-soil-dry",
    name: "土壤含水率低于阈值补灌",
    type: "IRRIGATION",
    enabled: true,
    expression: "soilMoisture < 30 && rainProbability < 60",
    priority: 10,
    condition: { soilMoistureBelow: 30, rainProbabilityBelow: 60 },
    action: { type: "IRRIGATION", amount: 18, unit: "mm", reason: "土壤含水率低于 30% 且未来降雨概率较低" },
    createdAt: now,
    updatedAt: now,
  };
}

function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
}

/** 内存实现：用于测试与未启用数据库的本地模式，种子规则保证开箱可用 */
export class InMemoryRuleRepository implements RuleRepository {
  private readonly rows: Rule[];

  constructor(seed: Rule[] = [defaultRule(new Date().toISOString())]) {
    this.rows = seed.map((rule) => ({ ...rule, condition: { ...rule.condition }, action: { ...rule.action } }));
  }

  async list(): Promise<Rule[]> {
    return sortRules(this.rows.filter((row) => row.deletedAt === undefined));
  }

  async findById(id: string): Promise<Rule | null> {
    return this.rows.find((row) => row.id === id && row.deletedAt === undefined) ?? null;
  }

  async create(input: CreateRuleInput): Promise<Rule> {
    const rule: Rule = { ...input, condition: { ...input.condition }, action: { ...input.action } };
    this.rows.push(rule);
    return rule;
  }

  async update(id: string, patch: UpdateRuleInput): Promise<Rule | null> {
    const row = this.rows.find((item) => item.id === id && item.deletedAt === undefined);
    if (!row) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.type !== undefined) row.type = patch.type;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.expression !== undefined) row.expression = patch.expression;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.condition !== undefined) row.condition = { ...patch.condition };
    if (patch.action !== undefined) row.action = { ...patch.action };
    row.updatedAt = patch.updatedAt;
    return row;
  }

  async remove(id: string, deletedAt: string): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id && item.deletedAt === undefined);
    if (!row) return false;
    row.deletedAt = deletedAt;
    row.updatedAt = deletedAt;
    return true;
  }

  async count(): Promise<number> {
    return this.rows.filter((row) => row.deletedAt === undefined).length;
  }
}

/** PostgreSQL 实现，表结构由迁移 002_decision_telemetry.sql 管理 */
export class SqlRuleRepository implements RuleRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  private toRule(row: Record<string, unknown>): Rule {
    const rule: Rule = {
      id: String(row.id),
      name: String(row.rule_name),
      type: isRuleType(row.rule_type) ? row.rule_type : "IRRIGATION",
      enabled: Boolean(row.enabled),
      expression: String(row.expression),
      priority: Number(row.priority),
      condition: normalizeCondition(row.condition_json),
      action: normalizeAction(row.action_json, isRuleType(row.rule_type) ? row.rule_type : "IRRIGATION"),
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: toIsoTimestamp(row.updated_at),
    };
    if (row.deleted_at !== null && row.deleted_at !== undefined) rule.deletedAt = toIsoTimestamp(row.deleted_at);
    return rule;
  }

  async list(): Promise<Rule[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, rule_name, rule_type, enabled, expression, priority, condition_json, action_json, created_at, updated_at, deleted_at
       FROM decision_rules WHERE deleted_at IS NULL ORDER BY priority, created_at`,
    );
    return rows.map((row) => this.toRule(row));
  }

  async findById(id: string): Promise<Rule | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, rule_name, rule_type, enabled, expression, priority, condition_json, action_json, created_at, updated_at, deleted_at
       FROM decision_rules WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      id,
    );
    const row = rows[0];
    return row ? this.toRule(row) : null;
  }

  async create(input: CreateRuleInput): Promise<Rule> {
    await this.client.$executeRawUnsafe(
      `INSERT INTO decision_rules (id, rule_name, rule_type, enabled, expression, priority, condition_json, action_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      input.id,
      input.name,
      input.type,
      input.enabled,
      input.expression,
      input.priority,
      JSON.stringify(input.condition),
      JSON.stringify(input.action),
      input.createdAt,
      input.updatedAt,
    );
    return { ...input, condition: { ...input.condition }, action: { ...input.action } };
  }

  async update(id: string, patch: UpdateRuleInput): Promise<Rule | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, rule_name, rule_type, enabled, expression, priority, condition_json, action_json, created_at, updated_at, deleted_at
       FROM decision_rules WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      id,
    );
    const row = rows[0];
    if (!row) return null;
    const condition = patch.condition ?? normalizeCondition(row.condition_json);
    const ruleType = patch.type ?? (isRuleType(row.rule_type) ? row.rule_type : "IRRIGATION");
    const action = patch.action ?? normalizeAction(row.action_json, ruleType);
    const updated: Rule = {
      id,
      name: patch.name ?? String(row.rule_name),
      type: ruleType,
      enabled: patch.enabled ?? Boolean(row.enabled),
      expression: patch.expression ?? String(row.expression),
      priority: patch.priority ?? Number(row.priority),
      condition,
      action,
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: patch.updatedAt,
    };
    await this.client.$executeRawUnsafe(
      `UPDATE decision_rules SET rule_name = $2, rule_type = $3, enabled = $4, expression = $5, priority = $6,
       condition_json = $7::jsonb, action_json = $8::jsonb, updated_at = $9
       WHERE id = $1 AND deleted_at IS NULL`,
      id,
      updated.name,
      updated.type,
      updated.enabled,
      updated.expression,
      updated.priority,
      JSON.stringify(updated.condition),
      JSON.stringify(updated.action),
      updated.updatedAt,
    );
    return updated;
  }

  async remove(id: string, deletedAt: string): Promise<boolean> {
    return (
      (await this.client.$executeRawUnsafe(
        `UPDATE decision_rules SET deleted_at = $2, updated_at = $2 WHERE id = $1 AND deleted_at IS NULL`,
        id,
        deletedAt,
      )) > 0
    );
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM decision_rules WHERE deleted_at IS NULL`);
    return Number(rows[0]?.total ?? 0);
  }
}
