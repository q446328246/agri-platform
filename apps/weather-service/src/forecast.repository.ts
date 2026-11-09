import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";
import { farmDate, farmDateOffset } from "./farm-time.js";

/**
 * 天气预报仓储：对应文档 5.3「本地五天天气状况」。
 * 日粒度供首页天气面板使用，时粒度供逐小时预报与农事作业提示使用。
 * 表结构由迁移 012_weather_forecast.sql 管理；内存实现用于单测与未启用数据库的本地模式。
 */

/** 预报窗口内的一天（默认今天起七日） */
export interface WeatherForecastDay {
  id: string;
  /** 预报日期 YYYY-MM-DD */
  date: string;
  city: string;
  /** 天气现象：晴 / 多云 / 阵雨 / 小雨 … */
  weather: string;
  tempMin: number;
  tempMax: number;
  /** 主导风向：东南风 / 北风 … */
  windDirection: string;
  /** 风力等级（级） */
  windLevel: number;
  /** 最大风速（m/s），喷药与无人机作业判定用 */
  windSpeed: number;
  /** 降水概率（%） */
  rainProbability: number;
  /** 预报降水量（mm） */
  rainAmount: number;
  refreshedAt: string;
}

/** 逐小时预报的一个时次 */
export interface WeatherHourlyPoint {
  id: string;
  /** 时次起点 ISO 时间 */
  hourAt: string;
  weather: string;
  temperature: number;
  humidity: number;
  windSpeed: number;
  rainProbability: number;
  refreshedAt: string;
}

/** 新增预报入参 */
export interface CreateForecastInput {
  date: string;
  city: string;
  weather: string;
  tempMin: number;
  tempMax: number;
  windDirection: string;
  windLevel: number;
  windSpeed: number;
  rainProbability: number;
  rainAmount: number;
  refreshedAt: string;
}

export interface ForecastRepository {
  /** 农场时区「今天起 days 天」窗口内的预报，按日期升序；早于今天与超出窗口的行都不返回 */
  upcoming(from: Date, days: number): Promise<WeatherForecastDay[]>;
  /** 未来 N 小时的逐小时预报，按时间升序 */
  hourly(from: Date, hours: number): Promise<WeatherHourlyPoint[]>;
  /** 最近一次刷新时间，无数据时 undefined */
  lastRefreshedAt(): Promise<string | undefined>;
  create(tx: unknown, input: CreateForecastInput): Promise<WeatherForecastDay>;
  count(): Promise<number>;
  /** 同日重写时直接覆盖，用于和风天气定时同步 */
  upsertDay(input: CreateForecastInput): Promise<WeatherForecastDay>;
  /** 同时次重写时直接覆盖，用于逐小时预报刷新 */
  upsertHour(hour: WeatherHourlyPoint): Promise<void>;
  /** 删除严格早于 from 的时次，避免本地堆积过期预报 */
  deleteHoursBefore?(from: Date): Promise<number>;
}

