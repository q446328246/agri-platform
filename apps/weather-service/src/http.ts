import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest, identityHeaders } from "@agri/shared";

import { InMemoryAlertRepository, WEATHER_ALERT_LEVELS, WEATHER_ALERT_TYPES } from "./alert.repository.js";
import type { AlertQuery, WeatherAlert } from "./alert.repository.js";
import { demoAlerts, demoForecastDays, demoForecastHours } from "./demo.js";
import { InMemoryForecastRepository } from "./forecast.repository.js";
import type { ForecastRepository, WeatherForecastDay, WeatherHourlyPoint } from "./forecast.repository.js";
import { WEATHER_METRICS, buildAdvice } from "./weather.js";
import { farmToday } from "./farm-time.js";

const API_PREFIX = "/api/v1/weather";
const CITY = "达州市";

/** 依赖注入：SQL 模式由启动层注入仓储，内存模式使用演示种子 */
export interface WeatherDependencies {
  forecasts?: ForecastRepository;
  alerts?: { list(query?: AlertQuery): Promise<WeatherAlert[]>; create(tx: unknown, alert: WeatherAlert): Promise<WeatherAlert> };
  /** 气象站读数来源：遥测服务的最新读数与历史曲线 */
  telemetryUrl?: string | undefined;
  /** 单测可注入 fetch，缺省使用全局 fetch */
  fetchReading?: (url: string, headers: Record<string, string>) => Promise<{ data: unknown } | null>;
  /** 预报数据源标识："demo" / "sql" / "qweather"；返回体透传到 dataSource 字段，便于前端展示。
   *  注意：三种模式下前端各接口读取的都是本地仓储，外部 API 只在同步器内部按周期调用 */
  source?: "demo" | "sql" | "qweather";
  /** 和风同步器实时统计（启用时提供），用于 /sync-status 端点与 dataSource 判定 */
  syncStats?: () =>
    | {
        dataSource: "qweather" | "local";
        lastForecastSyncAt?: string | undefined;
        lastAlertSyncAt?: string | undefined;
        forecastSyncCount?: number | undefined;
        alertSyncCount?: number | undefined;
        todayCalls?: number | undefined;
        dailyCallLimit?: number | undefined;
        callCountDate?: string | undefined;
        lastForecastError?: string | undefined;
        lastAlertError?: string | undefined;
        forceSyncCount?: number | undefined;
        lastForceSyncAt?: string | undefined;
      }
    | undefined;
  /** 管理员强制同步入口：bypass dailyCallLimit，未启用同步器时缺省 */
  syncNow?: () => Promise<{ forecast: boolean; alerts: boolean; error?: string | undefined }>;
}

/** 要素读数：目录元信息与最新读数合并后的展示单元 */
interface WeatherElement {
  key: string;
  label: string;
  unit: string;
  scene: string;
  value: number | null;
  deviceId?: string;
  plotCode?: string;
  recordedAt?: string;
}

