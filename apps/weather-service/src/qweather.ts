import { createPrivateKey, sign as ed25519Sign } from "node:crypto";
import type { CreateForecastInput, WeatherHourlyPoint } from "./forecast.repository.js";
import type { WeatherAlert, WeatherAlertLevel, WeatherAlertType } from "./alert.repository.js";
import { newAlertId } from "./alert.repository.js";

/**
 * 和风天气 API 接入：可插拔的实时气象数据源，同时支持 v1（新）与 v7（旧，2026 起逐步弃用）两套接口。
 * 未配置 QWEATHER_KEY 时不会启用，接口仍读本地 weather_forecasts / weather_forecast_hours / weather_alerts 三张表；
 * 配置 Key 后由 sync.ts 定时把和风数据落到上述表，接口端点契约不变。
 *
 * 官方文档：
 * - v1 实时天气      https://dev.qweather.com/docs/api/weather/weather-current/
 * - v1 每日预报      https://dev.qweather.com/docs/api/weather/weather-daily-forecast/
 * - v1 逐小时预报    https://dev.qweather.com/docs/api/weather/weather-hourly-forecast/
 * - v1 实时天气预警  https://dev.qweather.com/docs/api/warning/weather-alert/
 *
 * 版本差异：
 * - v1：路径基于经纬度 `/weather/v1/{current|daily|hourly}/{lat}/{lon}`、`/weatheralert/v1/current/{lat}/{lon}`；
 *   响应字段结构化（对象嵌套），认证支持 `Authorization: Bearer {JWT}` 或 `X-QW-Api-Key: {凭据 Key}`；必须使用专属 API Host。
 * - v7（Deprecated）：路径基于 LocationID `/v7/weather/{3d|24h|now}`、`/v7/warning/now`；响应字段平铺字符串；
 *   认证走 `key=` 查询参数；公共域名 devapi/api.qweather.com 从 2026 起逐步停用，请尽快迁移到 v1。
 */

/** 达州市默认坐标与 LocationID（覆盖智耘蜀芯农情中心一带） */
export const DEFAULT_LATITUDE = 31.21;
export const DEFAULT_LONGITUDE = 107.5;
export const DEFAULT_LOCATION_ID = "101270600";
export const DEFAULT_CITY = "达州市";
export const DEFAULT_DEV_HOST = "https://devapi.qweather.com";

export type QWeatherApiVersion = "v1" | "v7";

/**
 * JWT 签发器：返回可直接放进 `Authorization: Bearer` 的 JWT 字符串。
 * 每次调用实时签发（Ed25519 签名成本极低），无需缓存与过期刷新。
 */
export type QWeatherJwtSigner = (nowMs?: number) => string;

