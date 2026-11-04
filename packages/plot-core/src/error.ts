import { BizError } from "@agri/shared";

/** 编码相关异常，继承业务异常基类，便于全局异常过滤器统一识别 */
export class PlotCodeError extends BizError {
  constructor(message: string, code = "PLOT-422-001") {
    super(code, message, 422);
    this.name = "PlotCodeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
