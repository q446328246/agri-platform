import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { ApiResponse, GeoLineString, GeoPolygon, PageResult } from "@agri/contracts";
import { authorizeRequest, ulid, BizError } from "@agri/shared";

import { INFRA_LINE_TYPES, InMemoryInfraLineRepository, estimateLengthM } from "./infra-line.repository.js";
import type { InfraLine, InfraLinePatch, InfraLineRepository, InfraLineType } from "./infra-line.repository.js";
import { CROP_SEASON_STATUSES, InMemoryCropSeasonRepository, isValidFarmDate } from "./season.repository.js";
import type { CropSeason, CropSeasonPatch, CropSeasonRepository, CropSeasonStatus } from "./season.repository.js";
import { InMemoryPlotChangeLogRepository } from "./plot-change-log.repository.js";
import type { PlotChangeAction, PlotChangeLog, PlotChangeLogRepository } from "./plot-change-log.repository.js";
import type { PlotPatch, PlotRecord } from "./plot.repository.js";
import { PLOT_STATUSES, PLOT_TYPES } from "./plot.service.js";
import type { PlotService, RegisterPlotInput, SplitPlotPiece } from "./plot.service.js";
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
  seasons: CropSeasonRepository = new InMemoryCropSeasonRepository(),
  changeLogs: PlotChangeLogRepository = new InMemoryPlotChangeLogRepository(),
): Server {
  const tenantOf = (request: IncomingMessage): string => request.headers["x-tenant-id"]?.toString() || "tenant-demo";
  const actorOf = (request: IncomingMessage): string => request.headers["x-user-id"]?.toString() || "system";

  /** 档案字段 → 中文标签，用于把改动的键拼成人可读的变更摘要 */
  const PATCH_LABELS: Record<string, string> = {
    parcelName: "名称", areaMu: "面积", soilType: "土壤", zoneCode: "片区",
    plotType: "类型", plotStatus: "状态", currentCrop: "当前作物",
    ownerName: "负责人", ownerPhone: "联系电话", remark: "备注", geom: "边界",
  };
  /** 追加一条地块变更历史；日志写入失败不应让已成功的业务操作回退，故吞掉异常仅记 console */
  const logChange = async (request: IncomingMessage, parcelCode: string, action: PlotChangeAction, summary: string): Promise<void> => {
    const log: PlotChangeLog = {
      id: ulid(),
      parcelCode,
      tenantId: tenantOf(request),
      action,
      summary,
      actor: actorOf(request),
      createdAt: new Date().toISOString(),
    };
    try { await changeLogs.append(undefined, log); }
    catch (error) { console.warn("地块变更留痕写入失败", error instanceof Error ? error.message : error); }
  };

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
        const plotCode = (url.searchParams.get("plotCode") ?? "").trim();
        const lines = await infraLines.listByTenant(tenantId);
        send(response, 200, lines.filter((line) =>
          (!type || line.lineType === type) && (plotCode === "" || line.plotCode === plotCode),
        ), requestTraceId);
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
        const plotCode = String(input.plotCode ?? "").trim();
        if (plotCode !== "" && !(await service.exists(plotCode))) {
          send(response, 400, null, requestTraceId, `归属地块 ${plotCode} 不存在`);
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
          plotCode,
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
        if (input.plotCode !== undefined) {
          // 允许传空串解绑地块；非空时必须是本地已存在的地块编码，避免联动查询命中幽灵地块
          const plotCode = String(input.plotCode).trim();
          if (plotCode !== "" && !(await service.exists(plotCode))) {
            send(response, 400, null, requestTraceId, `归属地块 ${plotCode} 不存在`);
            return;
          }
          patch.plotCode = plotCode;
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
      // 种植季/茬口：前缀 /plots/seasons，须先于 /plots/:code 匹配，否则 seasons 会被当成地块编码
      if (url.pathname === `${API_PREFIX}/plots/seasons` && request.method === "GET") {
        const tenantId = tenantOf(request);
        const plotCode = (url.searchParams.get("plotCode") ?? "").trim();
        const crop = (url.searchParams.get("crop") ?? "").trim().toLowerCase();
        const status = (url.searchParams.get("status") ?? "").trim();
        const year = (url.searchParams.get("year") ?? "").trim();
        if (status !== "" && !CROP_SEASON_STATUSES.includes(status as CropSeasonStatus)) {
          send(response, 400, null, requestTraceId, `status需为 ${CROP_SEASON_STATUSES.join("/")}`);
          return;
        }
        const rows = plotCode !== ""
          ? await seasons.listByPlot(tenantId, plotCode)
          : (await seasons.listByTenant(tenantId)).sort((a, b) => b.seasonYear - a.seasonYear || a.plotCode.localeCompare(b.plotCode));
        send(response, 200, rows.filter((item) =>
          (crop === "" || item.crop.toLowerCase().includes(crop))
          && (status === "" || item.status === status)
          && (year === "" || String(item.seasonYear) === year),
        ), requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/plots/seasons` && request.method === "POST") {
        const input = await readJson(request);
        const plotCode = String(input.plotCode ?? "").trim();
        const crop = String(input.crop ?? "").trim();
        if (plotCode === "") {
          send(response, 400, null, requestTraceId, "所属地块不能为空");
          return;
        }
        if (!(await service.exists(plotCode))) {
          send(response, 400, null, requestTraceId, `所属地块 ${plotCode} 不存在`);
          return;
        }
        if (crop === "") {
          send(response, 400, null, requestTraceId, "作物名称不能为空");
          return;
        }
        const seasonYear = Number(input.seasonYear);
        if (!Number.isInteger(seasonYear) || seasonYear < 1900 || seasonYear > 2999) {
          send(response, 400, null, requestTraceId, "种植年份需为 1900~2999 的整数");
          return;
        }
        const seasonIndex = input.seasonIndex === undefined ? 1 : Number(input.seasonIndex);
        if (!Number.isInteger(seasonIndex) || seasonIndex < 1) {
          send(response, 400, null, requestTraceId, "茬次需为不小于 1 的整数");
          return;
        }
        const plantDate = String(input.plantDate ?? "").trim();
        const harvestDate = String(input.harvestDate ?? "").trim();
        if (!isValidFarmDate(plantDate) || !isValidFarmDate(harvestDate)) {
          send(response, 400, null, requestTraceId, "日期需为 YYYY-MM-DD 或留空");
          return;
        }
        if (plantDate !== "" && harvestDate !== "" && harvestDate < plantDate) {
          send(response, 400, null, requestTraceId, "采收日期不能早于栽插日期");
          return;
        }
        const status = (input.status === undefined ? "planned" : String(input.status)) as CropSeasonStatus;
        if (!CROP_SEASON_STATUSES.includes(status)) {
          send(response, 400, null, requestTraceId, `状态需为 ${CROP_SEASON_STATUSES.join("/")}`);
          return;
        }
        const yieldKg = input.yieldKg === undefined || input.yieldKg === null ? null : Number(input.yieldKg);
        if (yieldKg !== null && (!Number.isFinite(yieldKg) || yieldKg < 0)) {
          send(response, 400, null, requestTraceId, "产量需为非负数或留空");
          return;
        }
        const seasonCode = typeof input.seasonCode === "string" && input.seasonCode !== "" ? input.seasonCode : `SEASON-${ulid().slice(-8)}`;
        if (await seasons.findByCode(seasonCode)) {
          send(response, 409, null, requestTraceId, `种植季编码 ${seasonCode} 已存在`);
          return;
        }
        const record: CropSeason = {
          id: ulid(),
          seasonCode,
          plotCode,
          crop,
          variety: String(input.variety ?? "").trim(),
          seasonYear,
          seasonIndex,
          plantDate,
          harvestDate,
          status,
          yieldKg,
          note: String(input.note ?? "").trim(),
          tenantId: tenantOf(request),
          createdAt: new Date().toISOString(),
        };
        await seasons.create(undefined, record);
        send(response, 201, record, requestTraceId);
        return;
      }
      const seasonMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/plots/seasons/([^/]+)$`));
      if (seasonMatch?.[1] && request.method === "PUT") {
        const seasonCode = decodeURIComponent(seasonMatch[1]);
        if (!(await seasons.findByCode(seasonCode))) {
          send(response, 404, null, requestTraceId, "种植季不存在");
          return;
        }
        const input = await readJson(request);
        const patch: CropSeasonPatch = {};
        if (input.plotCode !== undefined) {
          const plotCode = String(input.plotCode).trim();
          if (plotCode === "" || !(await service.exists(plotCode))) {
            send(response, 400, null, requestTraceId, `所属地块 ${plotCode || "（空）"} 不存在`);
            return;
          }
          patch.plotCode = plotCode;
        }
        if (input.crop !== undefined) {
          const crop = String(input.crop).trim();
          if (crop === "") {
            send(response, 400, null, requestTraceId, "作物名称不能为空");
            return;
          }
          patch.crop = crop;
        }
        if (input.variety !== undefined) patch.variety = String(input.variety).trim();
        if (input.seasonYear !== undefined) {
          const seasonYear = Number(input.seasonYear);
          if (!Number.isInteger(seasonYear) || seasonYear < 1900 || seasonYear > 2999) {
            send(response, 400, null, requestTraceId, "种植年份需为 1900~2999 的整数");
            return;
          }
          patch.seasonYear = seasonYear;
        }
        if (input.seasonIndex !== undefined) {
          const seasonIndex = Number(input.seasonIndex);
          if (!Number.isInteger(seasonIndex) || seasonIndex < 1) {
            send(response, 400, null, requestTraceId, "茬次需为不小于 1 的整数");
            return;
          }
          patch.seasonIndex = seasonIndex;
        }
        if (input.plantDate !== undefined) {
          const plantDate = String(input.plantDate).trim();
          if (!isValidFarmDate(plantDate)) {
            send(response, 400, null, requestTraceId, "栽插日期需为 YYYY-MM-DD 或留空");
            return;
          }
          patch.plantDate = plantDate;
        }
        if (input.harvestDate !== undefined) {
          const harvestDate = String(input.harvestDate).trim();
          if (!isValidFarmDate(harvestDate)) {
            send(response, 400, null, requestTraceId, "采收日期需为 YYYY-MM-DD 或留空");
            return;
          }
          patch.harvestDate = harvestDate;
        }
        if ((patch.plantDate !== undefined || patch.harvestDate !== undefined)) {
          const current = await seasons.findByCode(seasonCode);
          const plantDate = patch.plantDate ?? current?.plantDate ?? "";
          const harvestDate = patch.harvestDate ?? current?.harvestDate ?? "";
          if (plantDate !== "" && harvestDate !== "" && harvestDate < plantDate) {
            send(response, 400, null, requestTraceId, "采收日期不能早于栽插日期");
            return;
          }
        }
        if (input.status !== undefined) {
          const status = String(input.status) as CropSeasonStatus;
          if (!CROP_SEASON_STATUSES.includes(status)) {
            send(response, 400, null, requestTraceId, `状态需为 ${CROP_SEASON_STATUSES.join("/")}`);
            return;
          }
          patch.status = status;
        }
        if (input.yieldKg !== undefined) {
          const yieldKg = input.yieldKg === null ? null : Number(input.yieldKg);
          if (yieldKg !== null && (!Number.isFinite(yieldKg) || yieldKg < 0)) {
            send(response, 400, null, requestTraceId, "产量需为非负数或留空");
            return;
          }
          patch.yieldKg = yieldKg;
        }
        if (input.note !== undefined) patch.note = String(input.note).trim();
        const updated = await seasons.update(undefined, seasonCode, patch);
        if (!updated) {
          send(response, 404, null, requestTraceId, "种植季不存在");
          return;
        }
        send(response, 200, updated, requestTraceId);
        return;
      }
      if (seasonMatch?.[1] && request.method === "DELETE") {
        const removed = await seasons.remove(undefined, decodeURIComponent(seasonMatch[1]), new Date().toISOString());
        if (!removed) {
          send(response, 404, null, requestTraceId, "种植季不存在");
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
      // 合并/拆分：静态前缀路由，必须先于 /plots/:code 匹配，否则 merge/split 会被当成地块编码
      if (url.pathname === `${API_PREFIX}/plots/merge` && request.method === "POST") {
        const input = await readJson(request);
        const parcelCodes = Array.isArray(input.parcelCodes) ? input.parcelCodes.map(String) : [];
        if (parcelCodes.length < 2) {
          send(response, 400, null, requestTraceId, "parcelCodes 至少需要两个地块编码");
          return;
        }
        // 档案字段：字符串才覆盖、未传保持继承；exactOptionalPropertyTypes 下不能把 undefined 塞进可选属性
        const optionalFields: Record<string, string> = {};
        for (const key of ["parcelName", "soilType", "zoneCode", "plotType", "plotStatus", "currentCrop", "ownerName", "ownerPhone", "remark"] as const) {
          if (typeof input[key] === "string") optionalFields[key] = input[key] as string;
        }
        const result = await service.mergePlots({
          tenantId: tenantOf(request),
          traceId: requestTraceId,
          parcelCodes,
          ...optionalFields,
        });
        // 留痕与归档解耦：合并已提交，日志写不进只告警，不回滚业务
        await logChange(request, result.plot.parcelCode, "MERGE", `合并生成：由 ${result.sourceCodes.join("、")} 合并，面积 ${result.plot.areaMu} 亩（按合并边界现算）`);
        for (const code of result.sourceCodes) {
          await logChange(request, code, "DELETE", `已合并至 ${result.plot.parcelCode}（原地块归档，管线/种植季仍指向本编码，历史可回查）`);
        }
        send(response, 201, result, requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/plots/split` && request.method === "POST") {
        const input = await readJson(request);
        const parcelCode = String(input.parcelCode ?? "").trim();
        if (parcelCode === "") {
          send(response, 400, null, requestTraceId, "parcelCode 不能为空");
          return;
        }
        const rawPieces = Array.isArray(input.pieces) ? input.pieces : [];
        if (rawPieces.length < 2) {
          send(response, 400, null, requestTraceId, "pieces 至少需要两个子地块边界");
          return;
        }
        const pieces: SplitPlotPiece[] = rawPieces.map((item) => {
          const piece = (item ?? {}) as Record<string, unknown>;
          return {
            parcelName: String(piece.parcelName ?? ""),
            geom: piece.geom as SplitPlotPiece["geom"],
            ...(typeof piece.plotType === "string" ? { plotType: piece.plotType } : {}),
            ...(typeof piece.plotStatus === "string" ? { plotStatus: piece.plotStatus } : {}),
          };
        });
        const result = await service.splitPlot({
          tenantId: tenantOf(request),
          traceId: requestTraceId,
          parcelCode,
          pieces,
          keepSource: input.keepSource === true,
        });
        const pieceCodes = result.plots.map((plot) => plot.parcelCode).join("、");
        await logChange(request, result.sourceCode, result.sourceRemoved ? "DELETE" : "UPDATE",
          result.sourceRemoved
            ? `已拆分为：${pieceCodes}（原子地块合计 ${result.pieceAreaSum} 亩）`
            : `拆分出 ${result.plots.length} 块子地块（保留原地块，未归档）`);
        for (const plot of result.plots) {
          await logChange(request, plot.parcelCode, "SPLIT", `拆分生成：由 ${result.sourceCode} 拆出，面积 ${plot.areaMu} 亩（按子地块边界现算）`);
        }
        send(response, 201, result, requestTraceId);
        return;
      }
      const codeMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/plots/([^/]+)$`));
      const plotCode = codeMatch?.[1];
      const historyMatch = url.pathname.match(new RegExp(`^${API_PREFIX}/plots/([^/]+)/history$`));
      const historyCode = historyMatch?.[1];
      if (historyCode && request.method === "GET") {
        send(response, 200, await changeLogs.listByPlot(tenantOf(request), decodeURIComponent(historyCode)), requestTraceId);
        return;
      }
      if (plotCode && request.method === "GET") {
        send(response, 200, await service.getByCode(decodeURIComponent(plotCode)), requestTraceId);
        return;
      }
      if (url.pathname === `${API_PREFIX}/plots` && request.method === "POST") {
        const input = await readJson(request);
        const record = await service.registerPlot({ ...(input as unknown as RegisterPlotInput), tenantId: request.headers["x-tenant-id"]?.toString() || "tenant-demo", traceId: requestTraceId });
        await logChange(request, record.parcelCode, "CREATE", `建档：新增地块「${record.parcelName}」，面积 ${record.areaMu} 亩`);
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
        const code = decodeURIComponent(plotCode);
        const updated = await service.updatePlot(code, patch);
        const changed = Object.keys(patch)
          .filter((key) => key !== "updatedAt")
          .map((key) => PATCH_LABELS[key] ?? key);
        if (changed.length > 0) await logChange(request, code, "UPDATE", `修改：${changed.join("、")}`);
        send(response, 200, updated, requestTraceId);
        return;
      }
      if (plotCode && request.method === "DELETE") {
        const code = decodeURIComponent(plotCode);
        await service.removePlot(code);
        await logChange(request, code, "DELETE", "删除：地块已归档移除（软删）");
        send(response, 200, null, requestTraceId);
        return;
      }
      send(response, 404, null, requestTraceId, "接口不存在");
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求处理失败";
      // BizError 自带 httpStatus（400/404/409），优先按它回状态码；
      // 其余裸 Error（如 JSON 解析失败）维持旧口径按文案猜，兼容既有断言。
      const status = error instanceof BizError ? error.httpStatus : message.includes("不存在") ? 404 : 400;
      send(response, status, null, requestTraceId, message);
    }
  });
}



