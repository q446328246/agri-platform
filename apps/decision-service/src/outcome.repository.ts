import type { PrismaClientLike, Tx } from "@agri/db";
import { ulid } from "@agri/shared";

import type { PrescriptionRecord } from "./prescription.repository.js";
import type { Rule, RuleCondition } from "./rule.repository.js";

/**
 * 处方效果回流。
 *
 * 处方生成只是决策的起点：执行后必须把「实际效果」回写，才能判断阈值是否
 * 合适。评估结果保留输入数据与建议，是否把建议写回规则由调用方决定，
 * 从而形成「处方留痕 → 效果评估 → 规则调优」的可追溯闭环。
 */

/** 阈值调整建议 */
export interface ThresholdSuggestion {
  ruleId: string;
  ruleName: string;
  /** 规则当前的触发阈值 */
  currentThreshold: number;
  /** 建议的触发阈值 */
  suggestedThreshold: number;
  reason: string;
}

/** 效果评估记录 */
export interface PrescriptionOutcome {
  id: string;
  prescriptionId: string;
  plotCode: string;
  /** 命中的规则标识，缺省表示未命中规则 */
  ruleId?: string;
  soilMoistureBefore: number;
  soilMoistureAfter: number;
  /** 目标含水率，取自规则阈值 */
  target: number;
  /** 含水率变化量，单位与含水率一致 */
  delta: number;
  /** 执行后是否达到目标 */
  effective: boolean;
  suggestion?: ThresholdSuggestion;
  /** 建议是否已写回规则 */
  applied: boolean;
  note: string;
  evaluatedAt: string;
}

/** 效果评估入参 */
export interface EvaluateOutcomeInput {
  prescription: PrescriptionRecord;
  /** 命中规则的当前定义，缺省时仅按处方快照评估 */
  rule?: Rule;
  /** 执行后实测含水率 */
  soilMoistureAfter: number;
  /** 目标含水率，缺省取规则阈值，再缺省 30 */
  target?: number;
  note?: string;
  evaluatedAt: string;
}

/** 评估结论 */
export interface OutcomeEvaluation {
  soilMoistureBefore: number;
  target: number;
  delta: number;
  effective: boolean;
  suggestion?: ThresholdSuggestion;
}

/** 评估记录仓储 */
export interface OutcomeRepository {
  create(input: PrescriptionOutcome): Promise<PrescriptionOutcome>;
  /** 最近一次评估，用于判断是否已回写 */
  findLatest(prescriptionId: string): Promise<PrescriptionOutcome | null>;
}

/** 阈值允许区间，避免建议把阈值推到无意义的值 */
const MIN_THRESHOLD = 20;
const MAX_THRESHOLD = 60;

/** 阈值调整步长 */
const THRESHOLD_STEP = 5;

/** 高于目标超过该值视为灌溉过量 */
const OVERSHOOT = 10;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampThreshold(value: number): number {
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, value));
}

/** 把条件渲染为人可读表达式，写回规则时保持展示与求值一致 */
export function formatCondition(condition: RuleCondition): string {
  const parts: string[] = [];
  if (condition.soilMoistureBelow !== undefined) parts.push(`soilMoisture < ${condition.soilMoistureBelow}`);
  if (condition.rainProbabilityBelow !== undefined) parts.push(`rainProbability < ${condition.rainProbabilityBelow}`);
  if (condition.growthStage !== undefined && condition.growthStage !== "") parts.push(`growthStage == ${condition.growthStage}`);
  return parts.join(" && ");
}

/**
 * 评估处方执行效果并给出阈值建议。
 *
 * 判断口径保持简单可解释：执行后有作业建议且含水率仍低于目标、且几乎
 * 没有回升，说明触发太晚，建议提高阈值；含水率远高于目标则说明过度灌溉，
 * 建议降低阈值。回升幅度落在合理区间时不改阈值。
 */
