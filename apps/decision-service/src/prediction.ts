import { EventTopic } from "@agri/contracts";
import type { EventTopicValue, PredictionAlertPayload } from "@agri/contracts";

import type { CreatePredictionInput, PredictionLevel, PredictionMetric, PredictionRepository } from "./prediction.repository.js";

/** 墒情历史序列点（时间升序，来自遥测 history/series） */
export interface SoilSeriesPoint {
  recordedAt: string;
  value: number;
}

/** 虫情识别记录（来自遥测 pests） */
export interface PestEventPoint {
  detectedAt: string;
  /** 发生等级：1 轻微、2 中等、3 严重 */
  level: 1 | 2 | 3;
  handled: boolean;
  pestType: string;
}

/** 逐日天气预报（来自气象服务 forecast） */
export interface ForecastDayPoint {
  date: string;
  rainProbability?: number;
  tempMin?: number;
  tempMax?: number;
}

/** 生育期档案（来自遥测 growth-stages） */
export interface GrowthStagePoint {
  stage: string;
  recordedAt?: string;
}

/** 预测所需外部数据，组合根注入真实 HTTP 实现，测试注入假数据 */
export interface PredictionFetchers {
  fetchPlotCodes(): Promise<string[]>;
  fetchSoilSeries(plotCode: string, fromIso: string, toIso: string): Promise<SoilSeriesPoint[]>;
  fetchPestEvents(plotCode: string): Promise<PestEventPoint[]>;
  fetchForecast(): Promise<ForecastDayPoint[]>;
  fetchGrowthStages(plotCode: string): Promise<GrowthStagePoint[]>;
}

/** 单个指标的推算结果 */
export interface PredictionOutcome {
  predictedValue: number;
  level: PredictionLevel;
  unit: string;
  basis: string;
  inputs: Record<string, unknown>;
  threshold?: number;
  direction?: "above" | "below";
}

/**
 * 预测口径参数。阈值默认值与既有补灌规则口径一致（含水率 30% 预警/20% 严重），
 * 均为启发式参数而非农艺权威口径，可按现场经 DECISION_PREDICTION_* 环境变量调整。
 */
export interface PredictionEngineOptions {
  /** 墒情预警阈值（%），默认 30 */
  soilWarningPct?: number;
  /** 墒情严重阈值（%），默认 20 */
  soilCriticalPct?: number;
  /** 降雨概率达到该值视为可能降雨，墒情降幅按零处理（启发式，默认 70） */
  rainSuppressProbability?: number;
  /** 虫害风险预警分，默认 40 */
  pestWarnScore?: number;
  /** 虫害风险严重分，默认 65 */
  pestCriticalScore?: number;
  /** 产量基线（千克/亩）；留空表示无农艺基线，产量预测保持数据不足不编数 */
  yieldBaselineKgMu?: number;
  /** 预测时距（小时），默认 24 */
  horizonHours?: number;
}