interface ReadingLike {
  deviceId: string;
  plotCode: string;
  metric: string;
  value: number;
  unit: string;
  recordedAt: string;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `WEATHER-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trace(req: IncomingMessage): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

function paginate<T>(items: T[], query: URLSearchParams): PageResult<T> {
  const current = Math.max(1, Number(query.get("page") ?? 1) || 1);
  const size = Math.min(200, Math.max(1, Number(query.get("size") ?? 20) || 20));
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), total: items.length, page: current, size, pages: Math.ceil(items.length / size) };
}

/** 空串按「未传」处理，避免 ?metric= 这类地址栏把筛选当成空值精确匹配 */
function param(query: URLSearchParams, name: string): string | undefined {
  const raw = (query.get(name) ?? "").trim();
  return raw === "" ? undefined : raw;
}

function paramNumber(query: URLSearchParams, name: string): number | undefined {
  const raw = (query.get(name) ?? "").trim();
  return raw === "" || !Number.isFinite(Number(raw)) ? undefined : Number(raw);
}

/** 纯日期补齐到当天末尾，作为区间右端 */
function endOfDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}

export function createWeatherHttpServer(dependencies: WeatherDependencies = {}): Server {
  const forecastSeed = { days: demoForecastDays(), hours: demoForecastHours() };
  const forecasts = dependencies.forecasts ?? new InMemoryForecastRepository(forecastSeed);
  const alerts = dependencies.alerts ?? new InMemoryAlertRepository(demoAlerts());
  const telemetryUrl = dependencies.telemetryUrl ?? process.env.TELEMETRY_SERVICE_URL ?? "http://127.0.0.1:3004";
  const metricKeys = WEATHER_METRICS.map((metric) => metric.key);
  /** 当前预报数据源：优先取 syncStats（反映实时同步状态），否则取启动时的 source 声明 */
  function currentSource(): { dataSource: "demo" | "sql" | "qweather" | "local"; lastSyncAt?: string | undefined } {
    const stats = dependencies.syncStats?.();
    if (stats?.dataSource === "qweather") return { dataSource: "qweather", lastSyncAt: stats.lastForecastSyncAt };
    return { dataSource: dependencies.source ?? "demo", lastSyncAt: stats?.lastForecastSyncAt };
  }

  /** 读取遥测服务：失败返回 null，由调用方保留兜底 */
  async function readTelemetry(path: string, identity: Record<string, string>): Promise<ReadingLike[] | null> {
    try {
      if (dependencies.fetchReading) {
        const payload = await dependencies.fetchReading(`${telemetryUrl}${path}`, identity);
        const data = payload?.data;
        return Array.isArray(data) ? (data as ReadingLike[]) : null;
      }
      // 部署环境服务侧守卫为 enforce，不带身份头会被遥测判 401，实时气象站与历史曲线就整块空掉
      const response = await fetch(`${telemetryUrl}${path}`, { headers: identity, signal: AbortSignal.timeout(2500) });
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: unknown };
      return Array.isArray(payload.data) ? (payload.data as ReadingLike[]) : null;
    } catch {
      return null;
    }
  }

  /** 七日 + 逐小时 + 作业提示的统一装配，forecast 与 advice 两个接口共用 */
  async function loadOutlook(days: number, hours: number) {
    const list = await forecasts.upcoming(new Date(), days);
    const hourly = await forecasts.hourly(new Date(), hours);
    const refreshedAt = list[0]?.refreshedAt ?? new Date().toISOString();
    const advice = buildAdvice(list, hourly, CITY);
    // today 用农场时区给出，前端据此判定「今天」，不再把数组第一条当作今天
    return { list, hourly, refreshedAt, advice, today: farmToday() };
  }

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { status: "ok", service: "weather" }, traceId);
        return;
      }
      const denied = authorizeRequest(req, {
        read: "weather:read",
        write: "weather:read",
        // 强制同步需 weather:sync（管理员），admin 默认 ["*"] 通配覆盖
        pathPermissions: [{ prefix: `${API_PREFIX}/sync-now`, permission: "weather:sync" }],
      });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 要素目录：前端下拉与文档 6.5 表格同源
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/metrics`) {
        send(res, 200, WEATHER_METRICS, traceId);
        return;
      }

      // 同步器状态：运维查看每日和风调用额度使用与最近一次同步时间；未启用同步器时返回 enabled=false
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/sync-status`) {
        const stats = dependencies.syncStats?.();
        if (!stats) {
          send(res, 200, { enabled: false, dataSource: dependencies.source ?? "demo" }, traceId);
          return;
        }
        send(res, 200, { enabled: true, ...stats }, traceId);
        return;
      }

      // 管理员强制同步：bypass dailyCallLimit，不受定时周期与硬上限约束，仅写入本地仓储
      if (req.method === "POST" && url.pathname === `${API_PREFIX}/sync-now`) {
        if (!dependencies.syncNow) {
          send(res, 501, null, traceId, "未启用和风同步（缺 QWEATHER_KEY），无法强制同步");
          return;
        }
        const result = await dependencies.syncNow();
        const src = currentSource();
        send(res, 200, { ...result, dataSource: src.dataSource, at: new Date().toISOString() }, traceId, result.error ?? "强制同步完成");
        return;
      }

      // 气象站实时读数：转发遥测最新读数并按文档要素排序
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/realtime`) {
        const plotCode = param(url.searchParams, "plotCode");
        const deviceId = param(url.searchParams, "deviceId");
        const query = deviceId
          ? `/api/v1/telemetry/latest?deviceId=${encodeURIComponent(deviceId)}`
          : plotCode
            ? `/api/v1/telemetry/latest?plotCode=${encodeURIComponent(plotCode)}`
            : "/api/v1/telemetry/latest";
        const readings = await readTelemetry(query, identityHeaders(req));
        const known = (readings ?? []).filter((item) => metricKeys.includes(item.metric));
        const elements: WeatherElement[] = WEATHER_METRICS.map((metric) => {
          const hit = known.find((item) => item.metric === metric.key);
          const element: WeatherElement = { key: metric.key, label: metric.label, unit: hit?.unit || metric.unit, scene: metric.scene, value: hit?.value ?? null };
          if (hit) {
            element.deviceId = hit.deviceId;
            element.recordedAt = hit.recordedAt;
            if (hit.plotCode) element.plotCode = hit.plotCode;
          }
          return element;
        });
        const stationOnline = known.length > 0;
        send(res, 200, {
          location: CITY,
          dataSource: stationOnline ? "telemetry" : "unavailable",
          stationStatus: stationOnline ? "ONLINE" : "UNKNOWN",
          refreshedAt: elements.map((item) => item.recordedAt).filter(Boolean).sort().reverse()[0] ?? new Date().toISOString(),
          elements,
        }, traceId);
        return;
      }

      // 逐小时预报：未来 24/48 小时，用于作业窗口与曲线
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/forecast/hourly`) {
        const hours = Math.min(120, paramNumber(url.searchParams, "hours") ?? 48);
        const hourly = await forecasts.hourly(new Date(), hours);
        const src = currentSource();
        send(res, 200, { location: CITY, hours, dataSource: src.dataSource, hourly, refreshedAt: hourly[0]?.refreshedAt ?? new Date().toISOString() }, traceId);
        return;
      }

      // 七日预报：首页面板数据，附农事作业提示（文档 5.3）
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/forecast`) {
        const days = Math.min(15, paramNumber(url.searchParams, "days") ?? 7);
        const wantHours = param(url.searchParams, "hours");
        const hourLimit = wantHours === undefined ? 0 : Math.min(120, Number(wantHours) || 0);
        const outlook = await loadOutlook(days, hourLimit > 0 ? hourLimit : 24);
        const src = currentSource();
        send(res, 200, {
          location: CITY,
          city: CITY,
          dataSource: src.dataSource,
          today: outlook.today,
          forecast: outlook.list,
          refreshedAt: outlook.refreshedAt,
          headline: outlook.advice.headline,
          advice: outlook.advice.items,
          judges: outlook.advice.judges,
          ...(hourLimit > 0 ? { hourly: outlook.hourly } : {}),
        }, traceId);
        return;
      }

      // 农事作业提示：单独暴露给决策服务与首页快捷查询
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/advice`) {
        const outlook = await loadOutlook(7, 24);
        const src = currentSource();
        send(res, 200, { location: CITY, dataSource: src.dataSource, headline: outlook.advice.headline, items: outlook.advice.items, judges: outlook.advice.judges, refreshedAt: outlook.refreshedAt }, traceId);
        return;
      }

      // 气象灾害预警：支持级别/类型/地块筛选与只看有效
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/alerts`) {
        const query = url.searchParams;
        const level = param(query, "level");
        const alertType = param(query, "alertType");
        if (level && !WEATHER_ALERT_LEVELS.includes(level as (typeof WEATHER_ALERT_LEVELS)[number])) {
          send(res, 400, null, traceId, `level需为 ${WEATHER_ALERT_LEVELS.join("/")}`);
          return;
        }
        if (alertType && !WEATHER_ALERT_TYPES.includes(alertType as (typeof WEATHER_ALERT_TYPES)[number])) {
          send(res, 400, null, traceId, `alertType需为 ${WEATHER_ALERT_TYPES.join("/")}`);
          return;
        }
        const activeOnly = (param(query, "active") ?? "true") !== "false";
        const rows = await alerts.list({
          ...(level ? { level } : {}),
          ...(alertType ? { alertType } : {}),
          ...(param(query, "plotCode") ? { plotCode: param(query, "plotCode") } : {}),
          ...(activeOnly ? { activeOnly: true } : {}),
        });
        send(res, 200, paginate(rows, query), traceId);
        return;
      }

      // 气象历史曲线：转发遥测历史读数，指标白名单校验（文档 6.5「按时间范围查看历史数据与变化曲线」）
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/history`) {
        const query = url.searchParams;
        const metric = param(query, "metric") ?? "airTemperature";
        if (!metricKeys.includes(metric)) {
          send(res, 400, null, traceId, `metric需为 ${metricKeys.join("/")}`);
          return;
        }
        const deviceId = param(query, "deviceId");
        const plotCode = param(query, "plotCode");
        const from = param(query, "from");
        const to = param(query, "to");
        const limit = Math.min(2000, paramNumber(query, "size") ?? 200);
        const parts = [`metric=${encodeURIComponent(metric)}`, `limit=${limit}`];
        if (deviceId) parts.push(`deviceId=${encodeURIComponent(deviceId)}`);
        if (plotCode) parts.push(`plotCode=${encodeURIComponent(plotCode)}`);
        if (from) parts.push(`from=${encodeURIComponent(from)}`);
        if (to) parts.push(`to=${encodeURIComponent(endOfDay(to))}`);
        const rows = (await readTelemetry(`/api/v1/telemetry/history?${parts.join("&")}`, identityHeaders(req))) ?? [];
        const meta = WEATHER_METRICS.find((item) => item.key === metric);
        const points = rows
          .map((row) => ({ recordedAt: row.recordedAt, value: Number(row.value), unit: row.unit }))
          .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        const values = points.map((point) => point.value);
        send(res, 200, {
          metric,
          label: meta?.label ?? metric,
          unit: meta?.unit ?? (points[0]?.unit ?? ""),
          location: CITY,
          points,
          stats: values.length > 0
            ? { min: Math.min(...values), max: Math.max(...values), avg: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)), count: values.length }
            : { min: null, max: null, avg: null, count: 0 },
        }, traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}

export type { WeatherForecastDay, WeatherHourlyPoint, WeatherAlert };
