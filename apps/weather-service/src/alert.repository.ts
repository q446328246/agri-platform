import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/**
 * 气象灾害预警仓储：对应文档 6.4「灾情监测」与 10.4「病虫害预警模型」的气象因子输入。
 * 级别口径与消息中心一致（INFO / WARNING / CRITICAL），前端可直接复用告警配色。
 * 表结构由迁移 012_weather_forecast.sql 管理。
 */

export const WEATHER_ALERT_LEVELS = ["INFO", "WARNING", "CRITICAL"] as const;
export type WeatherAlertLevel = (typeof WEATHER_ALERT_LEVELS)[number];

/** 预警类型：与气象灾害种类对应 */
export const WEATHER_ALERT_TYPES = ["RAINSTORM", "WIND", "HIGH_TEMP", "LOW_TEMP", "DROUGHT", "THUNDER", "FOG"] as const;
export type WeatherAlertType = (typeof WEATHER_ALERT_TYPES)[number];

export interface WeatherAlert {
  id: string;
  /** 预警编码，同一类型重复发布时用于幂等 */
  alertCode: string;
  alertType: WeatherAlertType;
  level: WeatherAlertLevel;
  /** 预警颜色：蓝 / 黄 / 橙 / 红 */
  color: string;
  title: string;
  description: string;
  city: string;
  /** 关联地块编码，空串表示全场 */
  plotCode: string;
  issuedAt: string;
  /** 失效时间，为空表示长期有效 */
  expiresAt?: string;
  active: boolean;
}

/** 预警查询条件（显式允许 undefined，配合调用侧的条件展开） */
export interface AlertQuery {
  level?: string | undefined;
  alertType?: string | undefined;
  plotCode?: string | undefined;
  activeOnly?: boolean | undefined;
}

function toAlert(row: Record<string, unknown>): WeatherAlert {
  const alert: WeatherAlert = {
    id: String(row.id),
    alertCode: String(row.alert_code),
    alertType: String(row.alert_type) as WeatherAlertType,
    level: String(row.level) as WeatherAlertLevel,
    color: String(row.color),
    title: String(row.title),
    description: String(row.description),
    city: String(row.city),
    plotCode: String(row.plot_code ?? ""),
    issuedAt: toIsoTimestamp(row.issued_at),
    active: Boolean(row.active),
  };
  if (row.expires_at !== null && row.expires_at !== undefined) alert.expiresAt = toIsoTimestamp(row.expires_at);
  return alert;
}

/** PostgreSQL 实现 */
export class SqlAlertRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async list(query: AlertQuery = {}): Promise<WeatherAlert[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.level) { values.push(query.level); conditions.push(`level = $${values.length}`); }
    if (query.alertType) { values.push(query.alertType); conditions.push(`alert_type = $${values.length}`); }
    if (query.plotCode) { values.push(query.plotCode); conditions.push(`plot_code = $${values.length}`); }
    if (query.activeOnly) conditions.push(`active = TRUE`);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(200);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, alert_code, alert_type, level, color, title, description, city, plot_code, issued_at, expires_at, active
         FROM weather_alerts ${where} ORDER BY issued_at DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toAlert);
  }

  async create(tx: unknown, alert: WeatherAlert): Promise<WeatherAlert> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO weather_alerts (id, alert_code, alert_type, level, color, title, description, city, plot_code, issued_at, expires_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (alert_code) DO NOTHING`,
      alert.id,
      alert.alertCode,
      alert.alertType,
      alert.level,
      alert.color,
      alert.title,
      alert.description,
      alert.city,
      alert.plotCode,
      alert.issuedAt,
      alert.expiresAt ?? null,
      alert.active,
    );
    return alert;
  }

  /** 撤销预警：置 active=false，用于演示「雨过天晴解除大风预警」 */
  async deactivate(alertCode: string): Promise<boolean> {
    // 带 active = TRUE，返回值才是「本次真的解除了一条在效预警」；
    // 不加的话重复解除第二次仍命中行并返回 true，内存模式却返回 false。
    return (await this.client.$executeRawUnsafe(`UPDATE weather_alerts SET active = FALSE WHERE alert_code = $1 AND active = TRUE`, alertCode)) > 0;
  }

  async count(): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*)::int AS total FROM weather_alerts`);
    return Number(rows[0]?.total ?? 0);
  }
}

/** 内存实现 */
export class InMemoryAlertRepository {
  private readonly rows: WeatherAlert[] = [];

  constructor(seed: WeatherAlert[] = []) {
    this.rows.push(...seed);
  }

  async list(query: AlertQuery = {}): Promise<WeatherAlert[]> {
    return this.rows
      .filter((row) => (query.level ? row.level === query.level : true))
      .filter((row) => (query.alertType ? row.alertType === query.alertType : true))
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .filter((row) => (query.activeOnly ? row.active : true))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
      .slice(0, 200)
      .map((row) => structuredClone(row));
  }

  async create(_tx: unknown, alert: WeatherAlert): Promise<WeatherAlert> {
    // 撞码（alert_code 已存在）时不写新行，与 SQL 的 ON CONFLICT DO NOTHING 同口径；
    // 返回的仍是调用方那条，两套模式都不回读旧行，行为一致。
    const exists = this.rows.some((row) => row.alertCode === alert.alertCode);
    if (!exists) this.rows.push(structuredClone(alert));
    return structuredClone(alert);
  }

  async deactivate(alertCode: string): Promise<boolean> {
    const row = this.rows.find((item) => item.alertCode === alertCode && item.active);
    if (!row) return false;
    row.active = false;
    return true;
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  all(): WeatherAlert[] {
    return this.rows.map((row) => structuredClone(row));
  }
}

export function newAlertId(): string {
  return ulid();
}