export function evaluateOutcome(input: EvaluateOutcomeInput): OutcomeEvaluation {
  const currentThreshold = input.rule?.condition.soilMoistureBelow;
  const target = input.target ?? currentThreshold ?? 30;
  const before = input.prescription.soilMoisture ?? target;
  const after = input.soilMoistureAfter;
  const delta = round1(after - before);
  const effective = after >= target;
  const evaluation: OutcomeEvaluation = { soilMoistureBefore: before, target, delta, effective };

  if (!input.rule || currentThreshold === undefined || input.prescription.actions.length === 0) {
    return evaluation;
  }

  let suggested: number | undefined;
  let reason = "";
  if (!effective && delta <= 1) {
    suggested = clampThreshold(currentThreshold + THRESHOLD_STEP);
    reason = `执行后含水率仍为 ${after}（变化 ${delta}），低于目标 ${target}，建议提高触发阈值以提前触发作业`;
  } else if (effective && after - target > OVERSHOOT) {
    suggested = clampThreshold(currentThreshold - THRESHOLD_STEP);
    reason = `执行后含水率 ${after} 明显高于目标 ${target}，建议降低触发阈值以减少过量灌溉`;
  }

  if (suggested !== undefined && suggested !== currentThreshold) {
    evaluation.suggestion = {
      ruleId: input.rule.id,
      ruleName: input.rule.name,
      currentThreshold,
      suggestedThreshold: suggested,
      reason,
    };
  }
  return evaluation;
}

function toOutcome(row: Record<string, unknown>): PrescriptionOutcome {
  const outcome: PrescriptionOutcome = {
    id: String(row.id),
    prescriptionId: String(row.prescription_id),
    plotCode: String(row.plot_code),
    soilMoistureBefore: Number(row.soil_moisture_before),
    soilMoistureAfter: Number(row.soil_moisture_after),
    target: Number(row.target),
    delta: Number(row.delta),
    effective: Boolean(row.effective),
    applied: Boolean(row.applied),
    note: String(row.note),
    evaluatedAt: row.evaluated_at instanceof Date ? row.evaluated_at.toISOString() : new Date(String(row.evaluated_at)).toISOString(),
  };
  if (row.rule_id !== null && row.rule_id !== undefined) outcome.ruleId = String(row.rule_id);
  if (row.suggestion_json !== null && row.suggestion_json !== undefined) outcome.suggestion = row.suggestion_json as ThresholdSuggestion;
  return outcome;
}

/** PostgreSQL 实现，表结构由迁移 003 管理 */
export class SqlOutcomeRepository implements OutcomeRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async create(input: PrescriptionOutcome): Promise<PrescriptionOutcome> {
    await this.executor(undefined).$executeRawUnsafe(
      `INSERT INTO decision_prescription_outcomes
       (id, prescription_id, plot_code, rule_id, soil_moisture_before, soil_moisture_after, target, delta,
        effective, suggestion_json, applied, note, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
      input.id,
      input.prescriptionId,
      input.plotCode,
      input.ruleId ?? null,
      input.soilMoistureBefore,
      input.soilMoistureAfter,
      input.target,
      input.delta,
      input.effective,
      input.suggestion === undefined ? null : JSON.stringify(input.suggestion),
      input.applied,
      input.note,
      input.evaluatedAt,
    );
    return input;
  }

  async findLatest(prescriptionId: string): Promise<PrescriptionOutcome | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, prescription_id, plot_code, rule_id, soil_moisture_before, soil_moisture_after, target, delta,
              effective, suggestion_json, applied, note, evaluated_at
       FROM decision_prescription_outcomes WHERE prescription_id = $1
       ORDER BY evaluated_at DESC, id DESC LIMIT 1`,
      prescriptionId,
    );
    const row = rows[0];
    return row ? toOutcome(row) : null;
  }
}

/** 内存实现：与处方留痕一并用于本地模式与测试 */
export class InMemoryOutcomeRepository implements OutcomeRepository {
  private readonly rows: PrescriptionOutcome[] = [];

  async create(input: PrescriptionOutcome): Promise<PrescriptionOutcome> {
    this.rows.unshift({ ...input });
    return input;
  }

  async findLatest(prescriptionId: string): Promise<PrescriptionOutcome | null> {
    return this.rows.find((row) => row.prescriptionId === prescriptionId) ?? null;
  }

  /** 全部记录，供测试断言 */
  all(): PrescriptionOutcome[] {
    return [...this.rows];
  }
}

/** 生成评估记录标识 */
export function newOutcomeId(): string {
  return ulid();
}
