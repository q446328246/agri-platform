/**
 * 六段式编码的段定义与常量。
 *
 * 编码向上兼容行政区划体系，向下可细化到作业网格，因此能同时满足
 * 小农户「一地块一编号」与规模主体「一网格一编号」的管理需求，
 * 是平台不限规模特性的重要基础。
 */

/** 六段式的段名与长度，顺序即编码顺序 */
export const PLOT_CODE_SEGMENTS = [
  { key: "region", label: "行政区划码", length: 6 },
  { key: "farm", label: "农场代码", length: 6 },
  { key: "area", label: "片区号", length: 2 },
  { key: "parcel", label: "地块序号", length: 5 },
  { key: "grid", label: "网格号", length: 4 },
  { key: "check", label: "校验位", length: 1 },
] as const;

/** 有效字符总长度：6+6+2+5+4+1，不含 5 个分隔符 */
export const PLOT_CODE_LENGTH = 24;

/** 段间分隔符，固定为连字符，便于人工识别与打印 */
export const PLOT_CODE_SPLITTER = "-";

/** 校验字符集，共 36 位，取值序号与字符下标一致 */
export const CHECK_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 地块级编码的网格段占位。网格行列号从 1 开始，故全零可安全作为哨兵 */
export const GRID_PLACEHOLDER = "0000";

/** 网格行列号取值上限 */
export const GRID_ROW_COL_MAX = 99;

/** 段名到段长的映射，供解析与生成复用 */
export const SEGMENT_LENGTHS: Record<string, number> = Object.fromEntries(
  PLOT_CODE_SEGMENTS.map((segment) => [segment.key, segment.length]),
);
