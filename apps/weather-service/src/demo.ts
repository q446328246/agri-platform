import type { WeatherForecastDay, WeatherHourlyPoint } from "./forecast.repository.js";
import type { WeatherAlert } from "./alert.repository.js";

/**
 * 天气演示种子：与迁移 012_weather_forecast.sql 的演示数据同一口径，
 * 供未启用数据库的本地模式使用，也用于 SQL 模式下表为空时的回填。
 * 时间全部相对当前时刻锚定，保证任何时候启动都有「今天起五日」与「未来 48 小时」。
 */

const CITY = "达州市";

/** 五日天气现象与雨量安排：第 3 天安排一场明显降雨，用于演示「暂缓灌溉」提示 */
const DAY_PLAN: Array<{ weather: string; tempMin: number; tempMax: number; windDirection: string; windLevel: number; windSpeed: number; rainProbability: number; rainAmount: number }> = [
  { weather: "多云", tempMin: 21, tempMax: 31, windDirection: "东南风", windLevel: 2, windSpeed: 3.4, rainProbability: 24, rainAmount: 0 },
  { weather: "晴", tempMin: 22, tempMax: 33, windDirection: "南风", windLevel: 2, windSpeed: 2.8, rainProbability: 18, rainAmount: 0 },
  { weather: "中雨", tempMin: 20, tempMax: 27, windDirection: "北风", windLevel: 4, windSpeed: 8.6, rainProbability: 82, rainAmount: 24 },
  { weather: "阵雨", tempMin: 19, tempMax: 26, windDirection: "西北风", windLevel: 3, windSpeed: 5.2, rainProbability: 61, rainAmount: 9 },
  { weather: "多云", tempMin: 20, tempMax: 29, windDirection: "东风", windLevel: 2, windSpeed: 3.1, rainProbability: 30, rainAmount: 0 },
];

/** 逐小时天气现象：降雨日按 08-20 点为主雨段，其余时段多云 */
function hourlyWeather(dayIndex: number, hour: number): string {
  if (dayIndex === 2) return hour >= 8 && hour <= 20 ? "中雨" : "小雨";
  if (dayIndex === 3) return hour >= 12 && hour <= 18 ? "阵雨" : "多云";
  return dayIndex === 1 ? "晴" : "多云";
}

/** 取日预报安排并夹在有效范围内（索引越界时回落末日） */
function planOf(index: number): (typeof DAY_PLAN)[number] {
  return DAY_PLAN[Math.min(DAY_PLAN.length - 1, Math.max(0, index))]!;
}

/** 逐小时温度：日出前后（5 点）最低、午后（14 点）最高，按正弦插值 */
function hourlyTemperature(hour: number, tempMin: number, tempMax: number): number {
  const ratio = (Math.sin(((hour - 8) / 24) * Math.PI * 2) + 1) / 2;
  return Number((tempMin + (tempMax - tempMin) * ratio).toFixed(1));
}

/** 未来五日预报（含当天），date 为 YYYY-MM-DD */
export function demoForecastDays(now = new Date()): WeatherForecastDay[] {
  const refreshedAt = now.toISOString();
  return DAY_PLAN.map((plan, index) => {
    const date = new Date(now.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return { id: `wx-day-demo-${index + 1}`, date, city: CITY, refreshedAt, ...plan };
  });
}

/** 未来 48 小时逐时预报，从当前整点开始 */
export function demoForecastHours(now = new Date()): WeatherHourlyPoint[] {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  const refreshedAt = start.toISOString();
  return Array.from({ length: 48 }, (_, index) => {
    const at = new Date(start.getTime() + index * 3_600_000);
    const dayIndex = Math.min(4, Math.floor((at.getTime() - now.getTime() + 3_600_000 * 12) / 86_400_000));
    const plan = planOf(dayIndex);
    const hour = at.getHours();
    const rainySlot = plan.rainProbability >= 60 && (plan.weather === "中雨" ? hour >= 7 && hour <= 21 : hour >= 11 && hour <= 19);
    return {
      id: `wx-hour-demo-${index + 1}`,
      hourAt: at.toISOString(),
      weather: hourlyWeather(dayIndex, hour),
      temperature: hourlyTemperature(hour, plan.tempMin, plan.tempMax),
      humidity: Math.round(Math.min(96, plan.rainProbability + 34 + (hour >= 10 && hour <= 16 ? -8 : 6))),
      windSpeed: Number((plan.windSpeed * (rainySlot ? 1.15 : 0.9)).toFixed(1)),
      rainProbability: rainySlot ? Math.min(95, plan.rainProbability + 8) : Math.max(5, Math.round(plan.rainProbability * 0.5)),
      refreshedAt,
    };
  });
}

/** 活跃与已过期的气象预警：与文档 6.4 灾情三级口径一致 */
export function demoAlerts(now = new Date()): WeatherAlert[] {
  const iso = (offsetHours: number): string => new Date(now.getTime() + offsetHours * 3_600_000).toISOString();
  return [
    {
      id: "wx-alert-demo-1", alertCode: "WX-RAINSTORM-DEMO-1", alertType: "RAINSTORM", level: "CRITICAL", color: "橙",
      title: "暴雨橙色预警", description: "未来 24 小时累计降雨量将达 50 mm 以上，请提前疏通排水沟渠，暂停田间作业",
      city: CITY, plotCode: "", issuedAt: iso(-2), expiresAt: iso(22), active: true,
    },
    {
      id: "wx-alert-demo-2", alertCode: "WX-WIND-DEMO-2", alertType: "WIND", level: "WARNING", color: "黄",
      title: "大风黄色预警", description: "阵风可达 7 级，无人机植保与喷灌作业暂停，注意加固设施棚膜",
      city: CITY, plotCode: "", issuedAt: iso(-1), expiresAt: iso(14), active: true,
    },
    {
      id: "wx-alert-demo-3", alertCode: "WX-HOT-DEMO-3", alertType: "HIGH_TEMP", level: "WARNING", color: "黄",
      title: "高温黄色预警", description: "连续三日最高气温超过 33°C，注意灌溉时段选择傍晚，防止作物热害",
      city: CITY, plotCode: "511723-000001-01-00001-0000-5", issuedAt: iso(-30), expiresAt: iso(-6), active: true,
    },
    {
      id: "wx-alert-demo-4", alertCode: "WX-THUNDER-DEMO-4", alertType: "THUNDER", level: "INFO", color: "蓝",
      title: "雷电蓝色预警（已解除）", description: "雷雨云团已东移，田间作业恢复正常",
      city: CITY, plotCode: "", issuedAt: iso(-52), expiresAt: iso(-28), active: false,
    },
  ];
}
