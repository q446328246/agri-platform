/**
 * EC/pH 偏离的配比调整建议（A18，开发方案 9.2/9.4）。
 *
 * 「浓度偏离设定范围时自动调整加肥量或注水量」「肥液 EC 值或 pH 值超限 →
 * 自动调整配比并推送提示，必要时暂停输送」。平台没有肥液体积、料液密度与
 * 缓冲容量的权威值，算不出「该加几升酸/几公斤肥」的绝对量——这里只给出
 * 保守的相对调整建议（百分比），落成 RECOMMENDED 处方走人工确认，不自动开阀。
 *
 * 调整方向口径：
 * - EC 偏高 → 稀释：加大注水量、核对加肥量（MAT-WATER-IRRIGATION）；
 * - EC 偏低 → 增肥：提高加肥量（MAT-FERT-NITROGEN）；
 * - pH 偏碱 → 酸化调理（MAT-AMEND-ACID，A18 新增调理剂编码，平台无农资字典表，
 *   编码沿 rule.engine MATERIAL_BY_TYPE 的约定登记）；
 * - pH 偏酸 → 碱化调理（MAT-AMEND-LIME，石灰类调理剂）。
 *
 * 建议幅度取偏离比的一半且封顶 30%：偏离比 r = |实测 − 阈值| / 阈值（截断到 0..1），
 * 一次调一半留给下一轮读数复核，避免传感器抖动引发配比大幅振荡。
 * 判定是纯函数，不依赖仓储与事件，消费侧与测试共用同一口径。
 */

/** 调整动作：稀释 / 增肥 / 酸化 / 碱化 */
export type EcPhAdjustmentKind = "DILUTE" | "CONCENTRATE" | "ACIDIFY" | "ALKALIZE";

/** 一条 EC/pH 调整建议 */
export interface EcPhAdjustment {
  metric: "soilEc" | "soilPh";
  direction: "above" | "below";
  value: number;
  threshold: number;
  /** 偏离比（0..1）：|实测 − 阈值| / 阈值 */
  deviationRatio: number;
  kind: EcPhAdjustmentKind;
  /** 建议投入品编码，与处方明细 materialCode 同口径 */
  materialCode: string;
  /** 建议调整幅度（百分比，相对当前注水量/加肥量/配比），保守取偏离比一半、封顶 30 */
  dosagePercent: number;
  /** 给人看的处置摘要，落处方 matchedRules 与指令缘由 */
  summary: string;
}

/** 调整动作的投入品与文案映射 */
const ADJUSTMENT_SPECS: Record<EcPhAdjustmentKind, { materialCode: string; label: string }> = {
  DILUTE: { materialCode: "MAT-WATER-IRRIGATION", label: "加大注水量稀释肥液，并核对加肥量" },
  CONCENTRATE: { materialCode: "MAT-FERT-NITROGEN", label: "提高加肥量，使肥液浓度回到适宜区间" },
  ACIDIFY: { materialCode: "MAT-AMEND-ACID", label: "投加酸化调理剂，逐步回调肥液 pH" },
  ALKALIZE: { materialCode: "MAT-AMEND-LIME", label: "投加石灰类碱化调理剂，逐步回调肥液 pH" },
};

/**
 * 由越限事实算一条保守调整建议。
 * 只处理 soilEc/soilPh；其它指标、非法数值或实测未越限（与方向矛盾）返回 undefined，
 * 消费侧据此跳过——不拿一条没越限的读数去生成调整处方。
 */
export function adjustEcPh(input: {
  metric: string;
  value: number;
  threshold: number;
  direction: "above" | "below";
}): EcPhAdjustment | undefined {
  if (input.metric !== "soilEc" && input.metric !== "soilPh") return undefined;
  const { value, threshold, direction } = input;
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return undefined;
  if (direction === "above" ? value <= threshold : value >= threshold) return undefined;
  const deviationRatio = Math.min(1, Math.abs(value - threshold) / threshold);
  const kind: EcPhAdjustmentKind =
    input.metric === "soilEc"
      ? direction === "above" ? "DILUTE" : "CONCENTRATE"
      : direction === "above" ? "ACIDIFY" : "ALKALIZE";
  const spec = ADJUSTMENT_SPECS[kind];
  const dosagePercent = Number((Math.min(30, deviationRatio * 50)).toFixed(1));
  const metricLabel = input.metric === "soilEc" ? "EC" : "pH";
  const unit = input.metric === "soilEc" ? " μS/cm" : "";
  const summary = `肥液${metricLabel} ${value}${unit} ${direction === "above" ? "高于上限" : "低于下限"} ${threshold}${unit}，建议${spec.label}，调整幅度约 ${dosagePercent}%（保守建议，需人工确认后执行）`;
  return { metric: input.metric, direction, value, threshold, deviationRatio, kind, materialCode: spec.materialCode, dosagePercent, summary };
}