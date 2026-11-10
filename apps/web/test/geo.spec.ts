import { describe, expect, it } from "vitest";
import { polygonAreaMu as sharedPolygonAreaMu, ringAreaMu as sharedRingAreaMu } from "@agri/shared";
import { boundaryAreaMu, parsePlotBoundary, polygonAreaMu, polylineLengthM } from "../src/utils/geo.js";

/** 独立参考：球面多边形面积（Chamberlain-Duquette，与 @turf/area 同式），单位亩。 */
function sphericalAreaMu(ringLngLat: [number, number][]): number {
  const radius = 6371008.8;
  const rad = (degree: number) => (degree * Math.PI) / 180;
  let total = 0;
  for (let i = 0; i < ringLngLat.length; i += 1) {
    const [lng1, lat1] = ringLngLat[i]!;
    const [lng2, lat2] = ringLngLat[(i + 1) % ringLngLat.length]!;
    total += (rad(lng2) - rad(lng1)) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((total * radius * radius) / 2) / 666.6667;
}

const RECTANGLE: [number, number][] = [[107.5, 30.95], [107.52, 30.95], [107.52, 30.97], [107.5, 30.97]];
const IRREGULAR: [number, number][] = [[107.41, 30.975], [107.418, 30.973], [107.423, 30.978], [107.421, 30.986], [107.414, 30.988], [107.409, 30.982]];
const NARROW: [number, number][] = [[107.4, 30.9], [107.46, 30.9], [107.46, 30.9004], [107.4, 30.9004]];

describe("地块面积换算", () => {
  it.each([
    ["规则矩形", RECTANGLE],
    ["不规则六边形", IRREGULAR],
    ["细长条", NARROW],
  ])("%s 与球面参考面积相差不到 1%%", (_name, ring) => {
    const reference = sphericalAreaMu(ring);
    expect(Math.abs(polygonAreaMu(ring) / reference - 1)).toBeLessThan(0.01);
  });

  it("面积不随经纬度绝对值漂移（逐点乘 cos(lat) 会让大坐标项相消）", () => {
    const base = polygonAreaMu(IRREGULAR);
    const lat0 = IRREGULAR.reduce((sum, point) => sum + point[1], 0) / IRREGULAR.length;
    const shifts: [number, number][] = [[0, 0], [-200, -60], [18, 25], [0, 0.0004]];
    for (const [dLng, dLat] of shifts) {
      const shifted = IRREGULAR.map(([lng, lat]) => [lng + dLng, lat + dLat] as [number, number]);
      // 纬度变化会真实改变 cos 缩放，只允许随之而来的比例差，不允许出现数量级跳变
      const expected = base * (Math.cos(((lat0 + dLat) * Math.PI) / 180) / Math.cos((lat0 * Math.PI) / 180));
      expect(Math.abs(polygonAreaMu(shifted) / expected - 1)).toBeLessThan(0.000001);
    }
  });

  it("不足三点或共线顶点面积为 0", () => {
    expect(polygonAreaMu([])).toBe(0);
    expect(polygonAreaMu([[107.4, 30.9], [107.41, 30.9]])).toBe(0);
    expect(polygonAreaMu([[107.4, 30.9], [107.41, 30.9], [107.42, 30.9]])).toBe(0);
  });

  it("台账面积与边界冲突时以几何为准", () => {
    // 台账里的手填申报面积可能与边界差一个数量级，展示侧不能再沿用写死值（口径见迁移 015）
    const boundary = parsePlotBoundary({ parcelCode: "P1", areaMu: 12.5, geom: { type: "Polygon", coordinates: [RECTANGLE] } })!;
    expect(boundaryAreaMu(boundary)).toBe(polygonAreaMu(RECTANGLE));
  });
});

describe("前后端面积口径一致", () => {
  // 前端预览、@agri/shared（后端种子与脚本）、迁移 015 是三份实现，TS 两份必须给出同一个数，
  // 否则地图上画出来的面积和落库台账会对不上。
  const CLOSED: [number, number][] = [...RECTANGLE, RECTANGLE[0]!];
  const DUPLICATED: [number, number][] = [RECTANGLE[0]!, RECTANGLE[0]!, RECTANGLE[1]!, RECTANGLE[1]!, RECTANGLE[2]!, RECTANGLE[3]!, RECTANGLE[0]!];

  it.each([
    ["规则矩形", RECTANGLE],
    ["不规则六边形", IRREGULAR],
    ["细长条", NARROW],
    ["首尾闭合", CLOSED],
    ["连续重复顶点", DUPLICATED],
  ])("%s 与 @agri/shared 逐位相同", (_name, ring) => {
    expect(polygonAreaMu(ring)).toBe(sharedPolygonAreaMu(ring));
    const latLng = ring.map(([lng, lat]) => [lat, lng] as [number, number]);
    expect(polygonAreaMu(ring)).toBe(sharedRingAreaMu(latLng));
  });

  it("退化几何两侧都返回 0", () => {
    const degenerate: [number, number][][] = [
      [],
      [[107.4, 30.9], [107.41, 30.9]],
      [[107.4, 30.9], [107.41, 30.9], [107.42, 30.9]],
      [[107.4, 30.9], [107.4, 30.9], [107.4, 30.9]],
    ];
    for (const ring of degenerate) {
      expect(polygonAreaMu(ring)).toBe(0);
      expect(sharedPolygonAreaMu(ring)).toBe(0);
    }
  });
});

describe("边界解析", () => {
  it("MultiPolygon 把最大外环排在首位，center 与 rings[0] 同源", () => {
    const small: [number, number][] = [[107.4, 30.9], [107.401, 30.9], [107.401, 30.901], [107.4, 30.901]];
    const boundary = parsePlotBoundary({ parcelCode: "P2", geom: { type: "MultiPolygon", coordinates: [[small], [RECTANGLE]] } })!;
    expect(boundary.rings).toHaveLength(2);
    const primary = boundary.rings[0]!;
    expect(boundaryAreaMu(boundary)).toBeGreaterThan(6000);
    const lat = primary.reduce((sum, point) => sum + point[0], 0) / primary.length;
    const lng = primary.reduce((sum, point) => sum + point[1], 0) / primary.length;
    expect(boundary.center[0]).toBeCloseTo(lat, 9);
    expect(boundary.center[1]).toBeCloseTo(lng, 9);
  });

  it("退化边界返回 null", () => {
    expect(parsePlotBoundary({ parcelCode: "P3", geom: { type: "Polygon", coordinates: [[[107.4, 30.9], [107.41, 30.9]]] } })).toBeNull();
  });
});

describe("折线长度", () => {
  it("与后端 estimateLengthM 同口径（等距圆柱近似）", () => {
    const length = polylineLengthM([[107.4, 30.9], [107.42, 30.9]]);
    expect(length).toBeCloseTo(0.02 * 111320 * Math.cos((30.9 * Math.PI) / 180), 6);
  });

  it("单点与空数组长度为 0", () => {
    expect(polylineLengthM([])).toBe(0);
    expect(polylineLengthM([[107.4, 30.9]])).toBe(0);
  });
});