export interface QWeatherJwtOptions {
  /** Header.kid —— 凭据 ID，控制台-项目管理中查看 */
  keyId: string;
  /** Payload.iss —— 开发者 ID（Q 开头的 10 位字母/数字），控制台-设置中查看 */
  developerId: string;
  /** Payload.sub —— 项目 ID，控制台-项目管理中查看 */
  projectId: string;
  /** Ed25519 私钥（PKCS#8 PEM，-----BEGIN PRIVATE KEY-----） */
  privateKeyPem: string;
  /** exp 相对 iat 的有效期秒数，默认 900（15 分钟）；官方上限 86400 */
  ttlSeconds?: number | undefined;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/**
 * 使用 Ed25519 私钥按和风 JWT 规范签发令牌。
 * Header `{alg:EdDSA,kid}`、Payload `{iss,sub,iat,exp}`，`iat` 前移 30 秒防时钟误差。
 */
export function createEd25519JwtSigner(options: QWeatherJwtOptions): QWeatherJwtSigner {
  const privateKey = createPrivateKey(options.privateKeyPem);
  const ttl = options.ttlSeconds ?? 900;
  return (nowMs?: number): string => {
    const iat = Math.floor((nowMs ?? Date.now()) / 1000) - 30;
    const exp = iat + ttl;
    const header = base64url(JSON.stringify({ alg: "EdDSA", kid: options.keyId }));
    const payload = base64url(JSON.stringify({ iss: options.developerId, sub: options.projectId, iat, exp }));
    const signingInput = `${header}.${payload}`;
    const signature = base64url(ed25519Sign(null, Buffer.from(signingInput, "utf8"), privateKey));
    return `${signingInput}.${signature}`;
  };
}

export interface QWeatherConfig {
  /** API 版本；默认 v1。v7 已标记为 deprecated，将在 2026 起停用 */
  apiVersion?: QWeatherApiVersion | undefined;
  /**
   * v1：作为 `X-QW-Api-Key` 头的凭据 Key；v7：作为 `key=` 查询参数。
   * 若同时提供 `jwt` 则 v1 走 Authorization Bearer，key 可留空。
   */
  key?: string | undefined;
  /** v1 可选：JWT 令牌，用于 `Authorization: Bearer {jwt}` 认证 */
  jwt?: string | undefined;
  /** v1 推荐：JWT 签发器（Ed25519 私钥），存在时每次请求实时签发 Bearer 令牌，优先于静态 jwt/key */
  jwtSigner?: QWeatherJwtSigner | undefined;
  /** v1 必须使用专属 API Host（控制台-设置）；v7 兼容 devapi 但会 warn */
  host?: string | undefined;
  /** v7 使用 */
  locationId?: string | undefined;
  /** v1 使用 */
  latitude?: number | undefined;
  /** v1 使用 */
  longitude?: number | undefined;
  city?: string | undefined;
  /** 单次请求超时毫秒，默认 3000 */
  timeoutMs?: number | undefined;
}

export interface ResolvedQWeatherConfig {
  apiVersion: QWeatherApiVersion;
  key: string;
  jwt: string | undefined;
  jwtSigner: QWeatherJwtSigner | undefined;
  host: string;
  locationId: string;
  latitude: number;
  longitude: number;
  city: string;
  timeoutMs: number;
}

/** 安全提取 hostname：非法 URL 返回空串，绝不抛错 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function resolveQWeatherConfig(input: QWeatherConfig): ResolvedQWeatherConfig {
  const apiVersion = input.apiVersion ?? "v1";
  const key = input.key ?? "";
  const jwt = input.jwt?.trim() || undefined;
  const jwtSigner = input.jwtSigner;
  if (apiVersion === "v1") {
    if (!key && !jwt && !jwtSigner) throw new Error("QWeather v1 需要 jwtSigner（私钥签发）、jwt（Bearer 令牌）或 key（X-QW-Api-Key）之一");
  } else if (!key) {
    throw new Error("QWeather v7 key 不能为空");
  }
  // 归一化 Host：缺协议前缀时自动补 https://（用户常只填 `xxx.re.qweatherapi.com`），并去尾斜杠
  const rawHost = (input.host ?? DEFAULT_DEV_HOST).replace(/\/+$/, "");
  const host = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
  if (apiVersion === "v1" && /(^|\.)qweather\.com$/i.test(safeHostname(host))) {
    throw new Error(`QWeather v1 不支持旧公共域名（当前 host=${host}），请使用控制台专属 API Host，形如 xxx.yz.qweatherapi.com`);
  }
  return {
    apiVersion,
    key,
    jwt,
    jwtSigner,
    host,
    locationId: input.locationId ?? DEFAULT_LOCATION_ID,
    latitude: input.latitude ?? DEFAULT_LATITUDE,
    longitude: input.longitude ?? DEFAULT_LONGITUDE,
    city: input.city ?? DEFAULT_CITY,
    timeoutMs: input.timeoutMs ?? 3000,
  };
}

// ---------- v7 原始响应类型（Deprecated，仅保留兼容） ----------

export interface QWeatherDailyItem {
  fxDate: string;
  sunrise?: string;
  sunset?: string;
  tempMax: string;
  tempMin: string;
  textDay: string;
  textNight?: string;
  windDirDay: string;
  windScaleDay: string; // "≤3" / "3-4" / "5"
  windSpeedDay: string; // km/h
  humidity?: string;
  precip: string; // mm
  pressure?: string;
  uvIndex?: string;
}

export interface QWeatherHourlyItem {
  fxTime: string;
  temp: string;
  text: string;
  windDir: string;
  windSpeed: string; // km/h
  windScale?: string;
  humidity: string;
  precip: string;
  pop?: string;
  icon?: string;
}

export interface QWeatherWarningItem {
  id: string;
  sender?: string;
  pubTime: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  level: string;
  type: string;
  icon?: string;
  title: string;
  text: string;
}

// ---------- v1 原始响应类型 ----------

export interface QWeatherV1Quantity {
  value: number;
  unit?: string;
}

export interface QWeatherV1Condition {
  text: string;
  code: string;
}

export interface QWeatherV1Wind {
  direction: { degree: number; compass: string };
  speed: QWeatherV1Quantity; // m/s
  scale?: number;
}

export interface QWeatherV1Precipitation {
  amount: QWeatherV1Quantity; // mm
  intensity?: QWeatherV1Quantity;
  probability?: number; // [0,1]
  type?: string;
}

export interface QWeatherV1DailyDaypart extends Record<string, unknown> {
  condition: QWeatherV1Condition;
  temperatureMax?: QWeatherV1Quantity;
  temperatureMin?: QWeatherV1Quantity;
  wind?: QWeatherV1Wind;
  windGustMax?: QWeatherV1Quantity;
  precipitation?: QWeatherV1Precipitation;
  humidity?: number;
  cloudCover?: number;
}

export interface QWeatherV1DailyItem {
  forecastStartTime: string; // 2024-08-10T22:00Z
  forecastEndTime: string;
  temperatureMax: QWeatherV1Quantity;
  temperatureMin: QWeatherV1Quantity;
  temperatureAvg?: QWeatherV1Quantity;
  uvIndexMax?: number;
  daytime?: QWeatherV1DailyDaypart;
  nighttime?: QWeatherV1DailyDaypart;
  astro?: { sunrise?: string; sunset?: string };
}

export interface QWeatherV1HourlyItem {
  forecastTime: string;
  condition: QWeatherV1Condition;
  temperature: QWeatherV1Quantity;
  feelsLike?: QWeatherV1Quantity;
  humidity: number; // [0,1]
  wind: QWeatherV1Wind;
  windGust?: QWeatherV1Quantity;
  precipitation: QWeatherV1Precipitation;
  pressure?: QWeatherV1Quantity;
  visibility?: QWeatherV1Quantity;
  dewPoint?: QWeatherV1Quantity;
  cloudCover?: number;
  uvIndex?: number;
}

export interface QWeatherV1AlertItem {
  id: string;
  senderName?: string;
  issuedTime: string;
  messageType: { code: "alert" | "update" | "cancel" | string; supersedes?: string[] };
  eventType: { name: string; code: string };
  urgency?: string | null;
  severity?: "unknown" | "minor" | "moderate" | "severe" | "extreme" | string;
  certainty?: string | null;
  icon?: string;
  color?: { code: string; red?: number; green?: number; blue?: number; alpha?: number };
  effectiveTime?: string;
  onsetTime?: string;
  expireTime?: string;
  headline: string;
  description: string;
  criteria?: string;
  instruction?: string;
}

// ---------- 客户端抽象 ----------

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * 通用客户端接口：返回原始未 cast 的 JSON 项目数组，由对应版本的 mapper 转换为仓储输入。
 * sync.ts 不感知具体 API 版本。
 */
export interface QWeatherClient {
  fetchDaily3(): Promise<Record<string, unknown>[]>;
  fetchHourly24(): Promise<Record<string, unknown>[]>;
  fetchWarning(): Promise<Record<string, unknown>[]>;
}

export interface QWeatherMapper {
  mapDaily(raw: Record<string, unknown>, city: string, refreshedAt: string): CreateForecastInput;
  mapHourly(raw: Record<string, unknown>, refreshedAt: string): WeatherHourlyPoint;
  mapWarning(raw: Record<string, unknown>, city: string): WeatherAlert;
}

/** 根据 apiVersion 构造客户端；v1 走专属 Host + 头认证，v7 走 key 查询参数（Deprecated） */
export function createQWeatherClient(config: QWeatherConfig, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): QWeatherClient {
  const resolved = resolveQWeatherConfig(config);
  return resolved.apiVersion === "v1" ? createQWeatherClientV1(resolved, fetchImpl) : createQWeatherClientV7(resolved, fetchImpl);
}

/** 统一错误透传：v1 使用 application/problem+json，v7 使用 code/reason；错误消息均带上具体 title/detail 便于运维定位 */
async function extractError(response: { status: number; json(): Promise<unknown> }, path: string): Promise<Error> {
  let detail = `QWeather ${path} HTTP ${response.status}`;
  try {
    const raw = (await response.json()) as { error?: { title?: string; detail?: string }; code?: string; reason?: string };
    const title = raw?.error?.title;
    const desc = raw?.error?.detail;
    if (title) detail += ` (${title})`;
    if (desc) detail += `: ${desc}`;
    if (!title && !desc && raw?.code && raw.code !== "200") detail += ` code=${raw.code}${raw.reason ? ` reason=${raw.reason}` : ""}`;
  } catch {
    /* body 非 JSON 时降级为仅 HTTP 状态 */
  }
  return new Error(detail);
}

function createQWeatherClientV7(resolved: ResolvedQWeatherConfig, fetchImpl: FetchLike): QWeatherClient {
  async function call(path: string, field: string): Promise<Record<string, unknown>[]> {
    const url = `${resolved.host}${path}?location=${encodeURIComponent(resolved.locationId)}&key=${encodeURIComponent(resolved.key)}&lang=zh`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(resolved.timeoutMs) });
    if (!response.ok) throw await extractError(response, path);
    const raw = (await response.json()) as Record<string, unknown>;
    if (String(raw.code ?? "") !== "200") throw new Error(`QWeather ${path} code=${raw.code}`);
    const items = raw[field];
    return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  }
  return {
    fetchDaily3: () => call("/v7/weather/3d", "daily"),
    fetchHourly24: () => call("/v7/weather/24h", "hourly"),
    fetchWarning: () => call("/v7/warning/now", "warning"),
  };
}

