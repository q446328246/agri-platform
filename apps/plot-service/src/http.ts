import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { ApiResponse, GeoLineString, GeoPolygon, PageResult } from "@agri/contracts";
import { authorizeRequest, ulid } from "@agri/shared";

import { INFRA_LINE_TYPES, InMemoryInfraLineRepository, estimateLengthM } from "./infra-line.repository.js";
import type { InfraLine, InfraLinePatch, InfraLineRepository, InfraLineType } from "./infra-line.repository.js";
import type { PlotPatch, PlotRecord } from "./plot.repository.js";
import { PLOT_STATUSES, PLOT_TYPES } from "./plot.service.js";
import type { PlotService, RegisterPlotInput } from "./plot.service.js";
import { centroidOf, hullPolygon, ringPoints } from "./zone.geometry.js";
import type { LngLat } from "./zone.geometry.js";
import { InMemoryZoneRepository } from "./zone.repository.js";
import type { PlotZone, ZonePatch, ZoneRepository } from "./zone.repository.js";

const API_PREFIX = "/api/v1";

function traceId(request: IncomingMessage): string {
  const value = request.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : crypto.randomUUID();
}

function send<T>(response: ServerResponse, status: number, data: T | null, requestTraceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `PLOT-${status}` : "OK", message, data, traceId: requestTraceId, timestamp: Date.now() };
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function page(items: PlotRecord[], query: URLSearchParams): PageResult<PlotRecord> {
  const current = Math.max(1, Number(query.get("page") ?? 1) || 1);
  const size = Math.min(200, Math.max(1, Number(query.get("size") ?? 20) || 20));
  const keyword = (query.get("keyword") ?? "").trim().toLowerCase();
  const zoneCode = (query.get("zoneCode") ?? "").trim();
  const plotType = (query.get("plotType") ?? "").trim();
  const plotStatus = (query.get("plotStatus") ?? "").trim();
  const soilType = (query.get("soilType") ?? "").trim();
  const crop = (query.get("currentCrop") ?? "").trim().toLowerCase();
  // 面积区间：参数缺省或空串时按 NaN 处理（Number(null) 的 0 会把全部地块当成超限过滤掉）
  const parseArea = (name: string): number => {
    const raw = (query.get(name) ?? "").trim();
    return raw === "" ? Number.NaN : Number(raw);
  };
  const areaMin = parseArea("areaMin");
  const areaMax = parseArea("areaMax");
  // 类型/状态受库内 CHECK 约束，非法枚举直接 400，避免拼错参数时静默筛空
  if (plotType !== "" && !PLOT_TYPES.includes(plotType)) throw new Error(`plotType需为 ${PLOT_TYPES.join("/")}`);
  if (plotStatus !== "" && !PLOT_STATUSES.includes(plotStatus)) throw new Error(`plotStatus需为 ${PLOT_STATUSES.join("/")}`);
  const filtered = items.filter((item) => {
    if (zoneCode !== "" && item.zoneCode !== zoneCode) return false;
    if (plotType !== "" && item.plotType !== plotType) return false;
    if (plotStatus !== "" && item.plotStatus !== plotStatus) return false;
    if (soilType !== "" && item.soilType !== soilType) return false;
    if (crop !== "" && !(item.currentCrop ?? "").toLowerCase().includes(crop)) return false;
    if (Number.isFinite(areaMin) && item.areaMu < areaMin) return false;
    if (Number.isFinite(areaMax) && item.areaMu > areaMax) return false;
    // 关键词同时命中编码、名称、作物、负责人，覆盖列表页一个输入框的常见搜法
    return keyword.length === 0
      || item.parcelCode.toLowerCase().includes(keyword)
      || item.parcelName.toLowerCase().includes(keyword)
      || (item.currentCrop ?? "").toLowerCase().includes(keyword)
      || (item.ownerName ?? "").toLowerCase().includes(keyword);
  });
  const start = (current - 1) * size;
  return { items: filtered.slice(start, start + size), total: filtered.length, page: current, size, pages: Math.ceil(filtered.length / size) };
}

