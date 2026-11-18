import { vi } from "vitest";

/** Leaflet 结构桩：四情页长势热力仅在点击「生成」且格点非空时才建图，既有测试不触发真实渲染。 */
export function leafletStub() {
  const layer = { bindTooltip: vi.fn().mockReturnThis(), addTo: vi.fn() };
  return {
    map: vi.fn(() => ({ removeLayer: vi.fn(), fitBounds: vi.fn(), invalidateSize: vi.fn(), remove: vi.fn() })),
    layerGroup: vi.fn(() => ({ addTo: vi.fn(), clearLayers: vi.fn() })),
    latLngBounds: vi.fn(() => ({ extend: vi.fn() })),
    polygon: vi.fn(() => layer),
    circleMarker: vi.fn(() => layer),
  };
}

/** 共享底图模块桩：与 plot-zone-regressions 同口径；四情页 setup 期读一次存储键，只给配置不挂瓦片。 */
export function basemapStub() {
  return {
    baseMapCrs: () => undefined,
    baseMapMaxZoom: () => 22,
    readStoredBaseMap: () => "tdt-img",
    createBaseLayer: () => ({ addTo: vi.fn() }),
  };
}