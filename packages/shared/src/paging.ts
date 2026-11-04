/**
 * 分页结果组装。
 *
 * 注意：分页结果的结构契约由 @agri/contracts 定义，本包不反向依赖契约包，
 * 因此在此声明结构一致的接口。两者字段完全相同，TypeScript 结构类型下可互换使用；
 * 对外接口的出参类型一律使用契约包的 PageResult。
 */

/** 分页输入 */
export interface PageInput<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** 分页结果，结构与 @agri/contracts 的 PageResult 一致 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

/**
 * 组装分页结果，自动计算总页数并做边界修正。
 * @param input 分页输入
 * @returns 分页结果
 */
export function toPageResult<T>(input: PageInput<T>): PageResult<T> {
  const size = input.size > 0 ? input.size : 1;
  const page = input.page > 0 ? input.page : 1;
  return {
    items: input.items,
    total: input.total,
    page,
    size,
    pages: Math.ceil(input.total / size),
  };
}
