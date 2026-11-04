/**
 * 可控时钟。
 *
 * 涉及时间窗口的逻辑（如遥测去重窗口、处方有效期、生育期推算）如果依赖
 * 真实时间，测试会变得不稳定且难以覆盖边界。因此统一提供可推进的时钟，
 * 需要时间的代码从上下文取时间，而不是直接读取系统时间。
 */

/** 可控时钟 */
export class MockClock {
  private currentMs: number;

  private frozen = false;

  constructor(initial: string | number | Date = "2026-01-01T00:00:00.000Z") {
    this.currentMs = toMillis(initial);
  }

  /** 当前时间 */
  now(): Date {
    return new Date(this.currentMs);
  }

  /** 当前时间戳（毫秒） */
  nowMs(): number {
    return this.currentMs;
  }

  /** 当前时间，ISO 8601 UTC 字符串 */
  nowIso(): string {
    return this.now().toISOString();
  }

  /** 向前推进指定毫秒 */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error("时钟只能向前推进");
    }
    this.currentMs += ms;
  }

  /** 推进到指定时刻 */
  set(target: string | number | Date): void {
    this.currentMs = toMillis(target);
  }

  /**
   * 接管全局定时器时间，使依赖真实时间的代码（Date.now、定时器）也走本时钟。
   * @returns 恢复函数，测试结束时务必调用
   */
  freeze(): () => void {
    if (this.frozen) {
      throw new Error("时钟已处于接管状态");
    }
    this.frozen = true;
    const realNow = Date.now;
    const clock = this;
    Date.now = () => clock.currentMs;
    return () => {
      Date.now = realNow;
      clock.frozen = false;
    };
  }
}

function toMillis(value: string | number | Date): number {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`无法解析时间：${value}`);
  }
  return parsed;
}

/**
 * 创建并接管时钟。
 * @param initial 初始时刻
 * @returns 时钟实例
 */
export function freezeTime(initial: string | number | Date = "2026-01-01T00:00:00.000Z"): MockClock {
  return new MockClock(initial);
}
