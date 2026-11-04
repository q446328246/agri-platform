/**
 * 软删除扩展。
 *
 * 农业数据需要长期留存：地块边界、农事记录、投入品使用都要可追溯，
 * 因此一律使用软删除，物理删除只保留给数据清理流程。
 */

/** 软删除标记字段名，各服务表结构须统一使用该字段 */
export const SOFT_DELETE_FIELD = "deletedAt";

/** 软删除扩展契约 */
export interface SoftDeleteExtension {
  name: string;
  /** 在查询条件上叠加「未删除」约束 */
  buildWhere(where?: Record<string, unknown>): Record<string, unknown>;
  /** 把删除改写为写入删除时间 */
  buildDeleteData(): Record<string, unknown>;
  /** 构造「仅看已删除」的条件，用于回收站类查询 */
  buildDeletedWhere(where?: Record<string, unknown>): Record<string, unknown>;
}

/** 软删除扩展实现 */
export const softDeleteExtension: SoftDeleteExtension = {
  name: "softDelete",

  buildWhere(where: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...where, [SOFT_DELETE_FIELD]: null };
  },

  buildDeleteData(): Record<string, unknown> {
    return { [SOFT_DELETE_FIELD]: new Date() };
  },

  buildDeletedWhere(where: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...where, [SOFT_DELETE_FIELD]: { not: null } };
  },
};
