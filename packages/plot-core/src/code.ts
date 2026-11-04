import {
  CHECK_CHARSET,
  GRID_PLACEHOLDER,
  PLOT_CODE_LENGTH,
  PLOT_CODE_SEGMENTS,
  PLOT_CODE_SPLITTER,
  SEGMENT_LENGTHS,
} from "./constants.js";
import { computeCheckChar } from "./checksum.js";
import { PlotCodeError } from "./error.js";

/** 编码解析结果结构 */
export interface PlotCodeSegments {
  /** 行政区划码，6 位 */
  region: string;
  /** 农场代码，6 位 */
  farm: string;
  /** 片区号，2 位 */
  area: string;
  /** 地块序号，5 位 */
  parcel: string;
  /** 网格号，4 位；地块级编码时为空串 */
  grid: string;
  /** 校验位，1 位 */
  check: string;
}

/** 编码生成入参结构 */
export interface PlotCodeInput {
  region: string;
  farm: string;
  area: string;
  parcel: string;
  /** 省略时生成地块级编码，网格段以占位符填充 */
  grid?: string;
}

/** 校验失败原因码 */
export type PlotCodeFailReason = "LENGTH" | "SEGMENT" | "CHARSET" | "CHECKSUM";

/** 编码校验明细结果 */
export interface PlotCodeCheckResult {
  valid: boolean;
  /** 失败原因码 */
  reason?: PlotCodeFailReason;
  /** 失败时的可读说明，可直接用于接口返回 */
  message?: string;
  /** 校验通过时返回解析结果 */
  segments?: PlotCodeSegments;
}

/** 段顺序（不含校验位），生成与解析共用 */
const BODY_SEGMENTS = PLOT_CODE_SEGMENTS.filter((segment) => segment.key !== "check");

/** 规范化段值：去空白、转大写、左补零到声明长度 */
function normalizeSegment(key: string, raw: string | undefined): string {
  const length = SEGMENT_LENGTHS[key] ?? 0;
  const value = (raw ?? "").trim().toUpperCase();
  if (value.length > length) {
    throw new PlotCodeError(`段 ${key} 长度 ${value.length} 超出声明长度 ${length}`);
  }
  return value.padStart(length, "0");
}

/** 按段拼接并计算校验位 */
function assemble(segments: Record<string, string>): string {
  const body = BODY_SEGMENTS.map((segment) => segments[segment.key] ?? "").join("");
  const check = computeCheckChar(body);
  const ordered = [...BODY_SEGMENTS.map((segment) => segments[segment.key] ?? ""), check];
  return ordered.join(PLOT_CODE_SPLITTER);
}

/**
 * 拼装地块编码并自动计算校验位。
 * 各段按声明长度左补零，超长时抛出 PlotCodeError。
 * @param input 编码生成入参
 * @returns 完整六段式编码
 */
export function buildPlotCode(input: PlotCodeInput): string {
  const segments: Record<string, string> = {
    region: normalizeSegment("region", input.region),
    farm: normalizeSegment("farm", input.farm),
    area: normalizeSegment("area", input.area),
    parcel: normalizeSegment("parcel", input.parcel),
    grid: normalizeSegment("grid", input.grid ?? GRID_PLACEHOLDER),
  };
  return assemble(segments);
}

/**
 * 解析地块编码。
 * 段数、段长或校验位不符时抛出 PlotCodeError，不返回部分结果。
 * @param code 待解析编码
 * @returns 编码解析结果
 */
export function parsePlotCode(code: string): PlotCodeSegments {
  const detail = inspect(code);
  if (!detail.valid || !detail.segments) {
    throw new PlotCodeError(detail.message ?? "地块编码非法");
  }
  return detail.segments;
}

/** 内部统一校验实现，供 parse / validate / check 三处复用 */
function inspect(code: string): PlotCodeCheckResult {
  const raw = (code ?? "").trim().toUpperCase();
  if (raw.length === 0) {
    return { valid: false, reason: "LENGTH", message: "编码不能为空" };
  }

  const parts = raw.split(PLOT_CODE_SPLITTER);
  if (parts.length !== PLOT_CODE_SEGMENTS.length) {
    return {
      valid: false,
      reason: "SEGMENT",
      message: `分段数应为 ${PLOT_CODE_SEGMENTS.length}，实际为 ${parts.length}`,
    };
  }

  for (let i = 0; i < BODY_SEGMENTS.length; i += 1) {
    const segment = BODY_SEGMENTS[i];
    const part = parts[i];
    if (!segment || part === undefined) {
      return { valid: false, reason: "SEGMENT", message: "分段内容缺失" };
    }
    if (part.length !== segment.length) {
      return {
        valid: false,
        reason: "LENGTH",
        message: `段 ${segment.label} 长度应为 ${segment.length}，实际为 ${part.length}`,
      };
    }
    for (const ch of part) {
      if (!CHECK_CHARSET.includes(ch)) {
        return {
          valid: false,
          reason: "CHARSET",
          message: `段 ${segment.label} 含非法字符 ${ch}`,
        };
      }
    }
  }

  const body = parts.slice(0, BODY_SEGMENTS.length).join("");
  if (body.length !== PLOT_CODE_LENGTH - 1) {
    return {
      valid: false,
      reason: "LENGTH",
      message: `有效字符总长应为 ${PLOT_CODE_LENGTH}，实际为 ${body.length + 1}`,
    };
  }

  const expected = computeCheckChar(body);
  const actual = parts[parts.length - 1] ?? "";
  if (actual !== expected) {
    return {
      valid: false,
      reason: "CHECKSUM",
      message: `校验位不匹配，期望 ${expected} 实际 ${actual}`,
    };
  }

  const gridRaw = parts[4] ?? GRID_PLACEHOLDER;
  return {
    valid: true,
    segments: {
      region: parts[0] ?? "",
      farm: parts[1] ?? "",
      area: parts[2] ?? "",
      parcel: parts[3] ?? "",
      grid: gridRaw === GRID_PLACEHOLDER ? "" : gridRaw,
      check: actual,
    },
  };
}

/** 判定编码是否合法；非法时返回 false，不抛出异常 */
export function validatePlotCode(code: string): boolean {
  return inspect(code).valid;
}

/** 返回校验明细，供表单校验与批量导入使用 */
export function checkPlotCode(code: string): PlotCodeCheckResult {
  return inspect(code);
}

/** 供网格模块复用的段拆解，返回原始网格段（含占位符） */
export function splitRaw(code: string): { body: string[]; grid: string; check: string } {
  const parts = code.trim().toUpperCase().split(PLOT_CODE_SPLITTER);
  return {
    body: parts.slice(0, BODY_SEGMENTS.length),
    grid: parts[4] ?? GRID_PLACEHOLDER,
    check: parts[5] ?? "",
  };
}
