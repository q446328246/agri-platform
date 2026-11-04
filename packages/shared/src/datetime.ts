/**
 * 日期与时间工具。
 *
 * 全平台时间统一以 ISO 8601 UTC 字符串传递，展示层按客户端时区转换，
 * 时区转换不在服务侧完成，避免同一时刻在不同服务中表述不一致。
 */

/** 业务默认时区：业务日按东八区划分 */
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

/**
 * 格式化为 ISO 8601 UTC 字符串。
 * @param input 日期、时间戳或可解析字符串
 * @returns 形如 2026-11-02T06:30:00.000Z 的字符串
 */
export function toUtcIso(input: Date | number | string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`无法解析为有效时间：${String(input)}`);
  }
  return date.toISOString();
}

/**
 * 安全解析日期，非法输入返回 null 而不抛出。
 * @param input 待解析字符串
 * @returns 日期对象或 null
 */
export function parseDate(input: string): Date | null {
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

type Ymd = { year: number; month: number; day: number };

function zonedParts(timestamp: number, timeZone: string): Ymd & { hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return {
    year: Number(map["year"]),
    month: Number(map["month"]),
    day: Number(map["day"]),
    hour: Number(map["hour"]),
    minute: Number(map["minute"]),
    second: Number(map["second"]),
  };
}

/** 取某时刻在指定时区相对 UTC 的偏移（毫秒） */
function zoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = zonedParts(timestamp, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - timestamp;
}

/** 把指定时区的墙上时间换算为 UTC 时间戳 */
function zonedTimeToTimestamp(ymd: Ymd, timeZone: string): number {
  const guess = Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, 0, 0);
  return guess - zoneOffsetMs(guess, timeZone);
}

/**
 * 取某日零点到次日零点区间，按指定时区计算。
 * 业务日边界统一走本函数，禁止各服务手写时间边界。
 * @param date 基准日期或可解析字符串
 * @param timeZone 时区，默认东八区
 * @returns 起止时间，均为 ISO 8601 UTC 字符串
 */
export function dayRange(date: Date | string, timeZone = DEFAULT_TIME_ZONE): { start: string; end: string } {
  const base = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(base.getTime())) {
    throw new TypeError(`无法解析为有效时间：${String(date)}`);
  }
  const parts = zonedParts(base.getTime(), timeZone);
  const startMs = zonedTimeToTimestamp(
    { year: parts.year, month: parts.month, day: parts.day },
    timeZone,
  );
  const endMs = zonedTimeToTimestamp(
    { year: parts.year, month: parts.month, day: parts.day + 1 },
    timeZone,
  );
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}