/** 片区入参中的边界：缺省与非法需要区分，缺省允许，非法报 400 */
function parsePolygon(value: unknown): { ok: boolean; geom?: GeoPolygon } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object") return { ok: false };
  const geom = value as GeoPolygon;
  const ring = geom.coordinates?.[0];
  if (geom.type !== "Polygon" || !Array.isArray(ring) || ring.length < 4) return { ok: false };
  return { ok: true, geom: { type: "Polygon", coordinates: geom.coordinates, srid: Number(geom.srid ?? 4490) } };
}

/** 片区视图：台账字段 + 成员地块统计；map 模式额外给凸包与中心点 */
export interface ZoneSummary extends PlotZone {
  plotCount: number;
  areaMu: number;
  hull: GeoPolygon | null;
  centroid: LngLat | null;
}

export function createPlotHttpServer(
  service: PlotService,
  infraLines: InfraLineRepository = new InMemoryInfraLineRepository(),
  zones: ZoneRepository = new InMemoryZoneRepository(),
): Server {
  const tenantOf = (request: IncomingMessage): string => request.headers["x-tenant-id"]?.toString() || "tenant-demo";

  /** 汇总片区统计；withGeometry 时由成员地块外轮廓算凸包，供一张图直接绘制 */
  const zoneSummaries = async (tenantId: string, withGeometry: boolean): Promise<ZoneSummary[]> => {
    const [list, plots] = await Promise.all([zones.listByTenant(tenantId), service.listByTenant(tenantId)]);
    return list.map((zone) => {
      const members = plots.filter((plot) => plot.zoneCode === zone.zoneCode);
      const points = members.flatMap((plot) => ringPoints(plot.geom));
      const summary: ZoneSummary = {
        ...zone,
        plotCount: members.length,
        areaMu: Number(members.reduce((sum, plot) => sum + plot.areaMu, 0).toFixed(2)),
        hull: withGeometry ? hullPolygon(points) : null,
        centroid: withGeometry ? centroidOf(points.length > 0 ? points : ringPoints(zone.geom)) : null,
      };
      return summary;
    });
  };

  return createServer(async (request, response) => {
    const requestTraceId = traceId(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok", service: "plot" }, requestTraceId);
        return;
      }
      const denied = authorizeRequest(request, { read: "plot:read", write: "plot:write" });
      if (denied) { send(response, denied.status, null, requestTraceId, denied.message); return; }
      if (url.pathname === `${API_PREFIX}/plots/stats` && request.method === "GET") {
        const plots = await service.listByTenant(request.headers["x-tenant-id"]?.toString() || "tenant-demo");
        const totalAreaMu = plots.reduce((sum, item) => sum + item.areaMu, 0);
        const byCrop = new Map<string, number>();
        for (const item of plots) {
          const crop = item.soilType ?? "UNKNOWN";
          byCrop.set(crop, (byCrop.get(crop) ?? 0) + item.areaMu);
        }
        const soilTypes = [...byCrop.entries()].map(([name, areaMu]) => ({ name, areaMu }));
        send(response, 200, { totalPlots: plots.length, totalAreaMu, soilTypes }, requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/plots/bounds` && request.method === "GET") {
        const plots = await service.listByTenant(request.headers["x-tenant-id"]?.toString() || "tenant-demo");
        send(response, 200, plots.map((item) => ({ parcelCode: item.parcelCode, parcelName: item.parcelName, areaMu: item.areaMu, geom: item.geom })), requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/plots` && request.method === "GET") {
        const tenantId = request.headers["x-tenant-id"]?.toString() || "tenant-demo";
        const plots = await service.listByTenant(tenantId);
        send(response, 200, page(plots, url.searchParams), requestTraceId);
        return;
      }
      // 管线必须先于 /plots/:code 匹配，否则 infra-lines 会被当成地块编码
      if (url.pathname === `${API_PREFIX}/plots/infra-lines` && request.method === "GET") {
        const tenantId = request.headers["x-tenant-id"]?.toString() || "tenant-demo";
        const type = url.searchParams.get("lineType");
        const lines = await infraLines.listByTenant(tenantId);
        send(response, 200, type ? lines.filter((line) => line.lineType === type) : lines, requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/plots/infra-lines` && request.method === "POST") {
        const input = await readJson(request);
        const lineName = String(input.lineName ?? "").trim();
        const lineType = String(input.lineType ?? "") as InfraLineType;
        if (lineName === "") {
          send(response, 400, null, requestTraceId, "管线名称不能为空");
          return;
        }
        if (!INFRA_LINE_TYPES.includes(lineType)) {
          send(response, 400, null, requestTraceId, `管线类型需为 ${INFRA_LINE_TYPES.join("/")}`);
          return;
        }
        const geom = input.geom as GeoLineString | undefined;
        if (!geom || geom.type !== "LineString" || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) {
          send(response, 400, null, requestTraceId, "管线几何需为至少两个点的 LineString");
          return;
        }
        const lineCode = typeof input.lineCode === "string" && input.lineCode !== "" ? input.lineCode : `LINE-${ulid().slice(-8)}`;
        if (await infraLines.findByCode(lineCode)) {
          send(response, 409, null, requestTraceId, `管线编码 ${lineCode} 已存在`);
          return;
        }
        const line: InfraLine = {
          id: ulid(),
          lineCode,
          lineName,
          lineType,
          tenantId: request.headers["x-tenant-id"]?.toString() || "tenant-demo",
          geom: { type: "LineString", coordinates: geom.coordinates, srid: Number(geom.srid ?? 4490) },
          lengthM: input.lengthM !== undefined ? Number(input.lengthM) : estimateLengthM(geom),
          createdAt: new Date().toISOString(),
        };
        await infraLines.create(undefined, line);
        send(response, 201, line, requestTraceId);
        return;
      }
      const lineMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/plots/infra-lines/([^/]+)$`));
      if (lineMatch?.[1] && request.method === "PUT") {
        const lineCode = decodeURIComponent(lineMatch[1]);
        if (!(await infraLines.findByCode(lineCode))) {
          send(response, 404, null, requestTraceId, "管线不存在");
          return;
        }
        const input = await readJson(request);
        const patch: InfraLinePatch = {};
        if (input.lineName !== undefined) {
          const lineName = String(input.lineName).trim();
          if (lineName === "") {
            send(response, 400, null, requestTraceId, "管线名称不能为空");
            return;
          }
          patch.lineName = lineName;
        }
        if (input.lineType !== undefined) {
          const lineType = String(input.lineType) as InfraLineType;
          if (!INFRA_LINE_TYPES.includes(lineType)) {
            send(response, 400, null, requestTraceId, `管线类型需为 ${INFRA_LINE_TYPES.join("/")}`);
            return;
          }
          patch.lineType = lineType;
        }
        if (input.geom !== undefined) {
          const geom = input.geom as GeoLineString | undefined;
          if (!geom || geom.type !== "LineString" || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) {
            send(response, 400, null, requestTraceId, "管线几何需为至少两个点的 LineString");
            return;
          }
          patch.geom = { type: "LineString", coordinates: geom.coordinates, srid: Number(geom.srid ?? 4490) };
        }
        if (input.lengthM !== undefined) {
          const lengthM = Number(input.lengthM);
          if (!Number.isFinite(lengthM) || lengthM < 0) {
            send(response, 400, null, requestTraceId, "管线长度需为非负数");
            return;
          }
          patch.lengthM = lengthM;
        } else if (patch.geom) {
          // 改了形状就按新折点重算里程，避免列表与地图上显示的长度和实际走向脱节
          patch.lengthM = estimateLengthM(patch.geom);
        }
        const updated = await infraLines.update(undefined, lineCode, patch);
        if (!updated) {
          send(response, 404, null, requestTraceId, "管线不存在");
          return;
        }
        send(response, 200, updated, requestTraceId);
        return;
      }
      if (lineMatch?.[1] && request.method === "DELETE") {
        const removed = await infraLines.remove(undefined, decodeURIComponent(lineMatch[1]), new Date().toISOString());
        if (!removed) {
          send(response, 404, null, requestTraceId, "管线不存在");
          return;
        }
        send(response, 200, null, requestTraceId);
        return;
      }
      // 片区：独立前缀 /zones，避免和 /plots/:code 的地块编码解析混在一起
      if (url.pathname === `${API_PREFIX}/zones` && request.method === "GET") {
        send(response, 200, await zoneSummaries(tenantOf(request), false), requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/zones/map` && request.method === "GET") {
        send(response, 200, await zoneSummaries(tenantOf(request), true), requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/zones` && request.method === "POST") {
        const input = await readJson(request);
        const zoneName = String(input.zoneName ?? "").trim();
        if (zoneName === "") {
          send(response, 400, null, requestTraceId, "片区名称不能为空");
          return;
        }
        const zoneCode = typeof input.zoneCode === "string" && input.zoneCode.trim() !== "" ? input.zoneCode.trim() : `ZONE-${ulid().slice(-6)}`;
        if (await zones.findByCode(zoneCode)) {
          send(response, 409, null, requestTraceId, `片区编码 ${zoneCode} 已存在`);
          return;
        }
        const parsed = parsePolygon(input.geom);
        if (!parsed.ok) {
          send(response, 400, null, requestTraceId, "片区边界需为至少四个点的闭合 Polygon");
          return;
        }
        const now = new Date().toISOString();
        const zone: PlotZone = {
          id: ulid(),
          zoneCode,
          zoneName,
          tenantId: tenantOf(request),
          farmId: typeof input.farmId === "string" && input.farmId !== "" ? input.farmId : "farm-kaijiang-01",
          color: typeof input.color === "string" && input.color !== "" ? input.color : "#00d4ff",
          createdAt: now,
          updatedAt: now,
        };
        if (typeof input.description === "string") zone.description = input.description;
        if (parsed.geom) zone.geom = parsed.geom;
        await zones.create(undefined, zone);
        send(response, 201, zone, requestTraceId);
        return;
      }
      // 地块划入/移出片区：归属只改 plot_records.zone_code，不另建关联表
      const zonePlotsMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/zones/([^/]+)/plots$`));
      const zonePlotCode = zonePlotsMatch?.[1] ? decodeURIComponent(zonePlotsMatch[1]) : undefined;
      if (zonePlotCode && request.method === "GET") {
        const members = (await service.listByTenant(tenantOf(request))).filter((plot) => plot.zoneCode === zonePlotCode);
        send(response, 200, members, requestTraceId);
        return;
      }
      if (zonePlotCode && request.method === "POST") {
        const input = await readJson(request);
        const parcelCode = typeof input.parcelCode === "string" ? input.parcelCode.trim() : "";
        if (parcelCode === "") {
          send(response, 400, null, requestTraceId, "需要 parcelCode 指定要划入的地块");
          return;
        }
        const zone = await zones.findByCode(zonePlotCode);
        if (!zone) {
          send(response, 404, null, requestTraceId, "片区不存在");
          return;
        }
        send(response, 200, await service.updatePlot(parcelCode, { zoneCode: zone.zoneCode }), requestTraceId);
        return;
      }
      const zonePlotOneMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/zones/([^/]+)/plots/([^/]+)$`));
      if (zonePlotOneMatch?.[1] && zonePlotOneMatch[2] && request.method === "DELETE") {
        send(response, 200, await service.updatePlot(decodeURIComponent(zonePlotOneMatch[2]), { zoneCode: null }), requestTraceId);
        return;
      }
      const zoneMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/zones/([^/]+)$`));
      const matchedZoneCode = zoneMatch?.[1] ? decodeURIComponent(zoneMatch[1]) : undefined;
      if (matchedZoneCode && request.method === "GET") {
        const summary = (await zoneSummaries(tenantOf(request), true)).find((zone) => zone.zoneCode === matchedZoneCode);
        if (!summary) {
          send(response, 404, null, requestTraceId, "片区不存在");
          return;
        }
        const members = (await service.listByTenant(tenantOf(request))).filter((plot) => plot.zoneCode === matchedZoneCode);
        send(response, 200, { ...summary, plots: members }, requestTraceId);
        return;
      }
      if (matchedZoneCode && request.method === "PUT") {
        const input = await readJson(request);
        const patch: Omit<ZonePatch, "updatedAt"> = {};
        if (typeof input.zoneName === "string" && input.zoneName.trim() !== "") patch.zoneName = input.zoneName.trim();
        if (typeof input.color === "string" && input.color !== "") patch.color = input.color;
        if (typeof input.description === "string") patch.description = input.description;
        const parsed = parsePolygon(input.geom);
        if (!parsed.ok) {
          send(response, 400, null, requestTraceId, "片区边界需为至少四个点的闭合 Polygon");
          return;
        }
        if (parsed.geom) patch.geom = parsed.geom;
        const updated = await zones.update(undefined, matchedZoneCode, { ...patch, updatedAt: new Date().toISOString() });
        if (!updated) {
          send(response, 404, null, requestTraceId, "片区不存在");
          return;
        }
        send(response, 200, updated, requestTraceId);
        return;
      }
      if (matchedZoneCode && request.method === "DELETE") {
        const zone = await zones.findByCode(matchedZoneCode);
        if (!zone) {
          send(response, 404, null, requestTraceId, "片区不存在");
          return;
        }
        // 有地块归属时不允许删片区，否则地块上的 zoneCode 会变成悬空引用
        const members = (await service.listByTenant(tenantOf(request))).filter((plot) => plot.zoneCode === zone.zoneCode);
        if (members.length > 0) {
          send(response, 409, null, requestTraceId, `片区下仍有 ${members.length} 块地块，请先移出`);
          return;
        }
        await zones.remove(undefined, zone.zoneCode, new Date().toISOString());
        send(response, 200, null, requestTraceId);
        return;
      }
      const codeMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/plots/([^/]+)$`));
      const plotCode = codeMatch?.[1];
      if (plotCode && request.method === "GET") {
        send(response, 200, await service.getByCode(decodeURIComponent(plotCode)), requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/plots` && request.method === "POST") {
        const input = await readJson(request);
        const record = await service.registerPlot({ ...(input as unknown as RegisterPlotInput), tenantId: request.headers["x-tenant-id"]?.toString() || "tenant-demo", traceId: requestTraceId });
        send(response, 201, record, requestTraceId);
        return;
      }
      if (plotCode && request.method === "PUT") {
        const input = await readJson(request);
        const patch: Omit<PlotPatch, "updatedAt"> = {};
        if (typeof input.parcelName === "string" || typeof input.name === "string") patch.parcelName = String(input.parcelName ?? input.name);
        if (input.areaMu !== undefined) patch.areaMu = Number(input.areaMu);
        if (typeof input.soilType === "string") patch.soilType = input.soilType;
        if (typeof input.zoneCode === "string" && input.zoneCode !== "") patch.zoneCode = input.zoneCode;
        else if (input.zoneCode === null || input.zoneCode === "") patch.zoneCode = null;
        // 档案字段：传空串表示清空，未传表示保持原值，与编辑页「清空输入框即删掉备注」的直觉一致
        for (const key of ["plotType", "plotStatus", "currentCrop", "ownerName", "ownerPhone", "remark"] as const) {
          const value = input[key];
          if (typeof value === "string") patch[key] = value.trim() === "" ? null : value.trim();
          else if (value === null) patch[key] = null;
        }
        if (input.geom && typeof input.geom === "object") patch.geom = input.geom as NonNullable<PlotPatch["geom"]>;
        send(response, 200, await service.updatePlot(decodeURIComponent(plotCode), patch), requestTraceId);
        return;
      }
      if (plotCode && request.method === "DELETE") {
        await service.removePlot(decodeURIComponent(plotCode));
        send(response, 200, null, requestTraceId);
        return;
      }
      send(response, 404, null, requestTraceId, "接口不存在");
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求处理失败";
      send(response, message.includes("不存在") ? 404 : 400, null, requestTraceId, message);
    }
  });
}



