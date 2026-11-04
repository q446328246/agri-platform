import { z } from "zod";

/**
 * 统一响应信封。
 *
 * 所有 REST 接口一律返回统一信封，前端与网关只需实现一次解包逻辑。
 * 业务数据放在 data 字段，失败时该字段为空并给出错误码与提示信息。
 */
export interface ApiResponse<T = unknown> {
  /** 业务状态码，"OK" 表示成功，其余取值见 ErrorCode */
  code: string;
  /** 面向用户的提示信息，成功时通常为空 */
  message: string;
  /** 业务数据，失败时为 null */
  data: T | null;
  /** 链路标识，与请求头 HEADER_REQUEST_ID 一致，便于跨服务追踪 */
  traceId: string;
  /** 服务器时间戳（毫秒），用于前后端时钟校准 */
  timestamp: number;
}

/** 排序方向 */
export type SortOrder = "asc" | "desc";

/** 分页与排序查询参数 */
export interface PageQuery {
  /** 页码，从 1 开始；超出总页数时返回空列表而非报错 */
  page: number;
  /** 每页条数，默认 20，上限 200 */
  size: number;
  /** 排序字段，必须是接口文档中声明的白名单字段 */
  sortBy?: string;
  /** 排序方向，默认 asc */
  order?: SortOrder;
}

/** 分页结果结构 */
export interface PageResult<T> {
  /** 当前页数据 */
  items: T[];
  /** 总条数，用于前端分页控件计算 */
  total: number;
  page: number;
  size: number;
  /** 总页数，由服务端计算，避免前端重复推导 */
  pages: number;
}

/** 分页参数校验结构，供各服务请求对象直接复用 */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.string().min(1).max(64).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

/** 分页默认值与上限 */
export const PAGE_DEFAULT_SIZE = 20;

export const PAGE_MAX_SIZE = 200;
