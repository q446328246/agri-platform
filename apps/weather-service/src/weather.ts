import type { WeatherForecastDay, WeatherHourlyPoint } from "./forecast.repository.js";
import type { WeatherAlert } from "./alert.repository.js";

/**
 * 天气业务规则：对应文档 5.3「农事作业提示」、6.5「田间气象站」、9.4「与墒情、气象的联动策略」。
 * 要素目录、作业适宜性判定与演示种子集中在此，保证接口、前端与冒烟脚本同一口径。
 */

/** 田间气象站监测要素（文档 6.5 表格），key 与 telemetry 读数指标同源 */
export interface WeatherMetricMeta {
  key: string;
  label: string;
  unit: string;
  /** 展示用途，对应文档「应用场景」列 */
  scene: string;
}

export const WEATHER_METRICS: readonly WeatherMetricMeta[] = [
  { key: "airTemperature", label: "空气温度", unit: "°C", scene: "判断作物生长适温期，预警高温与低温冻害" },
  { key: "airHumidity", label: "空气湿度", unit: "%", scene: "结合温度评估病害发生风险" },
  { key: "rainfall", label: "降雨量", unit: "mm", scene: "判断自然降水对灌溉需求的补充程度" },
  { key: "co2Concentration", label: "二氧化碳浓度", unit: "ppm", scene: "评估群体光合条件，辅助精准通风与施肥决策" },
  { key: "oxygen", label: "氧气含量", unit: "%", scene: "反映田间小环境状况，用于设施场景环境调控" },
  { key: "windDirection", label: "风向", unit: "°", scene: "指导喷药作业时机，避免药液飘移" },
  { key: "windSpeed", label: "风速", unit: "m/s", scene: "评估倒伏与设施风险，判断是否适宜喷药" },
  { key: "lightIntensity", label: "光照强度", unit: "lux", scene: "评估光合有效辐射，辅助密植与化控决策" },
] as const;

/** 作业适宜性阈值：与文档 9.4 联动策略表一致，可按需调整 */
export const ADVISE_THRESHOLDS = {
  /** 未来 24 小时降雨概率达到该值（%）视为有中雨以上，推迟灌溉施肥 */
  rainHoldProbability: 50,
  /** 未来 24 小时预报雨量达到该值（mm）同样视为明显降雨 */
  rainHoldAmount: 8,
  /** 风速超过该值（m/s）暂停喷灌与无人机植保 */
  windSprayMax: 8,
  /** 风力超过该级（级）不宜喷药 */
  windSprayLevel: 4,
  /** 温度高于该值（°C）不宜喷药，蒸发快、药液易失效 */
  tempSprayMax: 33,
  /** 温度低于该值（°C）注意低温冻害 */
  tempLow: 5,
  /** 连续晴热：最高温连续高于该值（°C）且无有效降雨 */
  hotDayTemp: 30,
} as const;

/** 农事作业建议（文档 5.3「适宜 / 不宜」提示） */
export interface WeatherAdviceItem {
  operation: "IRRIGATION" | "FERTILIZATION" | "SPRAYING" | "RECRUIT" | "DRAINAGE";
  /** SUSPEND=不宜/暂缓，DELAY=推迟，ATTENTION=需注意，OK=适宜 */
  suggest: "OK" | "DELAY" | "SUSPEND" | "ATTENTION";
  level: "INFO" | "WARNING" | "CRITICAL";
  reason: string;
}

/** 逐要素的适宜性判定结果 */
export interface OperationJudge {
  operation: WeatherAdviceItem["operation"];
  label: string;
  suitable: boolean;
  reasons: string[];
}

const DAY_NAMES = ["灌溉", "施肥", "喷药", "无人机上田", "排涝准备"];
const OPERATION_BY_INDEX = ["IRRIGATION", "FERTILIZATION", "SPRAYING", "RECRUIT", "DRAINAGE"] as const;

/** 取未来 N 小时窗口内的最大降雨概率、累计雨量与最大风速 */
export function summarizeHours(hours: WeatherHourlyPoint[], hours48 = 24): { rainProbability: number; rainAmount: number; windSpeed: number; maxTemp: number; minTemp: number } {
  const window = hours.slice(0, hours48);
  if (window.length === 0) return { rainProbability: 0, rainAmount: 0, windSpeed: 0, maxTemp: 0, minTemp: 0 };
  const rainAmount = window.reduce((sum, item) => sum + (item.rainProbability >= 40 ? Math.max(0.5, item.rainProbability / 12) : 0), 0);
  const temps = window.map((item) => item.temperature);
  return {
    rainProbability: Math.max(...window.map((item) => item.rainProbability)),
    rainAmount: Number(rainAmount.toFixed(1)),
    windSpeed: Math.max(...window.map((item) => item.windSpeed)),
    maxTemp: Math.max(...temps),
    minTemp: Math.min(...temps),
  };
}

/**
 * 生成农事作业建议：输入未来五日预报与逐小时预报。
 * 优先用逐小时数据判断 24 小时窗口，无逐小时数据时退回日粒度预报（保证内存与 SQL 两种模式口径一致）。
 */
