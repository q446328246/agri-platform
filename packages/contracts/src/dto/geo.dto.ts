/** 经纬度坐标 */
export interface Coordinate {
  /** 经度，十进制度，正数表示东经 */
  lng: number;
  /** 纬度，十进制度，正数表示北纬 */
  lat: number;
}

/** 多边形几何 */
export interface GeoPolygon {
  /** 几何类型固定为 Polygon，支持带内环的多边形 */
  type: "Polygon";
  /** 坐标环，首环为外环，其余为内环；每个环首尾坐标相同 */
  coordinates: number[][][];
  /** 坐标参考系统标识，平台统一使用 4490 */
  srid: number;
}

/** 线状几何，用于灌水管线、施肥管路、电力线与道路 */
export interface GeoLineString {
  /** 几何类型固定为 LineString */
  type: "LineString";
  /** 折点坐标，按走向排列，每个点为 [经度, 纬度] */
  coordinates: number[][];
  /** 坐标参考系统标识，平台统一使用 4490 */
  srid: number;
}
