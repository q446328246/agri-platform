import type { PageResult } from "@agri/contracts";
import { BizError } from "@agri/shared";

/**
 * 分页查询与结果组装。
 *
 * 排序字段必须命中服务端白名单：直接把前端传入的字段拼入排序会形成注入面，
 * 也会让数据库执行无索引排序。
 */

/** 分页与排序选项 */
export interface PaginateOptions {
  page?: number;
  size?: number;
  sortBy?: string;
  order?: "asc" | "desc";
  /** 允许排序的字段白名单，为空表示只允许按主键排序 */
  allowedSortFields?: string[];
}

/** 分页依赖的模型能力 */
export interface PaginateModel<T> {
  findMany(args: unknown): Promise<T[]>;
  count(args?: unknown): Promise<number>;
}

const DEFAULT_SIZE = 20;
const MAX_SIZE = 200;

/**
 * 分页查询。
 * @param model 具备 findMany 与 count 的模型代理
 * @param where 查询条件，按模型字段直接传递
 * @param options 分页与排序选项
 * @returns 分页结果
 */
export async function paginate<T>(
  model: PaginateModel<T>,
  where: Record<string, unknown> = {},
  options: PaginateOptions = {},
): Promise<PageResult<T>> {
  const size = Math.min(Math.max(1, options.size ?? DEFAULT_SIZE), MAX_SIZE);
  const page = Math.max(1, options.page ?? 1);

  let orderBy: Record<string, "asc" | "desc"> | undefined;
  if (options.sortBy) {
    const allowList = options.allowedSortFields ?? [];
    if (!allowList.includes(options.sortBy)) {
      throw new BizError("SYS-400-001", `排序字段 ${options.sortBy} 不在允许范围内`, 400);
    }
    orderBy = { [options.sortBy]: options.order ?? "asc" };
  }

  const listArgs = orderBy
    ? { where, skip: (page - 1) * size, take: size, orderBy }
    : { where, skip: (page - 1) * size, take: size };

  const [items, total] = await Promise.all([model.findMany(listArgs), model.count({ where })]);
  return {
    items,
    total,
    page,
    size,
    pages: Math.ceil(total / size),
  };
}
