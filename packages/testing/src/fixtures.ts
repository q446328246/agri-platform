import type { CropSeasonBrief, DeviceBrief, GridRef, PlotBrief } from "@agri/contracts";
import { DeviceCategory, PlotStatus, SeasonStatus, TelemetryMetric } from "@agri/contracts";
import { buildPlotCode } from "@agri/plot-core";

/**
 * 数据夹具。
 *
 * 默认值取自达州本地的典型场景（丘陵地块、水稻生育期、土壤墒情），
 * 使测试数据贴近真实量级，避免用 1、2 这类极端值掩盖单位或量纲错误。
 */

/** 生成地块编码，缺省使用开江县示例区划 */
export function buildPlotCodeFixture(input: {
  region?: string;
  farm?: string;
  area?: string;
  parcel?: string;
  grid?: string;
} = {}): string {
  const base = {
    region: input.region ?? "511723",
    farm: input.farm ?? "000001",
    area: input.area ?? "01",
    parcel: input.parcel ?? "00001",
  };
  return buildPlotCode(input.grid === undefined ? base : { ...base, grid: input.grid });
}

/** 地块夹具 */
export function plotFixture(overrides: Partial<PlotBrief> = {}): PlotBrief {
  return {
    parcelId: "100000000000000001",
    parcelCode: buildPlotCodeFixture(),
    parcelName: "开江县任市镇示范田一号地块",
    areaMu: 12.5,
    fertilityLevel: 3,
    status: PlotStatus.Normal,
    ...overrides,
  };
}

/** 网格夹具 */
export function gridFixture(overrides: Partial<GridRef> = {}): GridRef {
  return {
    gridCode: buildPlotCodeFixture({ parcel: "00001", grid: "0001" }),
    parcelId: "100000000000000001",
    rowNo: 1,
    colNo: 1,
    ...overrides,
  };
}

/** 设备夹具 */
export function deviceFixture(overrides: Partial<DeviceBrief> = {}): DeviceBrief {
  return {
    deviceId: "200000000000000001",
    deviceCode: "DEV-SOIL-000001",
    category: DeviceCategory.SoilSensor,
    online: true,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 作物季夹具 */
export function seasonFixture(overrides: Partial<CropSeasonBrief> = {}): CropSeasonBrief {
  return {
    seasonId: "300000000000000001",
    seasonCode: "2026-SEASON-000001",
    parcelId: "100000000000000001",
    cropCode: "RICE-CHUANXIAN-01",
    sowDate: "2026-04-20",
    growthStage: "分蘖期",
    status: SeasonStatus.Growing,
    ...overrides,
  };
}

/** 遥测记录结构 */
export interface TelemetryFixture {
  deviceId: string;
  parcelId: string;
  metric: string;
  value: number;
  unit: string;
  collectedAt: string;
}

/** 遥测夹具：默认土壤墒情，单位与量纲须与指标一致 */
export function telemetryFixture(overrides: Partial<TelemetryFixture> = {}): TelemetryFixture {
  return {
    deviceId: "200000000000000001",
    parcelId: "100000000000000001",
    metric: TelemetryMetric.SoilMoisture,
    value: 28.4,
    unit: "%",
    collectedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
