/** 地块简要信息 */
export interface PlotBrief {
  parcelId: string;
  parcelCode: string;
  parcelName: string;
  /** 面积，单位：亩 */
  areaMu: number;
  /** 地力等级 1 到 5，数值越大地力越高 */
  fertilityLevel: number;
  /** 地块状态，取值来自 PlotStatus */
  status: number;
}

/** 网格引用 */
export interface GridRef {
  gridCode: string;
  parcelId: string;
  /** 网格在地块内的行号 */
  rowNo: number;
  /** 网格在地块内的列号 */
  colNo: number;
}
