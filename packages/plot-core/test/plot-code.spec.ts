import { describe, expect, it } from "vitest";

import {
  buildGridCode,
  buildPlotCode,
  checkPlotCode,
  CRS_CGCS2000,
  CRS_WGS84,
  parseGridCode,
  parsePlotCode,
  PlotCodeError,
  transformCoordinate,
} from "../src/index.js";

/** 达州市开江县示例区划与农场 */
const DEMO = { region: "511723", farm: "000001", area: "01", parcel: "00001" };

const DEMO_CODE = "511723-000001-01-00001-0000-5";

describe("地块编码", () => {
  it("按六段式生成编码并带校验位", () => {
    const code = buildPlotCode(DEMO);
    expect(code).toBe(DEMO_CODE);
    // 六段五分隔符，网格段为占位
    expect(code.split("-")).toHaveLength(6);
    expect(code.split("-")[4]).toBe("0000");
  });

  it("生成与解析可往返", () => {
    const segments = parsePlotCode(DEMO_CODE);
    expect(segments).toMatchObject({ ...DEMO, grid: "", check: "5" });
  });

  it("校验位被篡改时判定失败，且原因可用于接口返回", () => {
    const tampered = `${DEMO_CODE.slice(0, -1)}0`;
    const result = checkPlotCode(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("CHECKSUM");
    expect(checkPlotCode(DEMO_CODE).valid).toBe(true);
  });

  it("长度或字符不合规时判定失败", () => {
    expect(checkPlotCode("511723-000001-01-00001").valid).toBe(false);
    expect(checkPlotCode("511723-000001-01-0000A-0000-5").valid).toBe(false);
    expect(checkPlotCode("511723-000001-01-0000A-0000-5").reason).toBeDefined();
  });

  it("解析非法编码抛出编码异常", () => {
    expect(() => parsePlotCode("abc")).toThrow(PlotCodeError);
  });

  it("网格编码基于地块编码派生并可解析行列号", () => {
    const gridCode = buildGridCode(DEMO_CODE, 1, 1);
    expect(gridCode).toBe("511723-000001-01-00001-0101-Z");

    const parsed = parseGridCode(gridCode);
    expect(parsed.row).toBe(1);
    expect(parsed.col).toBe(1);
    expect(parsed.parcel).toBe(DEMO.parcel);
  });

  it("坐标换算只改变基准不同的坐标，非 GCJ02 之间视为一致", () => {
    const coord = { lng: 107.8421, lat: 30.9942 };
    expect(transformCoordinate(coord, CRS_CGCS2000, CRS_WGS84)).toEqual(coord);

    const gcj = transformCoordinate(coord, CRS_WGS84, "GCJ02");
    expect(gcj.lng).not.toBe(coord.lng);
    // 偏移量在数百米量级，超出该范围说明算法被改坏
    expect(Math.abs(gcj.lng - coord.lng)).toBeLessThan(0.01);
    expect(Math.abs(gcj.lat - coord.lat)).toBeLessThan(0.01);
  });
});