function createQWeatherClientV1(resolved: ResolvedQWeatherConfig, fetchImpl: FetchLike): QWeatherClient {
  // 每次请求实时组装认证头：jwtSigner 动态签发优先，其次静态 jwt，最后 API Key
  const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "X-QW-Lang": "zh" };
    if (resolved.jwtSigner) headers["Authorization"] = `Bearer ${resolved.jwtSigner()}`;
    else if (resolved.jwt) headers["Authorization"] = `Bearer ${resolved.jwt}`;
    else headers["X-QW-Api-Key"] = resolved.key;
    return headers;
  };

  async function call(path: string, field: string): Promise<Record<string, unknown>[]> {
    const url = `${resolved.host}${path}${path.includes("?") ? "&" : "?"}lang=zh`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(resolved.timeoutMs), headers: buildHeaders() });
    if (!response.ok) throw await extractError(response, path);
    const raw = (await response.json()) as Record<string, unknown>;
    const items = raw[field];
    return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  }

  const coord = `${resolved.latitude.toFixed(2)}/${resolved.longitude.toFixed(2)}`;
  return {
    // v1 每日预报最多 10 天，days 参数控制；本项目取 3 天与业务对齐
    fetchDaily3: () => call(`/weather/v1/daily/${coord}?days=3`, "days"),
    // v1 逐小时最多 240 小时，hours 参数控制；本项目取 24 小时
    fetchHourly24: () => call(`/weather/v1/hourly/${coord}?hours=24`, "hours"),
    // v1 实时天气预警
    fetchWarning: () => call(`/weatheralert/v1/current/${coord}`, "alerts"),
  };
}

