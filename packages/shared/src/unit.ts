/**
 * 面积单位换算。
 *
 * 平台对外统一以亩为面积单位，仅在空间计算与遥感分析环节使用平方米与公顷。
 * 换算函数集中在此，禁止在业务代码中手写系数——面积换算涉及乘除与精度取舍，
 * 各处自行实现会让同一地块在不同报表中相差几十平方米，且很难被肉眼发现。
 */

/** 每亩平方米数 */
export const SQUARE_METER_PER_MU = 666.6666666667;

/** 每公顷亩数 */
export const MU_PER_HECTARE = 15;

/**
 * 亩转平方米。
 * @param mu 亩数
 * @returns 平方米
 */
export function muToSquareMeter(mu: number): number {
  return mu * SQUARE_METER_PER_MU;
}

/**
 * 平方米转亩，保留四位小数。
 * @param m2 平方米
 * @returns 亩数
 */
export function squareMeterToMu(m2: number): number {
  return Math.round((m2 / SQUARE_METER_PER_MU) * 10000) / 10000;
}

/**
 * 公顷转亩。
 * @param ha 公顷
 * @returns 亩数
 */
export function hectareToMu(ha: number): number {
  return ha * MU_PER_HECTARE;
}
