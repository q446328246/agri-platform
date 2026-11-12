/**
 * 分段错误码。
 *
 * 格式：域缩写 - 分类码 - 序号，全大写，段间用连字符分隔。
 * 网关只需读第二段即可决定响应状态，运维只需读第一段即可定位责任服务。
 * 错误码一经发布不得修改含义，废弃的错误码保留定义但标注不再使用。
 */
export const ErrorCode = {
  OK: "OK",

  // 系统域
  SYS_PARAM_INVALID: "SYS-400-001",
  SYS_NOT_FOUND: "SYS-404-001",
  SYS_VERSION_CONFLICT: "SYS-409-001",
  SYS_INTERNAL: "SYS-500-001",
  SYS_DEPENDENCY_UNAVAILABLE: "SYS-503-001",

  // 认证与授权域
  AUTH_UNAUTHORIZED: "AUTH-401-001",
  AUTH_FORBIDDEN: "AUTH-403-001",

  // 地块域
  PLOT_NOT_FOUND: "PLOT-404-001",
  PLOT_CODE_DUPLICATED: "PLOT-409-001",
  /** 合并所选地块没有连成一片（边界间隙超过 PLOT_MERGE_ADJACENCY_M），拒绝合并 */
  PLOT_MERGE_NOT_ADJACENT: "PLOT-409-003",
  PLOT_CODE_INVALID: "PLOT-422-001",
  PLOT_GEOM_INVALID: "PLOT-422-002",

  // 设备接入域
  IOT_NOT_FOUND: "IOT-404-001",
  IOT_BIND_CONFLICT: "IOT-409-001",
  IOT_COMMAND_TIMEOUT: "IOT-408-001",

  // 物联感知域
  TELE_PAYLOAD_INVALID: "TELE-422-001",
  TELE_RATE_LIMITED: "TELE-429-001",

  // 智能决策域
  DEC_PRESCRIPTION_INCOMPLETE: "DEC-422-001",

  // 作业调度域
  OPS_STATUS_CONFLICT: "OPS-409-001",

  // 装备控制域
  CTL_COMMAND_TIMEOUT: "CTL-408-001",

  // 核算域
  FIN_PERIOD_MISMATCH: "FIN-422-001",

  // 溯源域
  TRC_CODE_INVALID: "TRC-404-001",
} as const;

/** 错误码联合类型 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 从错误码中取出分类码（第二段），网关据此映射响应状态 */
export function httpStatusFromErrorCode(code: string): number {
  if (code === ErrorCode.OK) {
    return 200;
  }
  const parts = code.split("-");
  const classify = parts[1];
  const parsed = Number(classify);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : 500;
}
