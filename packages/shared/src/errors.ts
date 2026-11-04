/**
 * 业务异常基类。
 *
 * 所有业务异常继承自统一基类并携带错误码，全局异常过滤器只需判断一次类型，
 * 无需为每种异常单独编写转换分支。
 */
export class BizError extends Error {
  readonly code: string;

  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "BizError";
    this.code = code;
    this.httpStatus = httpStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 字段级校验明细 */
export type ErrorDetail = { field: string; reason: string };

/**
 * 参数校验异常，可携带字段级明细。
 * 默认错误码 SYS-400-001，与契约包错误码定义保持一致。
 */
export class ValidationError extends BizError {
  readonly details: ErrorDetail[] | undefined;

  constructor(message: string, details?: ErrorDetail[], code = "SYS-400-001") {
    super(code, message, 400);
    this.name = "ValidationError";
    this.details = details;
  }
}

/** 资源未找到异常，默认错误码 SYS-404-001 */
export class NotFoundError extends BizError {
  constructor(message: string, code = "SYS-404-001") {
    super(code, message, 404);
    this.name = "NotFoundError";
  }
}

/** 状态冲突异常，默认错误码 SYS-409-001 */
export class ConflictError extends BizError {
  constructor(message: string, code = "SYS-409-001") {
    super(code, message, 409);
    this.name = "ConflictError";
  }
}
