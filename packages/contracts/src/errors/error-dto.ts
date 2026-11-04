import type { ErrorCodeValue } from "./error-code.js";

/** 错误响应结构，失败响应的 data 为空并给出错误码与提示信息 */
export interface ErrorResponse {
  code: ErrorCodeValue | string;
  message: string;
  /** 字段级校验明细，仅参数类错误返回 */
  details?: Array<{ field: string; reason: string }>;
  traceId: string;
  timestamp: number;
}
