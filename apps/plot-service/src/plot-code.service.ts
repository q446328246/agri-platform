import { Injectable } from "@nestjs/common";

import type { Coordinate } from "@agri/contracts";
import {
  buildGridCode,
  buildPlotCode,
  checkPlotCode,
  CRS_CGCS2000,
  CRS_WGS84,
  parsePlotCode,
  transformCoordinate,
} from "@agri/plot-core";
import type { PlotCodeCheckResult, PlotCodeInput, PlotCodeSegments } from "@agri/plot-core";

/**
 * 地块编码服务。
 *
 * 编码是平台的数据关联锚点，因此生成与解析集中在本服务，业务代码不得自行
 * 拼装编码字符串，否则容易出现分隔符、补零与校验位不一致的问题。
 *
 * 坐标口径：库内统一 CGCS2000（EPSG:4490）；仅允许在出参方向换算为其他
 * 坐标系供前端与地图底图使用，不接受外部坐标换算后写库，避免库内出现
 * 多套坐标系混杂的数据。
 */
@Injectable()
export class PlotCodeService {
  /** 生成地块编码，自动计算校验位 */
  generate(input: PlotCodeInput): string {
    return buildPlotCode(input);
  }

  /** 解析地块编码为分段结构 */
  parse(code: string): PlotCodeSegments {
    return parsePlotCode(code);
  }

  /** 校验地块编码，返回可直接用于接口返回的明细结果 */
  check(code: string): PlotCodeCheckResult {
    return checkPlotCode(code);
  }

  /** 生成地块内作业网格编码 */
  grid(parcelCode: string, row: number, col: number): string {
    return buildGridCode(parcelCode, row, col);
  }

  /**
   * 把库内的 CGCS2000 坐标换算为出参坐标系。
   * @param coordinate 库内坐标
   * @param to 目标坐标系，默认 WGS84
   */
  toClient(coordinate: Coordinate, to: typeof CRS_WGS84 | "GCJ02" = CRS_WGS84): Coordinate {
    return transformCoordinate(coordinate, CRS_CGCS2000, to);
  }
}
