import type { Rule, RuleRepository } from "./rule.repository.js";
import type { PrescriptionItem } from "./prescription.repository.js";

/**
 * 规则求值引擎。
 *
 * 每次求值都从仓储读取最新规则集，因此接口侧新增、修改或停用规则后立即生效，
 * 无需重启服务（对应脚手架说明 5.5.1「规则热更新」）。
 * 求值结果同时返回命中规则清单，供处方留痕与事后复核。
 */

/** 求值输入：地块、作物、生育期、墒情、气象 */
export interface RuleEvaluationInput {
  plotCode?: string;
  plotName?: string;
  crop?: string;
  growthStage?: string;
  soilMoisture?: number;
  rainProbability?: number;
}

/** 命中规则摘要 */
export interface MatchedRule {
  id: string;
  name: string;
  expression: string;
  action: Rule["action"];
}

export interface RuleEvaluationResult {
  matchedRules: MatchedRule[];
  items: PrescriptionItem[];
}

/** 投入品编码，取自农资字典；缺省字典时按动作类型回落 */
const MATERIAL_BY_TYPE: Record<Rule["type"], string> = {
  IRRIGATION: "MAT-WATER-IRRIGATION",
  FERTILIZATION: "MAT-FERT-NITROGEN",
  PEST_WARNING: "MAT-PEST-BROAD",
};

function numberOrUndefined(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** 单条规则是否命中：条件字段全部满足才算命中，条件为空视为不命中 */
export function matchesRule(rule: Rule, input: RuleEvaluationInput): boolean {
  if (!rule.enabled) return false;
  const { condition } = rule;
  const keys = Object.keys(condition) as Array<keyof Rule["condition"]>;
  if (keys.length === 0) return false;
  if (condition.soilMoistureBelow !== undefined) {
    const soil = numberOrUndefined(input.soilMoisture);
    if (soil === undefined || soil >= condition.soilMoistureBelow) return false;
  }
  if (condition.rainProbabilityBelow !== undefined) {
    const rain = numberOrUndefined(input.rainProbability);
    if (rain === undefined || rain >= condition.rainProbabilityBelow) return false;
  }
  if (condition.growthStage !== undefined) {
    const stage = String(input.growthStage ?? "").trim();
    if (stage !== condition.growthStage) return false;
  }
  return true;
}

function buildItem(rule: Rule, input: RuleEvaluationInput, now: string): PrescriptionItem {
  const amount = Number.isFinite(rule.action.amount) ? rule.action.amount : 0;
  const windowStart = now;
  const windowEnd = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  return {
    ...(input.plotCode ? { gridCode: input.plotCode } : {}),
    materialCode: MATERIAL_BY_TYPE[rule.action.type],
    dosage: amount,
    windowStart,
    windowEnd,
  };
}

export class RuleEngine {
  constructor(private readonly rules: RuleRepository) {}

  /** 读取最新规则并求值；同一输入可能命中多条规则，按优先级顺序累计动作 */
  async evaluate(input: RuleEvaluationInput, now = new Date().toISOString()): Promise<RuleEvaluationResult> {
    const rules = await this.rules.list();
    const matchedRules: MatchedRule[] = [];
    const items: PrescriptionItem[] = [];
    for (const rule of rules) {
      if (!matchesRule(rule, input)) continue;
      matchedRules.push({ id: rule.id, name: rule.name, expression: rule.expression, action: rule.action });
      items.push(buildItem(rule, input, now));
    }
    return { matchedRules, items };
  }
}