// ---------- 通用工具 ----------

/** v7 windScaleDay "≤3" / "3-4" / "5" → 整数级（取上界，喷药阈值更保守） */
export function parseWindScale(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
  const matches = value.match(/\d+/g);
  if (!matches || matches.length === 0) return 0;
  return Number(matches[matches.length - 1]);
}

/** km/h → m/s，保留 1 位小数（v7 用；v1 已是 m/s 不再走此函数） */
export function kmhToMs(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Number((n / 3.6).toFixed(1));
}

/** v1 16 方位英文 → 中文；未识别时原样返回 */
const COMPASS_ZH: Record<string, string> = {
  n: "北", nne: "北东北", ne: "东北", ene: "东北东",
  e: "东", ese: "东南东", se: "东南", sse: "南东南",
  s: "南", ssw: "南西南", sw: "西南", wsw: "西南西",
  w: "西", wnw: "西北西", nw: "西北", nnw: "北西北",
  vrb: "随机", none: "无风",
};
export function compassToZh(compass: string | undefined): string {
  if (!compass) return "";
  return COMPASS_ZH[compass.toLowerCase()] ?? compass;
}

/** daily 无原生降水概率字段时按 precip（mm）与 text 估算 */
export function estimateRainProbability(text: string, precip: number): number {
  if (precip >= 15) return 95;
  if (precip >= 8) return 88;
  if (precip >= 4) return 78;
  if (precip >= 1) return 65;
  if (precip > 0) return 50;
  const t = (text ?? "").trim();
  if (/特大暴雨|大暴雨|暴雨|大雨|雷阵雨|强阵雨/.test(t)) return 92;
  if (/中雨|阵雨|雨夹雪|冻雨/.test(t)) return 80;
  if (/小雨|毛毛雨|细雨/.test(t)) return 58;
  if (/雾|霾|扬沙|浮尘|沙尘/.test(t)) return 30;
  if (/阴/.test(t)) return 35;
  if (/少云|多云/.test(t)) return 22;
  if (/晴/.test(t)) return 10;
  return 30;
}