export function buildAdvice(days: WeatherForecastDay[], hours: WeatherHourlyPoint[], city = "达州市"): { city: string; headline: string; items: WeatherAdviceItem[]; judges: OperationJudge[] } {
  const today = days[0];
  const next24 = days.slice(0, 1);
  const rainProbability = hours.length > 0 ? summarizeHours(hours, 24).rainProbability : Math.max(...next24.map((day) => day.rainProbability), 0);
  const rainAmount = hours.length > 0
    ? summarizeHours(hours, 24).rainAmount
    : Number(next24.reduce((sum, day) => sum + day.rainAmount, 0).toFixed(1));
  const windSpeed = hours.length > 0 ? summarizeHours(hours, 24).windSpeed : Math.max(...next24.map((day) => day.windSpeed), 0);
  const windLevel = Math.max(...next24.map((day) => day.windLevel), 0);
  const maxTemp = today ? today.tempMax : summarizeHours(hours, 24).maxTemp;
  const minTemp = today ? today.tempMin : summarizeHours(hours, 24).minTemp;

  const rainy = rainProbability >= ADVISE_THRESHOLDS.rainHoldProbability || rainAmount >= ADVISE_THRESHOLDS.rainHoldAmount;
  const windy = windSpeed > ADVISE_THRESHOLDS.windSprayMax || windLevel >= ADVISE_THRESHOLDS.windSprayLevel;
  const hot = maxTemp >= ADVISE_THRESHOLDS.hotDayTemp && !rainy;
  const cold = minTemp <= ADVISE_THRESHOLDS.tempLow;

  const items: WeatherAdviceItem[] = [];
  if (rainy) {
    items.push({
      operation: "IRRIGATION", suggest: "DELAY", level: "WARNING",
      reason: `未来 24 小时降雨概率 ${rainProbability}%、预计雨量 ${rainAmount} mm，建议暂缓灌溉，减少水肥浪费`,
    });
    items.push({
      operation: "FERTILIZATION", suggest: "DELAY", level: "WARNING",
      reason: `预报有明显降雨，施肥顺延至雨止田干，避免肥料随水流失`,
    });
  } else {
    items.push({
      operation: "IRRIGATION", suggest: hot ? "ATTENTION" : "OK", level: hot ? "WARNING" : "INFO",
      reason: hot ? `连续晴热（最高 ${maxTemp}°C）且无明显降雨，注意墒情变化，建议傍晚时段补水` : "未来 24 小时无明显降雨，可按墒情安排灌溉",
    });
    items.push({ operation: "FERTILIZATION", suggest: "OK", level: "INFO", reason: "天气条件适宜施肥，结合灌溉分次施用" });
  }
  if (windy) {
    items.push({
      operation: "SPRAYING", suggest: "SUSPEND", level: "CRITICAL",
      reason: `风速 ${windSpeed} m/s、风力 ${windLevel} 级，超过喷灌适宜阈值，暂停喷药与无人机植保，规避药液飘移`,
    });
    items.push({ operation: "RECRUIT", suggest: "SUSPEND", level: "WARNING", reason: "大风条件下无人机不宜起飞" });
  } else if (maxTemp > ADVISE_THRESHOLDS.tempSprayMax) {
    items.push({
      operation: "SPRAYING", suggest: "ATTENTION", level: "WARNING",
      reason: `最高温 ${maxTemp}°C 偏热，建议避开 11:00-16:00，选择上午 10 点前或傍晚喷药`,
    });
    items.push({ operation: "RECRUIT", suggest: "OK", level: "INFO", reason: "风速风力在安全范围内，可安排无人机作业" });
  } else {
    items.push({ operation: "SPRAYING", suggest: "OK", level: "INFO", reason: `风速 ${windSpeed} m/s，适宜喷药作业` });
    items.push({ operation: "RECRUIT", suggest: "OK", level: "INFO", reason: "风条件良好，可安排无人机植保" });
  }
  if (cold) {
    items.push({ operation: "DRAINAGE", suggest: "ATTENTION", level: "WARNING", reason: `最低气温 ${minTemp}°C，注意低温冻害，提前灌水保温或覆盖` });
  }
  if (rainProbability >= 80) {
    items.push({ operation: "DRAINAGE", suggest: "ATTENTION", level: "CRITICAL", reason: "强降雨临近，提前检查排水沟渠，防止农田渍涝" });
  }

  const judges: OperationJudge[] = OPERATION_BY_INDEX.map((operation, index) => {
    const related = items.filter((item) => item.operation === operation);
    const bad = related.some((item) => item.suggest === "SUSPEND" || item.suggest === "DELAY");
    return { operation, label: DAY_NAMES[index] ?? operation, suitable: !bad, reasons: related.map((item) => item.reason) };
  });

  const worst = items.filter((item) => item.level !== "INFO").sort((a, b) => (a.level === "CRITICAL" ? 0 : 1) - (b.level === "CRITICAL" ? 0 : 1))[0];
  const headline = worst ? worst.reason : `${city}天气平稳，灌溉、施肥、喷药均可正常安排`;
  return { city, headline, items, judges };
}

/** 预警是否仍在有效期（用于接口默认过滤） */
export function isAlertActive(alert: WeatherAlert, now = new Date()): boolean {
  if (!alert.active) return false;
  return !alert.expiresAt || Date.parse(alert.expiresAt) > now.getTime();
}
