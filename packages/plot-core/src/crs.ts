import type { Coordinate } from "@agri/contracts";

import { PlotCodeError } from "./error.js";

/**
 * 坐标系与转换。
 *
 * 平台统一以国家大地坐标系 CGCS2000（EPSG:4490）存储几何数据，与自然资源
 * 部门的成果口径一致。转换只在出参与展示时单向发生，不得把转换后的坐标回写入库。
 */

/** 平台统一坐标参考系统，几何数据一律以此存储 */
export const CRS_CGCS2000 = 4490;

/** WGS84，GPS 原始观测与部分遥感产品使用 */
export const CRS_WGS84 = 4326;

/** 互联网地图常用坐标系标识 */
export const CRS_GCJ02 = "GCJ02";

/** 平台声明支持的坐标参考系统 */
export type CrsCode = 4490 | 4326 | "GCJ02";

const PI = Math.PI;
const AXIS = 6378245.0;
const ECCENTRICITY = 0.00669342162296594323;
const MAX_ITERATION = 10;

/** 中国大陆粗略范围判断，范围外不做偏移 */
function outOfChina(lng: number, lat: number): boolean {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS84 转 GCJ02 */
function wgs84ToGcj02(coord: Coordinate): Coordinate {
  if (outOfChina(coord.lng, coord.lat)) {
    return { ...coord };
  }
  let dLat = transformLat(coord.lng - 105.0, coord.lat - 35.0);
  let dLng = transformLng(coord.lng - 105.0, coord.lat - 35.0);
  const radLat = (coord.lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ECCENTRICITY * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((AXIS * (1 - ECCENTRICITY)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI);
  return { lng: coord.lng + dLng, lat: coord.lat + dLat };
}

/** GCJ02 转 WGS84，采用迭代逼近消除正向变换带来的偏移 */
function gcj02ToWgs84(coord: Coordinate): Coordinate {
  if (outOfChina(coord.lng, coord.lat)) {
    return { ...coord };
  }
  let candidate: Coordinate = { ...coord };
  for (let i = 0; i < MAX_ITERATION; i += 1) {
    const forward = wgs84ToGcj02(candidate);
    const dLng = forward.lng - coord.lng;
    const dLat = forward.lat - coord.lat;
    if (Math.abs(dLng) < 1e-9 && Math.abs(dLat) < 1e-9) {
      break;
    }
    candidate = { lng: candidate.lng - dLng, lat: candidate.lat - dLat };
  }
  return candidate;
}

function isGcj02(value: CrsCode): boolean {
  return value === CRS_GCJ02;
}

/**
 * 坐标系转换。
 * 仅支持平台声明支持的坐标系组合，未支持的组合抛出 PlotCodeError，
 * 避免静默返回未转换的坐标。
 * @param coord 源坐标
 * @param from 源坐标参考系统
 * @param to 目标坐标参考系统
 * @returns 转换后的坐标
 */
export function transformCoordinate(coord: Coordinate, from: CrsCode, to: CrsCode): Coordinate {
  if (from === to) {
    return { ...coord };
  }
  const fromGcj = isGcj02(from);
  const toGcj = isGcj02(to);

  if (fromGcj && toGcj) {
    return { ...coord };
  }
  // CGCS2000 与 WGS84 椭球参数在厘米级精度下可视为一致，跨基准精确转换
  // 需专业参数，平台不在此处做近似之外的处理
  if (!fromGcj && !toGcj) {
    return { ...coord };
  }
  if (!fromGcj && toGcj) {
    return wgs84ToGcj02(coord);
  }
  return gcj02ToWgs84(coord);
}

/**
 * 将扁平的坐标数组转换为坐标对象数组，用于接口出参组装。
 * @param flat 形如 [[lng, lat], ...] 的坐标数组
 * @returns 坐标对象数组
 */
export function toCoordinates(flat: number[][]): Coordinate[] {
  return flat.map((pair) => {
    const lng = pair[0];
    const lat = pair[1];
    if (typeof lng !== "number" || typeof lat !== "number") {
      throw new PlotCodeError("坐标数组元素必须为 [经度, 纬度] 两个数值");
    }
    return { lng, lat };
  });
}

/** 将坐标对象数组转换为扁平数组，便于写入空间数据库 */
export function fromCoordinates(coords: Coordinate[]): number[][] {
  return coords.map((coord) => [coord.lng, coord.lat]);
}