/** 把 ISO / 和风时间统一转为 UTC ISO */
export function toIsoTime(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return value;
}

/** v1 forecastStartTime "2024-08-10T22:00Z" → 本地日历日 YYYY-MM-DD（业务 date 字段） */
export function toLocalDate(value: string | undefined): string {
  const iso = toIsoTime(value);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** v7 颜色（红/橙/黄/蓝）→ 本地三级 */
export function mapAlertLevel(level: string): { level: WeatherAlertLevel; color: string } {
  const raw = (level ?? "").trim();
  if (raw.includes("红")) return { level: "CRITICAL", color: "红" };
  if (raw.includes("橙")) return { level: "CRITICAL", color: "橙" };
  if (raw.includes("黄")) return { level: "WARNING", color: "黄" };
  return { level: "INFO", color: "蓝" };
}

// ---------- v7 mapper（Deprecated 保留） ----------

const TYPE_MAP_V7: Record<string, WeatherAlertType> = {
  "01": "WIND", "02": "LOW_TEMP", "03": "LOW_TEMP", "04": "RAINSTORM", "05": "WIND",
  "06": "FOG", "07": "HIGH_TEMP", "08": "LOW_TEMP", "09": "LOW_TEMP", "10": "LOW_TEMP",
  "11": "LOW_TEMP", "12": "DROUGHT", "13": "THUNDER", "14": "RAINSTORM", "15": "LOW_TEMP",
  "16": "FOG", "17": "FOG", "18": "THUNDER",
};

/** daily → CreateForecastInput（仓储写入用的裸数据，不含 id） */
export function mapDaily(item: QWeatherDailyItem, city: string, refreshedAt: string): CreateForecastInput {
  const precip = Number(item.precip ?? 0);
  const rainAmount = Number.isFinite(precip) ? Number(precip.toFixed(1)) : 0;
  return {
    date: item.fxDate,
    city,
    weather: item.textDay || "未知",
    tempMin: Number(item.tempMin),
    tempMax: Number(item.tempMax),
    windDirection: item.windDirDay || "",
    windLevel: parseWindScale(item.windScaleDay),
    windSpeed: kmhToMs(item.windSpeedDay),
    rainProbability: estimateRainProbability(item.textDay, rainAmount),
    rainAmount,
    refreshedAt,
  };
}

/** hourly → WeatherHourlyPoint */
export function mapHourly(item: QWeatherHourlyItem, refreshedAt: string): WeatherHourlyPoint {
  const hourAt = toIsoTime(item.fxTime);
  const pop = Number(item.pop ?? "");
  const rainProbability = Number.isFinite(pop) && pop >= 0 ? Math.min(100, Math.max(0, pop)) : estimateRainProbability(item.text, Number(item.precip ?? 0));
  return {
    id: `wx-hour-qw-${hourAt}`,
    hourAt,
    weather: item.text || "未知",
    temperature: Number(item.temp),
    humidity: Number(item.humidity ?? 0),
    windSpeed: kmhToMs(item.windSpeed),
    rainProbability,
    refreshedAt,
  };
}

/** warning → WeatherAlert（alertCode 用 QW-{id} 做幂等） */
export function mapWarning(item: QWeatherWarningItem, city: string): WeatherAlert {
  const { level, color } = mapAlertLevel(item.level);
  const alertType = TYPE_MAP_V7[String(item.type).padStart(2, "0")] ?? "RAINSTORM";
  const active = (item.status ?? "").toLowerCase() !== "cancel";
  const alert: WeatherAlert = {
    id: newAlertId(),
    alertCode: `QW-${item.id}`,
    alertType,
    level,
    color,
    title: item.title ?? "气象预警",
    description: item.text ?? item.title ?? "",
    city,
    plotCode: "",
    issuedAt: toIsoTime(item.pubTime),
    active,
  };
  if (item.endTime) alert.expiresAt = toIsoTime(item.endTime);
  return alert;
}

const v7Mapper: QWeatherMapper = {
  mapDaily: (raw, city, at) => mapDaily(raw as unknown as QWeatherDailyItem, city, at),
  mapHourly: (raw, at) => mapHourly(raw as unknown as QWeatherHourlyItem, at),
  mapWarning: (raw, city) => mapWarning(raw as unknown as QWeatherWarningItem, city),
};

// ---------- v1 mapper ----------

const EVENT_TYPE_MAP_V1: Record<string, WeatherAlertType> = {
  "1001": "WIND", // 台风
  "1002": "LOW_TEMP", // 寒潮
  "1003": "LOW_TEMP", // 低温霜冻
  "1004": "RAINSTORM", // 冰雹
  "1005": "LOW_TEMP", // 霜冻
  "1006": "WIND", // 大风
  "1007": "FOG", // 沙尘暴
  "1008": "HIGH_TEMP", // 高温
  "1009": "RAINSTORM", // 暴雨
  "1010": "FOG", // 大雾
  "1011": "FOG", // 霾
  "1012": "LOW_TEMP", // 道路结冰
  "1013": "DROUGHT", // 干旱
  "1014": "THUNDER", // 雷电
  "1015": "WIND", // 森林火险（归入 WIND 兜底，业务无 FIRE 类型）
  "1016": "THUNDER", // 雷雨大风
  "1017": "LOW_TEMP", // 结冰
  "1059": "RAINSTORM", // 洪水
};

const SEVERITY_TO_LEVEL: Record<string, WeatherAlertLevel> = {
  extreme: "CRITICAL",
  severe: "CRITICAL",
  moderate: "WARNING",
  minor: "INFO",
  unknown: "INFO",
};

const COLOR_CODE_ZH: Record<string, string> = {
  red: "红", purple: "红", black: "红",
  orange: "橙", amber: "橙",
  yellow: "黄",
  blue: "蓝", green: "蓝", white: "蓝", gray: "蓝",
};

function isV1Daily(raw: Record<string, unknown>): boolean {
  return typeof raw.forecastStartTime === "string";
}

function v1DailyToInput(item: QWeatherV1DailyItem, city: string, refreshedAt: string): CreateForecastInput {
  const daytime = item.daytime as QWeatherV1DailyDaypart | undefined;
  const wind = daytime?.wind;
  const precip = daytime?.precipitation;
  const precipAmount = precip?.amount?.value ?? 0;
  const rainAmount = Number.isFinite(precipAmount) ? Number(precipAmount.toFixed(1)) : 0;
  const probability = precip?.probability;
  const rainProbability = typeof probability === "number" && Number.isFinite(probability)
    ? Math.min(100, Math.max(0, Math.round(probability * 100)))
    : estimateRainProbability(daytime?.condition?.text ?? "", rainAmount);
  return {
    date: toLocalDate(item.forecastStartTime),
    city,
    weather: daytime?.condition?.text || "未知",
    tempMin: Number(item.temperatureMin?.value ?? 0),
    tempMax: Number(item.temperatureMax?.value ?? 0),
    windDirection: compassToZh(wind?.direction?.compass),
    windLevel: parseWindScale(wind?.scale),
    windSpeed: Number((wind?.speed?.value ?? 0).toFixed(1)), // v1 单位 m/s，与本地一致
    rainProbability,
    rainAmount,
    refreshedAt,
  };
}

function v1DailyToInputFallback(item: Record<string, unknown>, city: string, refreshedAt: string): CreateForecastInput {
  // 若 v1 响应缺少 daytime 结构，退回到全天平均
  const daily = item as unknown as QWeatherV1DailyItem;
  const precip = (daily as unknown as { precipitation?: QWeatherV1Precipitation }).precipitation;
  const rainAmount = Number((precip?.amount?.value ?? 0).toFixed(1));
  const probability = precip?.probability;
  const rainProbability = typeof probability === "number"
    ? Math.min(100, Math.max(0, Math.round(probability * 100)))
    : estimateRainProbability("", rainAmount);
  return {
    date: toLocalDate(daily.forecastStartTime),
    city,
    weather: "未知",
    tempMin: Number(daily.temperatureMin?.value ?? 0),
    tempMax: Number(daily.temperatureMax?.value ?? 0),
    windDirection: "",
    windLevel: 0,
    windSpeed: 0,
    rainProbability,
    rainAmount,
    refreshedAt,
  };
}

function v1HourlyToPoint(item: QWeatherV1HourlyItem, refreshedAt: string): WeatherHourlyPoint {
  const hourAt = toIsoTime(item.forecastTime);
  const probability = item.precipitation?.probability;
  const rainAmount = item.precipitation?.amount?.value ?? 0;
  const rainProbability = typeof probability === "number" && Number.isFinite(probability)
    ? Math.min(100, Math.max(0, Math.round(probability * 100)))
    : estimateRainProbability(item.condition?.text ?? "", Number(rainAmount));
  return {
    id: `wx-hour-qw-${hourAt}`,
    hourAt,
    weather: item.condition?.text || "未知",
    temperature: Number(item.temperature?.value ?? 0),
    // v1 humidity 是 [0,1]，本地约定 [0,100]
    humidity: Number(((item.humidity ?? 0) * 100).toFixed(1)),
    // v1 wind.speed 单位 m/s，与本地一致
    windSpeed: Number((item.wind?.speed?.value ?? 0).toFixed(1)),
    rainProbability,
    refreshedAt,
  };
}

function v1AlertToAlert(item: QWeatherV1AlertItem, city: string): WeatherAlert {
  const severity = (item.severity ?? "unknown").toLowerCase();
  const level = SEVERITY_TO_LEVEL[severity] ?? "INFO";
  const colorCode = (item.color?.code ?? "").toLowerCase();
  const color = COLOR_CODE_ZH[colorCode] ?? "蓝";
  const eventCode = String(item.eventType?.code ?? "").padStart(4, "0");
  const alertType = EVENT_TYPE_MAP_V1[eventCode] ?? "RAINSTORM";
  const active = (item.messageType?.code ?? "alert").toLowerCase() !== "cancel";
  const alert: WeatherAlert = {
    id: newAlertId(),
    alertCode: `QW-${item.id}`,
    alertType,
    level,
    color,
    title: item.headline || item.eventType?.name || "气象预警",
    description: item.description || item.headline || "",
    city,
    plotCode: "",
    issuedAt: toIsoTime(item.issuedTime),
    active,
  };
  if (item.expireTime) alert.expiresAt = toIsoTime(item.expireTime);
  return alert;
}

const v1Mapper: QWeatherMapper = {
  mapDaily: (raw, city, at) => (isV1Daily(raw) ? v1DailyToInput(raw as unknown as QWeatherV1DailyItem, city, at) : v1DailyToInputFallback(raw, city, at)),
  mapHourly: (raw, at) => v1HourlyToPoint(raw as unknown as QWeatherV1HourlyItem, at),
  mapWarning: (raw, city) => v1AlertToAlert(raw as unknown as QWeatherV1AlertItem, city),
};

/** 按 API 版本取 mapper；默认 v1 */
export function getQWeatherMapper(apiVersion: QWeatherApiVersion = "v1"): QWeatherMapper {
  return apiVersion === "v1" ? v1Mapper : v7Mapper;
}

/** 生成新预报 id，对齐 forecast.repository 的 ulid 约定 */
export { newForecastId as forecastId } from "./forecast.repository.js";
