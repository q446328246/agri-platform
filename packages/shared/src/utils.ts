import { ValidationError } from "./errors.js";

/** 空值判定，仅 null 与 undefined 视为空，空字符串与 0 不算 */
export function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * 剔除值为 undefined 的字段，避免把未设置字段序列化到响应中。
 * @param obj 源对象
 * @returns 新对象
 */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key as keyof T] = value as T[keyof T];
    }
  }
  return result;
}

/**
 * 断言非空，失败时抛出校验异常并带上字段名。
 * @param value 待断言值
 * @param field 字段名
 * @returns 非空值
 */
export function assertDefined<T>(value: T | null | undefined, field: string): T {
  if (isNil(value)) {
    throw new ValidationError(`字段 ${field} 不能为空`, [{ field, reason: "required" }]);
  }
  return value;
}

/**
 * 数组分片，用于批量写入与批量查询。
 * @param items 源数组
 * @param size 每片长度
 * @returns 分片后的二维数组
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new ValidationError("分片长度必须为正整数");
  }
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * 把用户输入的关键词包成 ILIKE 模式。
 * `%` 与 `_` 是 LIKE 的通配符，不转义的话一个「%」就能把整表捞出来，
 * 而内存实现按字面量子串匹配，同一个关键词两套模式结果不同。
 */
export function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * 内存实现的关键词命中判定，与 SQL 的 `f1 ILIKE 模式 OR f2 ILIKE 模式 …` 同口径：
 * 每个字段各自做大小写不敏感的字面量子串匹配，而不是把字段拼起来再找。
 * 拼接会造出跨字段的假命中（前一个字段的尾巴接上后一个字段开头），分页列表在两套模式下就会给出不同结果。
 */
export function keywordHits(keyword: string, fields: Array<string | undefined>): boolean {
  const needle = keyword.toLowerCase();
  return fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));
}

/**
 * 异步等待。
 * @param ms 毫秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
