/**
 * 领域枚举。
 *
 * 枚举以只读常量对象方式导出，同时导出对应的值联合类型，便于在数据对象中
 * 约束取值范围，也便于前端做下拉选项与标签映射。
 * 枚举数值一经发布不得改变语义；新增取值属兼容变更，消费侧须对未知取值容错。
 */

/** 地块状态 */
export const PlotStatus = {
  Normal: 1,
  Idle: 2,
  Reclaiming: 3,
  Closed: 4,
} as const;

export type PlotStatusValue = (typeof PlotStatus)[keyof typeof PlotStatus];

/** 设备类别 */
export const DeviceCategory = {
  SoilSensor: "SOIL_SENSOR",
  WeatherStation: "WEATHER_STATION",
  Camera: "CAMERA",
  IrrigationValve: "IRRIGATION_VALVE",
  FertilizerMachine: "FERTILIZER_MACHINE",
  Drone: "DRONE",
} as const;

export type DeviceCategoryValue = (typeof DeviceCategory)[keyof typeof DeviceCategory];

/** 作物季状态 */
export const SeasonStatus = {
  Planned: 1,
  Sowing: 2,
  Growing: 3,
  Harvested: 4,
  Closed: 5,
} as const;

export type SeasonStatusValue = (typeof SeasonStatus)[keyof typeof SeasonStatus];

/** 遥测指标 */
export const TelemetryMetric = {
  SoilTemperature: "soil.temperature",
  SoilMoisture: "soil.moisture",
  SoilEc: "soil.ec",
  SoilPh: "soil.ph",
  AirTemperature: "air.temperature",
  Rainfall: "air.rainfall",
  WindDirection: "air.wind.direction",
} as const;

export type TelemetryMetricValue = (typeof TelemetryMetric)[keyof typeof TelemetryMetric];
