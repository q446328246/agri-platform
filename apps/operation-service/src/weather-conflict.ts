import type { TaskType } from "./task.repository.js";

/**
 * 任务排程的天气冲突提示（开发方案 8.4「预报有较强降雨自动推迟灌溉」与
 * 8.7「任务时间与天气条件冲突时自动提示调整」）。
 *
 * 口径：只提示不阻断，与排程冲突同一处置哲学；预报按农场日历日（东八区）
 * 与任务计划时间窗求交，窗内每个命中日按作业类型给出不宜/推迟缘由。
 * 阈值与 weather-service/weather.ts 的 ADVISE_THRESHOLDS 同源（方案 9.4 联动
 * 策略表），两处修改须同步；判定逻辑独立实现，不跨服务引用源码。
 * 预报缺测（服务不可用/未配数据源）时返回空数组，绝不假定「无冲突」。
 */

/** 日预报快照：字段与 weather-service 的 WeatherForecastDay 同名同义，只取判定所需要素 */
export interface ForecastDaySnapshot {
  /** 农场日历日 YYYY-MM-DD */
  date: string;
  weather: string;
  tempMin: number;
  tempMax: number;
  windLevel: number;
  windSpeed: number;
  rainProbability: number;
  rainAmount: number;
}

/** 一条天气冲突：命中日的预报概况与不宜缘由 */
export interface WeatherConflict {
  date: string;
  weather: string;
  level: "WARNING" | "CRITICAL";
  reasons: string[];
}

/** 适宜性阈值：与 weather-service/weather.ts ADVISE_THRESHOLDS 同口径，修改须两处同步 */
export const WEATHER_CONFLICT_THRESHOLDS = {
  /** 降雨概率达到该值（%）视为有明显降雨，推迟灌溉施肥 */
  rainHoldProbability: 50,
  /** 预报雨量达到该值（mm）同样视为明显降雨 */
  rainHoldAmount: 8,
  /** 风速超过该值（m/s）不宜喷药 */
  windSprayMax: 8,
  /** 风力达到该级（级）不宜喷药 */
  windSprayLevel: 4,
  /** 最高温超过该值（°C）喷药易蒸发失效，避开午间 */
  tempSprayMax: 33,
  /** 最低温低于该值（°C）有冻害风险，影响播种出苗 */
  tempLow: 5,
} as const;

/** 农场日历日固定东八区，与 weather-service/farm-time.ts 同一口径（容器时区是 UTC） */
const FARM_UTC_OFFSET_MS = 8 * 3_600_000;
function farmDateOf(ms: number): string {
  return new Date(ms + FARM_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 天气冲突判定纯函数：任务计划窗 [开始, 结束 ?? 开始] 与预报日求交，
 * 逐日按作业类型判定。没排时间或时间非法不判（不猜）；预报未覆盖的日期不判。
 */
export function weatherConflictsOf(
  type: TaskType,
  scheduledAt: string | undefined,
  scheduledEndAt: string | undefined,
  days: ForecastDaySnapshot[],
): WeatherConflict[] {
  if (!scheduledAt) return [];
  const start = Date.parse(scheduledAt);
  const end = Date.parse(scheduledEndAt ?? scheduledAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const startDay = farmDateOf(start);
  const endDay = farmDateOf(end);
  const t = WEATHER_CONFLICT_THRESHOLDS;
  const hits: WeatherConflict[] = [];
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || day.date < startDay || day.date > endDay) continue;
    const rainy = day.rainProbability >= t.rainHoldProbability || day.rainAmount >= t.rainHoldAmount;
    const windy = day.windSpeed > t.windSprayMax || day.windLevel >= t.windSprayLevel;
    const reasons: string[] = [];
    let critical = false;
    if (type === "IRRIGATION" && rainy) {
      reasons.push(`预报${day.weather}（降雨概率 ${day.rainProbability}%、雨量 ${day.rainAmount} mm），建议推迟灌溉，避免浇了又下雨`);
    }
    if (type === "FERTILIZATION" && rainy) {
      reasons.push("预报有明显降雨，施肥建议顺延至雨止田干，避免肥料随水流失");
    }
    if (type === "SPRAYING") {
      if (windy) {
        critical = true;
        reasons.push(`风速 ${day.windSpeed} m/s、风力 ${day.windLevel} 级，超过喷药适宜阈值，药液易飘移，建议改期`);
      }
      if (rainy) reasons.push("预报降雨会冲刷药液，建议改期喷防");
      if (day.tempMax > t.tempSprayMax) reasons.push(`最高温 ${day.tempMax}°C 偏热，建议避开 11:00-16:00，选上午 10 点前或傍晚喷药`);
    }
    if ((type === "TILLAGE" || type === "SEEDING" || type === "WEEDING") && rainy) {
      reasons.push(`预报${day.weather}，田间泥泞影响机具通行与作业质量，建议改期`);
    }
    if (type === "SEEDING" && day.tempMin <= t.tempLow) {
      reasons.push(`最低气温 ${day.tempMin}°C，低温冻害风险影响出苗，建议避开低温时段播种`);
    }
    if (reasons.length > 0) hits.push({ date: day.date, weather: day.weather, level: critical ? "CRITICAL" : "WARNING", reasons });
  }
  return hits.sort((a, b) => a.date.localeCompare(b.date));
}

/** 预报要素取数：非法/缺测要素按 0 兜底会伪造「无雨无风」，这里整条跳过，宁缺勿造 */
function toSnapshot(value: unknown): ForecastDaySnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || typeof row.weather !== "string") return undefined;
  const numbers = ["tempMin", "tempMax", "windLevel", "windSpeed", "rainProbability", "rainAmount"] as const;
  const snapshot: Record<string, number> = {};
  for (const key of numbers) {
    const parsed = Number(row[key]);
    if (!Number.isFinite(parsed)) return undefined;
    snapshot[key] = parsed;
  }
  return { date: row.date, weather: row.weather, tempMin: snapshot.tempMin!, tempMax: snapshot.tempMax!, windLevel: snapshot.windLevel!, windSpeed: snapshot.windSpeed!, rainProbability: snapshot.rainProbability!, rainAmount: snapshot.rainAmount! };
}

/**
 * 从 weather-service 取七日预报快照（与决策侧 fetchRainProbability 同一接入模式）：
 * 透传身份头、2 秒超时、失败返回 undefined 由调用方按缺测处理。
 * 前端预报只读本地库，这里不直连外部 API；七日之外的排程预报未覆盖，诚实不提示。
 */
export function createWeatherForecastFetcher(weatherUrl: string): (identity: Record<string, string>) => Promise<ForecastDaySnapshot[] | undefined> {
  return async (identity) => {
    try {
      const res = await fetch(`${weatherUrl}/api/v1/weather/forecast?days=7`, { headers: identity, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { forecast?: unknown } };
      if (!Array.isArray(json.data?.forecast)) return undefined;
      return json.data!.forecast!.map(toSnapshot).filter((item): item is ForecastDaySnapshot => item !== undefined);
    } catch {
      return undefined;
    }
  };
}