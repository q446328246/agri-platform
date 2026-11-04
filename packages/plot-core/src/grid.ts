import { buildPlotCode, parsePlotCode, splitRaw } from "./code.js";
import type { PlotCodeSegments } from "./code.js";
import { GRID_PLACEHOLDER, GRID_ROW_COL_MAX, PLOT_CODE_SPLITTER } from "./constants.js";
import { PlotCodeError } from "./error.js";

/** 网格行列规模定义 */
export interface GridLayout {
  /** 每行网格数 */
  cols: number;
  /** 每列网格数 */
  rows: number;
}

function assertRowCol(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > GRID_ROW_COL_MAX) {
    throw new PlotCodeError(`${label} 必须为 1 到 ${GRID_ROW_COL_MAX} 的整数，实际为 ${value}`);
  }
}

function formatRowCol(row: number, col: number): string {
  return `${String(row).padStart(2, "0")}${String(col).padStart(2, "0")}`;
}

/**
 * 由地块编码与行列号生成网格编码。
 * 网格编码复用地块编码的前四段，只替换网格段，因此天然携带其所属地块。
 * @param parcelCode 地块级编码
 * @param row 行号，1 到 99
 * @param col 列号，1 到 99
 * @returns 网格级编码
 */
export function buildGridCode(parcelCode: string, row: number, col: number): string {
  assertRowCol(row, "行号");
  assertRowCol(col, "列号");
  const parsed = parsePlotCode(parcelCode);
  return buildPlotCode({
    region: parsed.region,
    farm: parsed.farm,
    area: parsed.area,
    parcel: parsed.parcel,
    grid: formatRowCol(row, col),
  });
}

/**
 * 解析网格编码，返回前四段、网格段与行列号。
 * @param gridCode 网格级编码
 * @returns 段信息与行列号
 */
export function parseGridCode(gridCode: string): PlotCodeSegments & { row: number; col: number } {
  const parsed = parsePlotCode(gridCode);
  const raw = splitRaw(gridCode).grid;
  if (raw === GRID_PLACEHOLDER) {
    throw new PlotCodeError("该编码为地块级编码，不含网格行列号");
  }
  const row = Number(raw.slice(0, 2));
  const col = Number(raw.slice(2, 4));
  assertRowCol(row, "行号");
  assertRowCol(col, "列号");
  return { ...parsed, grid: raw, row, col };
}

/**
 * 网格序号转行列号。
 * 序号从 1 开始，按先行后列的顺序编号，用于变量作业的任务分片。
 * @param index 网格序号
 * @param layout 网格布局
 */
export function gridIndexToRowCol(index: number, layout: GridLayout): { row: number; col: number } {
  if (!Number.isInteger(index) || index < 1) {
    throw new PlotCodeError(`网格序号必须为正整数，实际为 ${index}`);
  }
  if (!Number.isInteger(layout.cols) || layout.cols < 1) {
    throw new PlotCodeError(`网格列数必须为正整数，实际为 ${layout.cols}`);
  }
  return {
    row: Math.ceil(index / layout.cols),
    col: ((index - 1) % layout.cols) + 1,
  };
}

/**
 * 行列号转网格序号。
 * @param row 行号
 * @param col 列号
 * @param layout 网格布局
 */
export function rowColToGridIndex(row: number, col: number, layout: GridLayout): number {
  if (!Number.isInteger(layout.cols) || layout.cols < 1) {
    throw new PlotCodeError(`网格列数必须为正整数，实际为 ${layout.cols}`);
  }
  if (!Number.isInteger(row) || row < 1) {
    throw new PlotCodeError(`行号必须为正整数，实际为 ${row}`);
  }
  if (!Number.isInteger(col) || col < 1 || col > layout.cols) {
    throw new PlotCodeError(`列号必须在 1 到 ${layout.cols} 之间，实际为 ${col}`);
  }
  return (row - 1) * layout.cols + col;
}

/** 拼装网格编码的可读形式，便于日志与前端展示 */
export function formatGridCode(parcelCode: string, row: number, col: number): string {
  return buildGridCode(parcelCode, row, col).split(PLOT_CODE_SPLITTER).slice(0, 5).join(PLOT_CODE_SPLITTER);
}
