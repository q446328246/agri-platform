import { readFileSync } from "node:fs";
import type { ForecastRepository } from "./forecast.repository.js";
import type { WeatherAlert } from "./alert.repository.js";
import {
  createEd25519JwtSigner,
  createQWeatherClient,
  getQWeatherMapper,
  type QWeatherApiVersion,
  type QWeatherClient,
  type QWeatherConfig,
  type QWeatherJwtSigner,
  type QWeatherMapper,
  type FetchLike,
} from "./qweather.js";

/**
 * 和风天气同步器：把外部 API 数据落到本地 weather_forecasts / weather_forecast_hours / weather_alerts，
 * 前端接口端点始终读本地仓储，不会因页面刷新触发外部请求。
 *
 * 免费额度约束（和风开发者个人版）：
 * - 每个 Key 每日调用上限约 1000 次；本项目按“每日一次拉取 + 前端只读 DB”设计，
 *   默认 forecast / alert 刷新间隔 1440 分钟（每日一次），一天最多消耗 2 次额度；
 * - 启动时会先检查本地最近一次刷新时间，如果尚在周期内则跳过初次同步，避免服务反复重启浪费额度；
 * - 内置每日调用硬上限（dailyCallLimit，默认 20，跨自然日自动清零），达到上限后本次调用直接跳过并 warn，
 *   防止异常场景（如手动反复触发 syncForecastNow）把额度打满；
 * - 任意一次外部调用失败只做 warn，保留旧数据，接口可用性不受影响。
 */

export interface AlertRepositoryLike {
  list(query?: { level?: string | undefined; alertType?: string | undefined; plotCode?: string | undefined; activeOnly?: boolean | undefined }): Promise<WeatherAlert[]>;
  create(tx: unknown, alert: WeatherAlert): Promise<WeatherAlert>;
  deactivate(alertCode: string): Promise<boolean>;
}

export interface SyncLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface WeatherSyncerConfig {
  client: QWeatherClient;
  /** 数据映射器；缺省按 v1 结构（项目默认）。v7 场景传入 getQWeatherMapper("v7") */
  mapper?: QWeatherMapper;
  forecasts: ForecastRepository;
  alerts: AlertRepositoryLike;
  city: string;
  logger: SyncLogger;
  /** 预报/逐小时刷新间隔分钟，默认 1440（每日一次，与和风免费额度对齐） */
  forecastRefreshMinutes?: number;
  /** 预警刷新间隔分钟，默认 1440（每日一次）；若关注突发灾害可调短，仍在免费额度内 */
  alertRefreshMinutes?: number;
  /** 本地时次保留窗口（早于当前时间该小时数的记录会被清理），默认 72 小时 */
  hourlyRetainHours?: number;
  /** 每日外部 API 调用硬上限（forecast + alert 合计），默认 20；跨自然日自动清零 */
  dailyCallLimit?: number;
  /** 当前日期注入点，方便单测跨天清零逻辑 */
  now?: () => Date;
}

export interface SyncerStats {
  lastForecastSyncAt: string | undefined;
  lastAlertSyncAt: string | undefined;
  lastForecastError: string | undefined;
  lastAlertError: string | undefined;
  forecastSyncCount: number;
  alertSyncCount: number;
  dataSource: "qweather" | "local";
  /** 今日已消耗调用次数（定时同步+手动强制均计数；手动强制不走上限判定） */
  todayCalls: number;
  /** 每日定时同步的硬上限（手动强制 bypass，不计入该上限） */
  dailyCallLimit: number;
  /** 计数所属自然日 YYYY-MM-DD */
  callCountDate: string;
  /** 手动强制同步累计次数（不计入 dailyCallLimit） */
  forceSyncCount: number;
  /** 上一次手动强制同步时间 ISO */
  lastForceSyncAt: string | undefined;
}

export interface WeatherSyncer {
  start(): void;
  stop(): void;
  syncForecastNow(): Promise<void>;
  syncAlertsNow(): Promise<void>;
  /** 手动强制同步（管理员）：bypass dailyCallLimit，不走上限判定，仅受于今天计数 */
  forceSync(): Promise<{ forecast: boolean; alerts: boolean; error?: string }>;
  stats(): SyncerStats;
}

