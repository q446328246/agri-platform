/**
 * 农场日历日口径：业务按东八区过日子，而服务容器时区是 UTC。
 * 取日必须固定偏移，否则和风返回的 "2026-11-09T00:00+08:00" 会被算成 11-08，整周预报前移一天。
 */
const FARM_UTC_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** 任意时刻/时间串 → 农场所在时区的 YYYY-MM-DD；无法解析时退回原串前 10 位 */
export function farmDate(value: Date | string | number = new Date()): string {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value).slice(0, 10);
  return new Date(ms + FARM_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** 农场今天的日历日 */
export function farmToday(): string {
  return farmDate(new Date());
}

/** 相对 from 偏移若干天的农场日历日，东八区无夏令时，按固定毫秒偏移即可 */
export function farmDateOffset(days: number, from: Date = new Date()): string {
  return farmDate(new Date(from.getTime() + days * DAY_MS));
}

const PURE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 纯日期 → 该农场日（东八区）起点的 UTC 时刻；已是完整时间串则原样透传 */
export function farmDayStart(value: string): string {
  return PURE_DATE.test(value) ? new Date(`${value}T00:00:00+08:00`).toISOString() : value;
}

/** 纯日期 → 该农场日（东八区）末尾的 UTC 时刻；已是完整时间串则原样透传 */
export function farmDayEnd(value: string): string {
  return PURE_DATE.test(value) ? new Date(`${value}T23:59:59.999+08:00`).toISOString() : value;
}