/** 预报日期列兼容：pg 驱动可能返回 Date（本地子夜）或 YYYY-MM-DD 字符串，统一取本地日历日 */
function forecastDate(value: unknown): string {
  if (value instanceof Date) {
    const pad = (part: number): string => String(part).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function toForecastDay(row: Record<string, unknown>): WeatherForecastDay {
  return {
    id: String(row.id),
    date: forecastDate(row.forecast_date),
    city: String(row.city),
    weather: String(row.weather),
    tempMin: Number(row.temp_min),
    tempMax: Number(row.temp_max),
    windDirection: String(row.wind_direction),
    windLevel: Number(row.wind_level),
    windSpeed: Number(row.wind_speed),
    rainProbability: Number(row.rain_probability),
    rainAmount: Number(row.rain_amount),
    refreshedAt: toIsoTimestamp(row.refreshed_at),
  };
}

function toHourlyPoint(row: Record<string, unknown>): WeatherHourlyPoint {
  return {
    id: String(row.id),
    hourAt: toIsoTimestamp(row.hour_at),
    weather: String(row.weather),
    temperature: Number(row.temperature),
    humidity: Number(row.humidity),
    windSpeed: Number(row.wind_speed),
    rainProbability: Number(row.rain_probability),
    refreshedAt: toIsoTimestamp(row.refreshed_at),
  };
}

/** PostgreSQL 实现 */
export class SqlForecastRepository implements ForecastRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async upcoming(from: Date, days: number): Promise<WeatherForecastDay[]> {
    const span = Math.max(1, Math.min(15, days));
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, forecast_date, city, weather, temp_min, temp_max, wind_direction, wind_level, wind_speed, rain_probability, rain_amount, refreshed_at
         FROM weather_forecasts WHERE forecast_date >= $1::date AND forecast_date < $2::date ORDER BY forecast_date LIMIT $3`,
      farmDate(from),
      farmDateOffset(span, from),
      span,
    );
    return rows.map(toForecastDay);
  }

  async hourly(from: Date, hours: number): Promise<WeatherHourlyPoint[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, hour_at, weather, temperature, humidity, wind_speed, rain_probability, refreshed_at
         FROM weather_forecast_hours WHERE hour_at >= $1::timestamptz ORDER BY hour_at LIMIT $2`,
      new Date(from.getTime() - 3600_000).toISOString(),
      Math.max(1, Math.min(168, hours)),
    );
    return rows.map(toHourlyPoint);
  }

  async lastRefreshedAt(): Promise<string | undefined> {
    const rows = await this.client.$queryRawUnsafe<Array<{ refreshed_at: unknown }>>(
      `SELECT max(refreshed_at) AS refreshed_at FROM weather_forecasts`,
    );
    const value = rows[0]?.refreshed_at;
    return value === null || value === undefined ? undefined : toIsoTimestamp(value);
  }

  async create(tx: unknown, input: CreateForecastInput): Promise<WeatherForecastDay> {
    const id = ulid();
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO weather_forecasts (id, forecast_date, city, weather, temp_min, temp_max, wind_direction, wind_level, wind_speed, rain_probability, rain_amount, refreshed_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      id,
      input.date,
      input.city,
      input.weather,
      input.tempMin,
      input.tempMax,
      input.windDirection,
      input.windLevel,
      input.windSpeed,
      input.rainProbability,
      input.rainAmount,
      input.refreshedAt,
    );
    return { id, ...input };
  }

  /** 同日重写直接覆盖，保证和风同步幂等 */
  async upsertDay(input: CreateForecastInput): Promise<WeatherForecastDay> {
    const existing = await this.client.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM weather_forecasts WHERE forecast_date = $1::date AND city = $2 LIMIT 1`,
      input.date,
      input.city,
    );
    const hit = existing[0];
    if (hit) {
      await this.client.$executeRawUnsafe(
        `UPDATE weather_forecasts SET weather = $2, temp_min = $3, temp_max = $4, wind_direction = $5, wind_level = $6, wind_speed = $7, rain_probability = $8, rain_amount = $9, refreshed_at = $10 WHERE id = $1`,
        hit.id,
        input.weather,
        input.tempMin,
        input.tempMax,
        input.windDirection,
        input.windLevel,
        input.windSpeed,
        input.rainProbability,
        input.rainAmount,
        input.refreshedAt,
      );
      return { id: hit.id, ...input };
    }
    return this.create(undefined, input);
  }

  /** 写入逐小时预报，同一时次重复写入直接覆盖（按小时刷新场景） */
  async upsertHour(hour: WeatherHourlyPoint): Promise<void> {
    await this.executor(undefined).$executeRawUnsafe(
      `INSERT INTO weather_forecast_hours (id, hour_at, weather, temperature, humidity, wind_speed, rain_probability, refreshed_at)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (hour_at) DO UPDATE SET weather = EXCLUDED.weather, temperature = EXCLUDED.temperature, humidity = EXCLUDED.humidity, wind_speed = EXCLUDED.wind_speed, rain_probability = EXCLUDED.rain_probability, refreshed_at = EXCLUDED.refreshed_at`,
      hour.id,
      hour.hourAt,
      hour.weather,
      hour.temperature,
      hour.humidity,
      hour.windSpeed,
      hour.rainProbability,
      hour.refreshedAt,
    );
  }

  async hourCount(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM weather_forecast_hours`);
    return Number(rows[0]?.total ?? 0);
  }

  async deleteHoursBefore(from: Date): Promise<number> {
    return this.client.$executeRawUnsafe(`DELETE FROM weather_forecast_hours WHERE hour_at < $1::timestamptz`, from.toISOString());
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM weather_forecasts`);
    return Number(rows[0]?.total ?? 0);
  }
}

/** 内存实现：按「插入时刻 + 序号」推算日期，演示数据在构造时按当前时间锚定 */
export class InMemoryForecastRepository implements ForecastRepository {
  private readonly days: WeatherForecastDay[] = [];
  private readonly hours: WeatherHourlyPoint[] = [];

  constructor(seed: { days?: WeatherForecastDay[]; hours?: WeatherHourlyPoint[] } = {}) {
    this.days.push(...(seed.days ?? []));
    this.hours.push(...(seed.hours ?? []));
  }

  async upcoming(from: Date, days: number): Promise<WeatherForecastDay[]> {
    const span = Math.max(1, Math.min(15, days));
    const start = farmDate(from);
    const end = farmDateOffset(span, from);
    return [...this.days]
      .filter((row) => row.date >= start && row.date < end)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, span);
  }

  async hourly(from: Date, hours: number): Promise<WeatherHourlyPoint[]> {
    const start = new Date(from.getTime() - 3600_000).toISOString();
    return [...this.hours]
      .filter((row) => row.hourAt >= start)
      .sort((a, b) => a.hourAt.localeCompare(b.hourAt))
      .slice(0, Math.max(1, Math.min(168, hours)));
  }

  async lastRefreshedAt(): Promise<string | undefined> {
    const stamps = this.days.map((row) => row.refreshedAt).sort();
    return stamps[stamps.length - 1];
  }

  async create(_tx: unknown, input: CreateForecastInput): Promise<WeatherForecastDay> {
    const day: WeatherForecastDay = { id: ulid(), ...input };
    this.days.push(day);
    return day;
  }

  async upsertDay(input: CreateForecastInput): Promise<WeatherForecastDay> {
    const hit = this.days.find((row) => row.date === input.date && row.city === input.city);
    if (hit) {
      Object.assign(hit, input);
      return hit;
    }
    const day: WeatherForecastDay = { id: ulid(), ...input };
    this.days.push(day);
    return day;
  }

  async upsertHour(hour: WeatherHourlyPoint): Promise<void> {
    const hit = this.hours.find((row) => row.hourAt === hour.hourAt);
    if (hit) {
      Object.assign(hit, hour);
      return;
    }
    this.hours.push(hour);
  }

  async deleteHoursBefore(from: Date): Promise<number> {
    const cutoff = from.toISOString();
    const before = this.hours.length;
    for (let i = this.hours.length - 1; i >= 0; i -= 1) {
      const item = this.hours[i];
      if (item && item.hourAt < cutoff) this.hours.splice(i, 1);
    }
    return before - this.hours.length;
  }

  async count(): Promise<number> {
    return this.days.length;
  }

  all(): WeatherForecastDay[] {
    return [...this.days];
  }
}

/** 生成预报记录标识 */
export function newForecastId(): string {
  return ulid();
}
