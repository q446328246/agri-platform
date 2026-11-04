import { describe, expect, it } from "vitest";

import {
  assertDefined,
  BizError,
  chunk,
  dayRange,
  DEFAULT_TIME_ZONE,
  hectareToMu,
  muToSquareMeter,
  omitUndefined,
  snowflakeId,
  squareMeterToMu,
  toPageResult,
  ulid,
  ValidationError,
} from "../src/index.js";

/**
 * 共享工具包的契约测试。
 * 重点覆盖单位换算与时间窗口——这两处出错不会抛异常，只会静默产出错误数值。
 */
describe("共享工具", () => {
  it("分页结果自动计算总页数并修正边界", () => {
    expect(toPageResult({ items: [1, 2], total: 5, page: 1, size: 2 }).pages).toBe(3);
    expect(toPageResult({ items: [], total: 0, page: 0, size: 0 }).page).toBe(1);
    expect(toPageResult({ items: [], total: 0, page: 0, size: 0 }).size).toBe(1);
  });

  it("单位换算符合亩与公顷的定义", () => {
    expect(muToSquareMeter(1)).toBeCloseTo(666.6666666667, 6);
    expect(squareMeterToMu(666.6666666667)).toBeCloseTo(1, 9);
    expect(hectareToMu(1)).toBe(15);
    // 15 亩即 1 公顷，两条换算路径必须一致
    expect(muToSquareMeter(hectareToMu(1))).toBeCloseTo(10000, 6);
  });

  it("按东八区切分自然日", () => {
    const { start, end } = dayRange("2026-05-01T00:00:00Z", DEFAULT_TIME_ZONE);
    expect(Date.parse(end) - Date.parse(start)).toBe(86400000);
    expect(new Date(start).toISOString()).toBe(start);
    expect(Date.parse(start)).toBeLessThan(Date.parse(end));
    expect(() => dayRange("不是时间")).toThrow(TypeError);
  });

  it("标识生成符合约定：事件用 26 位 ULID、主键用雪花字符串", () => {
    const first = ulid();
    expect(first).toHaveLength(26);
    expect(ulid()).not.toBe(first);

    const id = snowflakeId();
    expect(id).toMatch(/^\d+$/);
    expect(BigInt(id)).toBeGreaterThan(0n);
  });

  it("工具函数在边界输入下行为明确", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(omitUndefined({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(() => assertDefined(null, "地块编码")).toThrow(BizError);
    expect(assertDefined("511723-000001-01-00001-0000-5", "地块编码")).toBe("511723-000001-01-00001-0000-5");
  });

  it("业务异常携带错误码与状态码", () => {
    const error = new ValidationError("参数不合法", [{ field: "areaMu", reason: "必须大于 0" }]);
    expect(error.code).toBe("SYS-400-001");
    expect(error.httpStatus).toBe(400);
    expect(error.details?.[0]?.field).toBe("areaMu");
  });
});
