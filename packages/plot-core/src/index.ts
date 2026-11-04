/**
 * @agri/plot-core 主入口。
 *
 * 地块编码是全平台数据关联的锚点；本包只做编码级与索引级计算，
 * 不做几何运算（叠加、缓冲区、面积一律下沉空间数据库以 SQL 完成）。
 */
export * from "./constants.js";
export * from "./error.js";
export * from "./checksum.js";
export * from "./code.js";
export * from "./grid.js";
export * from "./crs.js";