const HOUR_MS = 3600_000;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 最小二乘法求每小时斜率；样本不足或时间无差异时返回 0 */
function slopePerHour(series: SoilSeriesPoint[]): number {
  if (series.length < 2) return 0;
  const first = Date.parse(series[0]!.recordedAt);
  if (!Number.isFinite(first)) return 0;
  const times = series.map((point) => {
    const t = Date.parse(point.recordedAt);
    return Number.isFinite(t) ? (t - first) / HOUR_MS : 0;
  });
  const values = series.map((point) => point.value);
  const meanT = times.reduce((sum, t) => sum + t, 0) / times.length;
  const meanV = values.reduce((sum, v) => sum + v, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < times.length; i += 1) {
    numerator += (times[i]! - meanT) * (values[i]! - meanV);
    denominator += (times[i]! - meanT) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * 墒情预测：近窗口读数线性外推至预测时点。
 * 降雨概率达到抑制阈值时降幅按零处理——大概率降雨时不按持续干旱外推，避免误报补灌。
 * 样本不足两个点不外推，明确记数据不足。
 */
export function predictSoilMoisture(
  series: SoilSeriesPoint[],
  options: PredictionEngineOptions,
  rainProbability: number | undefined,
  horizonHours = options.horizonHours ?? 24,
): PredictionOutcome {
  const warning = options.soilWarningPct ?? 30;
  const critical = options.soilCriticalPct ?? 20;
  const suppress = options.rainSuppressProbability ?? 70;
  const last = series[series.length - 1];
  if (!last) {
    return { predictedValue: 0, level: "INSUFFICIENT_DATA", unit: "%", basis: "无历史墒情读数，无法外推趋势", inputs: { sampleCount: 0 } };
  }
  if (series.length < 2) {
    return {
      predictedValue: round(last.value, 2),
      level: "INSUFFICIENT_DATA",
      unit: "%",
      basis: `历史读数仅 ${series.length} 条，不足两条无法外推趋势`,
      inputs: { sampleCount: series.length, lastValue: round(last.value, 2) },
    };
  }
  const slope = slopePerHour(series);
  const effectiveSlope = slope < 0 && rainProbability !== undefined && rainProbability >= suppress ? 0 : slope;
  const predictedValue = round(clamp(last.value + effectiveSlope * horizonHours, 0, 100), 2);
  const hoursToWarning = effectiveSlope < 0 && last.value > warning ? round((last.value - warning) / (-effectiveSlope), 1) : 0;
  const level: PredictionLevel = predictedValue < critical ? "CRITICAL" : predictedValue < warning ? "WARNING" : "NORMAL";
  return {
    predictedValue,
    level,
    unit: "%",
    threshold: warning,
    direction: "below",
    basis: `近 ${series.length} 条读数，最新 ${round(last.value, 2)}%，趋势 ${round(slope, 4)}%/小时，降雨概率 ${rainProbability ?? "缺测"}，预测 ${horizonHours} 小时后 ${predictedValue}%`,
    inputs: {
      sampleCount: series.length,
      lastValue: round(last.value, 2),
      slopePerHour: round(slope, 4),
      effectiveSlopePerHour: round(effectiveSlope, 4),
      rainProbability,
      hoursToWarning,
    },
  };
}

/**
 * 虫害风险预测：近 7 天未处置记录密度 + 最严重等级 + 预报温度适宜度合成风险分。
 * 权重是启发式口径（非农艺权威），可在农艺确认后经参数替换为正式积温模型。
 */
export function predictPestRisk(
  events: PestEventPoint[],
  forecast: ForecastDayPoint[],
  options: PredictionEngineOptions,
  now = new Date(),
): PredictionOutcome {
  const warn = options.pestWarnScore ?? 40;
  const critical = options.pestCriticalScore ?? 65;
  const since = now.getTime() - 7 * 24 * HOUR_MS;
  const recent = events.filter((event) => !event.handled && Date.parse(event.detectedAt) >= since);
  const days = forecast.slice(0, 3);
  const temps = days.map((day) => (day.tempMin !== undefined && day.tempMax !== undefined ? (day.tempMin + day.tempMax) / 2 : undefined)).filter((t): t is number => t !== undefined);
  const forecastAvgTemp = temps.length > 0 ? round(temps.reduce((sum, t) => sum + t, 0) / temps.length, 1) : undefined;
  const maxLevel = recent.reduce((max, event) => Math.max(max, event.level), 1);
  const density = Math.min(recent.length * 15, 45);
  const severity = maxLevel >= 3 ? 25 : maxLevel === 2 ? 12 : 0;
  const tempSuitable = forecastAvgTemp !== undefined && forecastAvgTemp >= 18 && forecastAvgTemp <= 30 ? 15 : 0;
  const score = clamp(density + severity + tempSuitable, 0, 100);
  const level: PredictionLevel = score >= critical ? "CRITICAL" : score >= warn ? "WARNING" : "NORMAL";
  return {
    predictedValue: score,
    level,
    unit: "分",
    threshold: warn,
    direction: "above",
    basis: recent.length > 0
      ? `近 7 天未处置虫情 ${recent.length} 条（最高等级 ${maxLevel}），预报三日平均温度 ${forecastAvgTemp ?? "缺测"}℃，风险分 ${score}`
      : "近 7 天无虫情记录，保守判定为正常",
    inputs: { recentCount: recent.length, maxLevel, forecastAvgTemp, tempSuitable: tempSuitable > 0, density, severity, tempScore: tempSuitable },
  };
}

/** 生育期 → 季进度，启发式权重（非农艺权威口径），供产量估算按进度折算 */
const STAGE_PROGRESS: Record<string, number> = {
  SOIL_PREPARATION: 0.1,
  SEEDING: 0.2,
  SEEDLING: 0.35,
  VEGETATIVE: 0.6,
  REPRODUCTIVE: 0.85,
  MATURITY: 1,
};

/**
 * 产量预测：按生育期进度对农艺产量基线折算。
 * 无基线（农艺未提供）时明确记数据不足，不编一个产量数；
 * 产量只有估算没有阈值，不参与预警事件，只留痕供生产参考。
 */
export function predictYield(
  stages: GrowthStagePoint[],
  options: PredictionEngineOptions,
  horizonHours = options.horizonHours ?? 24,
): PredictionOutcome {
  const baseline = options.yieldBaselineKgMu;
  const latest = stages
    .slice()
    .sort((a, b) => (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""))
    .pop();
  const progress = latest ? STAGE_PROGRESS[latest.stage] : undefined;
  if (!baseline || baseline <= 0) {
    return {
      predictedValue: -1,
      level: "INSUFFICIENT_DATA",
      unit: "千克/亩",
      basis: "未配置农艺产量基线，不估算产量（DECISION_PREDICTION_YIELD_BASELINE_KG_MU）",
      inputs: { stage: latest?.stage, progress: progress ?? null },
    };
  }
  if (progress === undefined) {
    return {
      predictedValue: -1,
      level: "INSUFFICIENT_DATA",
      unit: "千克/亩",
      basis: `生育期「${latest?.stage ?? "未登记"}」未在进度口径内，不估算产量`,
      inputs: { stage: latest?.stage, progress: null },
    };
  }
  return {
    predictedValue: round(baseline * progress, 1),
    level: "NORMAL",
    unit: "千克/亩",
    basis: `生育期 ${latest.stage}（进度 ${round(progress * 100, 0)}%），基线 ${baseline} 千克/亩，预测 ${round(baseline * progress, 1)} 千克/亩`,
    inputs: { stage: latest.stage, progress, baseline },
  };
}

/** 预警事件发布器签名：组合根包一层 EventLogPublisher，测试注入假发布器 */
export type PredictionPublish = (topic: EventTopicValue, payload: unknown) => Promise<void>;

export interface PredictionSweeper {
  /** 立即执行一轮全量预测；进行中时复用当前轮次，不重叠 */
  runOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * 预测扫描器：按周期对全部地块推算墒情/虫害/产量并落库。
 * 幂等：同一预测窗口（地块+指标+时点）只落一条，插入成功且达到预警/严重级才发事件；
 * 单地块或发布失败只记日志不中断整轮。
 */
export function createPredictionSweeper(deps: {
  repository: PredictionRepository;
  fetchers: PredictionFetchers;
  tenantId: string;
  publish?: PredictionPublish;
  options?: PredictionEngineOptions;
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: Error, phase: string) => void;
}): PredictionSweeper {
  const options = deps.options ?? {};
  const horizonHours = options.horizonHours ?? 24;
  const now = deps.now ?? ((): Date => new Date());
  const onError = deps.onError ?? ((error: Error, phase: string): void => { console.error("[prediction] 扫描失败", { phase, message: error.message }); });
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const saveAndPublish = async (plotCode: string, metric: PredictionMetric, outcome: PredictionOutcome, predictedAt: Date): Promise<void> => {
    const input: CreatePredictionInput = {
      tenantId: deps.tenantId,
      plotCode,
      seasonId: "",
      metric,
      predictedAt: predictedAt.toISOString(),
      horizonHours,
      predictedValue: outcome.predictedValue,
      level: outcome.level,
      unit: outcome.unit,
      basis: outcome.basis,
      inputs: outcome.inputs,
      ...(outcome.threshold !== undefined ? { threshold: outcome.threshold } : {}),
      ...(outcome.direction !== undefined ? { direction: outcome.direction } : {}),
    };
    const { inserted } = await deps.repository.save(undefined, input);
    if (!inserted || (outcome.level !== "WARNING" && outcome.level !== "CRITICAL") || !deps.publish) return;
    const payload: PredictionAlertPayload = {
      parcelId: plotCode,
      seasonId: "",
      metric,
      level: outcome.level,
      predictedValue: outcome.predictedValue,
      unit: outcome.unit,
      ...(outcome.threshold !== undefined ? { threshold: outcome.threshold } : {}),
      ...(outcome.direction !== undefined ? { direction: outcome.direction } : {}),
      predictedAt: input.predictedAt,
      horizonHours,
      basis: outcome.basis,
    };
    await deps.publish(EventTopic.DecisionPredictionAlert, payload).catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error)), `publish:${plotCode}`));
  };

  const runForPlot = async (plotCode: string, current: Date, predictedAt: Date): Promise<void> => {
    const [forecast, soilSeries, pestEvents, stages] = await Promise.all([
      deps.fetchers.fetchForecast().catch(() => [] as ForecastDayPoint[]),
      deps.fetchers.fetchSoilSeries(plotCode, new Date(current.getTime() - 72 * HOUR_MS).toISOString(), current.toISOString()).catch(() => [] as SoilSeriesPoint[]),
      deps.fetchers.fetchPestEvents(plotCode).catch(() => [] as PestEventPoint[]),
      deps.fetchers.fetchGrowthStages(plotCode).catch(() => [] as GrowthStagePoint[]),
    ]);
    const soil = predictSoilMoisture(soilSeries, options, forecast[0]?.rainProbability, horizonHours);
    await saveAndPublish(plotCode, "SOIL_MOISTURE", soil, predictedAt);
    const pest = predictPestRisk(pestEvents, forecast, options, current);
    await saveAndPublish(plotCode, "PEST_RISK", pest, predictedAt);
    const yieldOutcome = predictYield(stages, options, horizonHours);
    await saveAndPublish(plotCode, "YIELD", yieldOutcome, predictedAt);
  };

  const runOnce = async (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const current = now();
      const predictedAt = new Date(current.getTime() + horizonHours * HOUR_MS);
      const plotCodes = await deps.fetchers.fetchPlotCodes().catch((error: unknown) => {
        onError(error instanceof Error ? error : new Error(String(error)), "plots");
        return [] as string[];
      });
      for (const plotCode of plotCodes) {
        try {
          await runForPlot(plotCode, current, predictedAt);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)), `plot:${plotCode}`);
        }
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };

  return {
    runOnce,
    start(): void {
      void runOnce();
      timer = setInterval(() => { void runOnce(); }, deps.intervalMs ?? 21_600_000);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
