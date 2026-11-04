import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { ApiResponse, PageResult } from "@agri/contracts";

import type { PlotPatch, PlotRecord } from "./plot.repository.js";
import type { PlotService, RegisterPlotInput } from "./plot.service.js";

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
  const filtered = keyword.length === 0 ? items : items.filter((item) => item.parcelCode.toLowerCase().includes(keyword) || item.parcelName.toLowerCase().includes(keyword));
  const start = (current - 1) * size;
  return { items: filtered.slice(start, start + size), total: filtered.length, page: current, size, pages: Math.ceil(filtered.length / size) };
}

export function createPlotHttpServer(service: PlotService): Server {
  return createServer(async (request, response) => {
    const requestTraceId = traceId(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok", service: "plot" }, requestTraceId);
        return;
      }
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