/** YYYY-MM-DD（本地日历日，与调用侧 reset 判定一致） */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function createWeatherSyncer(config: WeatherSyncerConfig): WeatherSyncer {
  const forecastIntervalMs = Math.max(1, config.forecastRefreshMinutes ?? 1440) * 60_000;
  const alertIntervalMs = Math.max(1, config.alertRefreshMinutes ?? 1440) * 60_000;
  const retainHours = Math.max(6, config.hourlyRetainHours ?? 72);
  const dailyLimit = Math.max(1, config.dailyCallLimit ?? 20);
  const now = config.now ?? (() => new Date());
  const mapper = config.mapper ?? getQWeatherMapper("v1");

  const stats: SyncerStats = {
    lastForecastSyncAt: undefined,
    lastAlertSyncAt: undefined,
    lastForecastError: undefined,
    lastAlertError: undefined,
    forecastSyncCount: 0,
    alertSyncCount: 0,
    dataSource: "local",
    todayCalls: 0,
    dailyCallLimit: dailyLimit,
    callCountDate: localDate(now()),
    forceSyncCount: 0,
    lastForceSyncAt: undefined,
  };

  let forecastTimer: NodeJS.Timeout | undefined;
  let alertTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  /** 跨自然日清零；达到上限返回 false 由调用侧跳过外部请求 */
  function acquireQuota(): boolean {
    const today = localDate(now());
    if (today !== stats.callCountDate) {
      stats.callCountDate = today;
      stats.todayCalls = 0;
    }
    if (stats.todayCalls >= dailyLimit) return false;
    stats.todayCalls += 1;
    return true;
  }

  /** 手动强制同步 bypass 上限判定，但仍刷新 callCountDate 与 todayCalls，方便观测 */
  function acquireForceQuota(): void {
    const today = localDate(now());
    if (today !== stats.callCountDate) {
      stats.callCountDate = today;
      stats.todayCalls = 0;
    }
    stats.todayCalls += 1;
  }

  /** 判断 ISO 时间是否仍在给定周期毫秒内（用于冷启动跳过） */
  function withinInterval(iso: string | undefined, intervalMs: number): boolean {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return false;
    return now().getTime() - t < intervalMs;
  }

  async function syncForecastOnce(): Promise<void> {
    if (!acquireQuota()) {
      config.logger.warn("已达每日和风调用上限，跳过预报同步", { limit: dailyLimit, today: stats.todayCalls });
      return;
    }
    await performForecastSync();
  }

  /** 实际拉取预报的内部实现，不经过额度判定 */
  async function performForecastSync(): Promise<void> {
    const refreshedAt = new Date().toISOString();
    try {
      const [daily, hourly] = await Promise.all([config.client.fetchDaily3(), config.client.fetchHourly24()]);
      for (const item of daily) {
        await config.forecasts.upsertDay(mapper.mapDaily(item, config.city, refreshedAt));
      }
      for (const item of hourly) {
        await config.forecasts.upsertHour(mapper.mapHourly(item, refreshedAt));
      }
      // 顺带清理过期时次，避免长期运行导致表膨胀
      if (config.forecasts.deleteHoursBefore) {
        await config.forecasts.deleteHoursBefore(new Date(now().getTime() - retainHours * 3_600_000));
      }
      stats.lastForecastSyncAt = refreshedAt;
      stats.lastForecastError = undefined;
      stats.forecastSyncCount += 1;
      stats.dataSource = "qweather";
      config.logger.info("和风天气同步完成", { daily: daily.length, hourly: hourly.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.lastForecastError = message;
      config.logger.warn("和风天气同步失败，保留旧数据", { error: message });
    }
  }

  async function syncAlertsOnce(): Promise<void> {
    if (!acquireQuota()) {
      config.logger.warn("已达每日和风调用上限，跳过预警同步", { limit: dailyLimit, today: stats.todayCalls });
      return;
    }
    await performAlertsSync();
  }

  async function performAlertsSync(): Promise<void> {
    try {
      const list = await config.client.fetchWarning();
      const incomingCodes = new Set<string>();
      for (const item of list) {
        const alert = mapper.mapWarning(item, config.city);
        incomingCodes.add(alert.alertCode);
        await config.alerts.create(undefined, alert);
      }
      // 和风已撤销但本地仍 active 的预警自动解除
      const active = await config.alerts.list({ activeOnly: true });
      for (const row of active) {
        if (row.alertCode.startsWith("QW-") && !incomingCodes.has(row.alertCode)) {
          await config.alerts.deactivate(row.alertCode);
        }
      }
      stats.lastAlertSyncAt = new Date().toISOString();
      stats.lastAlertError = undefined;
      stats.alertSyncCount += 1;
      config.logger.info("和风天气预警同步完成", { total: list.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.lastAlertError = message;
      config.logger.warn("和风天气预警同步失败，保留旧预警", { error: message });
    }
  }

  /** 冷启动检查：若本地已有周期内的数据则不重复请求外部 */
  async function shouldSkipForecastInitial(): Promise<boolean> {
    try {
      const last = await config.forecasts.lastRefreshedAt();
      return withinInterval(last, forecastIntervalMs);
    } catch {
      return false;
    }
  }

  async function shouldSkipAlertInitial(): Promise<boolean> {
    try {
      const rows = await config.alerts.list({});
      const latestQW = rows.find((r) => r.alertCode.startsWith("QW-"));
      return withinInterval(latestQW?.issuedAt, alertIntervalMs);
    } catch {
      return false;
    }
  }

  return {
    start(): void {
      if (stopped) return;
      // 冷启动保护：上次同步仍在周期内则跳过初次，避免服务重启浪费免费额度
      void (async () => {
        if (await shouldSkipForecastInitial()) {
          config.logger.info("预报数据仍在刷新周期内，跳过启动初次同步");
        } else {
          await syncForecastOnce();
        }
        if (await shouldSkipAlertInitial()) {
          config.logger.info("预警数据仍在刷新周期内，跳过启动初次同步");
        } else {
          await syncAlertsOnce();
        }
      })();
      forecastTimer = setInterval(() => void syncForecastOnce(), forecastIntervalMs);
      alertTimer = setInterval(() => void syncAlertsOnce(), alertIntervalMs);
      // 定时器不应阻塞进程退出
      forecastTimer.unref?.();
      alertTimer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (forecastTimer) clearInterval(forecastTimer);
      if (alertTimer) clearInterval(alertTimer);
      forecastTimer = undefined;
      alertTimer = undefined;
    },
    syncForecastNow: syncForecastOnce,
    syncAlertsNow: syncAlertsOnce,
    async forceSync(): Promise<{ forecast: boolean; alerts: boolean; error?: string }> {
      acquireForceQuota();
      stats.forceSyncCount += 1;
      stats.lastForceSyncAt = new Date().toISOString();
      let forecastOk = false;
      let alertsOk = false;
      let firstError: string | undefined;
      try {
        await performForecastSync();
        forecastOk = !stats.lastForecastError;
        if (!forecastOk) firstError = stats.lastForecastError;
      } catch (error) {
        firstError = error instanceof Error ? error.message : String(error);
      }
      try {
        await performAlertsSync();
        alertsOk = !stats.lastAlertError;
        if (!alertsOk) firstError ??= stats.lastAlertError;
      } catch (error) {
        firstError ??= error instanceof Error ? error.message : String(error);
      }
      config.logger.info("手动强制同步完成", {
        forecast: forecastOk,
        alerts: alertsOk,
        forceSyncCount: stats.forceSyncCount,
      });
      return firstError ? { forecast: forecastOk, alerts: alertsOk, error: firstError } : { forecast: forecastOk, alerts: alertsOk };
    },
    stats: () => ({ ...stats }),
  };
}

/** 从环境变量构造和风客户端；缺凭据时返回 undefined，由调用方跳过同步 */
export function buildQWeatherFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): { client: QWeatherClient; mapper: QWeatherMapper; config: QWeatherConfig } | undefined {
  const apiVersionRaw = (env.QWEATHER_API_VERSION ?? "v1").trim().toLowerCase();
  const apiVersion: QWeatherApiVersion = apiVersionRaw === "v7" ? "v7" : "v1";
  const key = env.QWEATHER_KEY?.trim();
  const jwt = env.QWEATHER_JWT?.trim();
  const host = env.QWEATHER_HOST?.trim();
  const jwtSigner = buildJwtSignerFromEnv(env);

  if (apiVersion === "v7") {
    // v7 旧接口仅需 Key（Deprecated）
    if (!key) return undefined;
  } else {
    // v1 必须提供 jwtSigner（私钥签发）/ jwt（静态令牌）/ key 之一，且 Host 必须为专属 API Host（非 qweather.com 旧公共域名），
    // 未满足时视为本地测试未接入，不启动同步器，保证服务仍可用
    if (!key && !jwt && !jwtSigner) return undefined;
    if (!host) return undefined;
    if (/\.qweather\.com$/i.test(safeHostname(host))) return undefined;
  }

  const config: QWeatherConfig = {
    apiVersion,
    ...(key ? { key } : {}),
    ...(jwt ? { jwt } : {}),
    ...(jwtSigner ? { jwtSigner } : {}),
    ...(host ? { host } : {}),
    ...(env.QWEATHER_LOCATION_ID?.trim() ? { locationId: env.QWEATHER_LOCATION_ID.trim() } : {}),
    ...(env.QWEATHER_CITY?.trim() ? { city: env.QWEATHER_CITY.trim() } : {}),
    ...parseNumberOption(env.QWEATHER_LATITUDE, (v) => ({ latitude: v })),
    ...parseNumberOption(env.QWEATHER_LONGITUDE, (v) => ({ longitude: v })),
    ...parseNumberOption(env.QWEATHER_TIMEOUT_MS, (v) => ({ timeoutMs: v })),
  };
  let client: QWeatherClient;
  try {
    client = createQWeatherClient(config, fetchImpl);
  } catch {
    // 配置异常（如无法解析的 Host）时降级为不启用同步器，绝不让服务启动崩溃
    return undefined;
  }
  return { client, mapper: getQWeatherMapper(apiVersion), config };
}

/**
 * 从环境变量构造 Ed25519 JWT 签发器。
 * 私钥来源二选一：`QWEATHER_PRIVATE_KEY`（PEM 内容）优先，其次 `QWEATHER_PRIVATE_KEY_PATH`（文件路径）。
 * 需同时提供 kid/iss/sub：`QWEATHER_KEY_ID`、`QWEATHER_DEVELOPER_ID`、`QWEATHER_PROJECT_ID`，缺一返回 undefined。
 */
function buildJwtSignerFromEnv(env: NodeJS.ProcessEnv): QWeatherJwtSigner | undefined {
  const keyId = env.QWEATHER_KEY_ID?.trim();
  const developerId = env.QWEATHER_DEVELOPER_ID?.trim();
  const projectId = env.QWEATHER_PROJECT_ID?.trim();
  if (!keyId || !developerId || !projectId) return undefined;

  const inlinePem = env.QWEATHER_PRIVATE_KEY?.trim();
  const pathPem = env.QWEATHER_PRIVATE_KEY_PATH?.trim();
  // 两个变量都支持“内联 PEM 内容”或“文件路径”：值含 -----BEGIN 视为 PEM 文本，否则按文件路径读取；QWEATHER_PRIVATE_KEY 优先。
  const resolvePem = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (value.includes("-----BEGIN")) return value;
    try {
      return readFileSync(value, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const privateKeyPem = resolvePem(inlinePem) ?? resolvePem(pathPem);
  if (!privateKeyPem || !privateKeyPem.includes("-----BEGIN")) return undefined;

  const ttl = env.QWEATHER_JWT_TTL_SECONDS ? Number(env.QWEATHER_JWT_TTL_SECONDS) : undefined;
  try {
    return createEd25519JwtSigner({
      keyId,
      developerId,
      projectId,
      privateKeyPem,
      ...(ttl !== undefined && Number.isFinite(ttl) && ttl > 0 ? { ttlSeconds: ttl } : {}),
    });
  } catch {
    return undefined;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parseNumberOption<T>(value: string | undefined, build: (n: number) => T): T | Record<string, never> {
  if (!value) return {};
  const n = Number(value);
  return Number.isFinite(n) ? build(n) : {};
}

/** 从环境变量解析同步器扩展配置（刷新间隔与每日上限） */
export function buildSyncerOptionsFromEnv(env: NodeJS.ProcessEnv): Pick<WeatherSyncerConfig, "forecastRefreshMinutes" | "alertRefreshMinutes" | "hourlyRetainHours" | "dailyCallLimit"> {
  const num = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const options: Pick<WeatherSyncerConfig, "forecastRefreshMinutes" | "alertRefreshMinutes" | "hourlyRetainHours" | "dailyCallLimit"> = {};
  const forecast = num(env.QWEATHER_FORECAST_REFRESH_MINUTES);
  if (forecast !== undefined) options.forecastRefreshMinutes = forecast;
  const alert = num(env.QWEATHER_ALERT_REFRESH_MINUTES);
  if (alert !== undefined) options.alertRefreshMinutes = alert;
  const retain = num(env.QWEATHER_HOURLY_RETAIN_HOURS);
  if (retain !== undefined) options.hourlyRetainHours = retain;
  const limit = num(env.QWEATHER_DAILY_CALL_LIMIT);
  if (limit !== undefined) options.dailyCallLimit = limit;
  return options;
}
