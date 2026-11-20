import type { MonitorAlertKind, PageResult } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 运维监控仓储（F3）：巡检状态、告警规则与告警台账。
 *
 * 监控是平台级能力，不随租户隔离。SQL 侧落 ops_service_status /
 * ops_monitor_rules / ops_monitor_alerts（迁移 062），内存侧同口径双实现。
 * 同一目标同一类型最多一条在报告警：SQL 靠部分唯一索引兜底，内存侧同规则判重。
 */

export type MonitorTargetKind = "SERVICE" | "INFRA";
export type MonitorStatusValue = "UP" | "DOWN" | "UNKNOWN";
export type MonitorAlertLevel = "WARNING" | "CRITICAL";
export type MonitorAlertStatus = "FIRING" | "RESOLVED";

export interface ServiceStatus {
  target: string;
  kind: MonitorTargetKind;
  label: string;
  status: MonitorStatusValue;
  /** 最近一次探测耗时（毫秒），探测失败时缺省 */
  latencyMs?: number;
  lastError?: string;
  consecutiveFailures: number;
  lastCheckedAt?: string;
  lastUpAt?: string;
  lastDownAt?: string;
  updatedAt: string;
}

export interface MonitorRule {
  id: string;
  kind: MonitorAlertKind;
  /** SERVICE_SLOW 的响应时长阈值（毫秒）；DOWN 类规则不使用，置 0 */
  thresholdMs: number;
  /** 连续异常轮次达到该值才触发告警 */
  consecutive: number;
  enabled: boolean;
  updatedAt: string;
}

export interface MonitorAlert {
  id: string;
  target: string;
  kind: MonitorAlertKind;
  level: MonitorAlertLevel;
  status: MonitorAlertStatus;
  message: string;
  firedAt: string;
  resolvedAt?: string;
}

export interface MonitorAlertQuery {
  page: number;
  size: number;
  status?: MonitorAlertStatus;
  target?: string;
}

export interface MonitorRepository {
  listStatus(): Promise<ServiceStatus[]>;
  upsertStatus(record: ServiceStatus): Promise<void>;
  listRules(): Promise<MonitorRule[]>;
  findRule(id: string): Promise<MonitorRule | null>;
  saveRule(rule: MonitorRule): Promise<MonitorRule>;
  pageAlerts(query: MonitorAlertQuery): Promise<PageResult<MonitorAlert>>;
  /** 触发告警；同目标同类型已有在报告警时返回 false，不重复触发 */
  fireAlert(alert: MonitorAlert): Promise<boolean>;
  /** 撤销目标的全部（或指定类型）在报告警，返回被撤销的行 */
  resolveAlerts(target: string, resolvedAt: string, kind?: MonitorAlertKind): Promise<MonitorAlert[]>;
}

const RULE_SEED_AT = "2026-11-20T00:00:00.000Z";

/** 默认告警规则，与迁移 062 的 INSERT 逐条同口径；内存实现由组合根显式注入 */
export function seedMonitorRules(): MonitorRule[] {
  return [
    { id: "rule-service-down", kind: "SERVICE_DOWN", thresholdMs: 0, consecutive: 3, enabled: true, updatedAt: RULE_SEED_AT },
    { id: "rule-service-slow", kind: "SERVICE_SLOW", thresholdMs: 2000, consecutive: 3, enabled: true, updatedAt: RULE_SEED_AT },
    { id: "rule-infra-down", kind: "INFRA_DOWN", thresholdMs: 0, consecutive: 2, enabled: true, updatedAt: RULE_SEED_AT },
  ];
}

function toPage<T>(items: T[], total: number, page: number, size: number): PageResult<T> {
  return { items, total, page, size, pages: Math.ceil(total / size) };
}

export class InMemoryMonitorRepository implements MonitorRepository {
  private readonly statuses = new Map<string, ServiceStatus>();
  private readonly rules: MonitorRule[];
  private readonly alerts: MonitorAlert[] = [];
  constructor(seed: { rules?: MonitorRule[] } = {}) {
    this.rules = structuredClone(seed.rules ?? []);
  }
  async listStatus(): Promise<ServiceStatus[]> {
    return structuredClone([...this.statuses.values()].sort((a, b) => a.target.localeCompare(b.target)));
  }
  async upsertStatus(record: ServiceStatus): Promise<void> {
    this.statuses.set(record.target, structuredClone(record));
  }
  async listRules(): Promise<MonitorRule[]> {
    return structuredClone([...this.rules].sort((a, b) => a.id.localeCompare(b.id)));
  }
  async findRule(id: string): Promise<MonitorRule | null> {
    const rule = this.rules.find((row) => row.id === id);
    return rule ? structuredClone(rule) : null;
  }
  async saveRule(rule: MonitorRule): Promise<MonitorRule> {
    const index = this.rules.findIndex((row) => row.id === rule.id);
    if (index >= 0) this.rules[index] = structuredClone(rule);
    else this.rules.push(structuredClone(rule));
    return structuredClone(rule);
  }
  async pageAlerts(query: MonitorAlertQuery): Promise<PageResult<MonitorAlert>> {
    const filtered = this.alerts
      .filter((row) => (!query.status || row.status === query.status) && (!query.target || row.target === query.target))
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt));
    return toPage(structuredClone(filtered.slice((query.page - 1) * query.size, query.page * query.size)), filtered.length, query.page, query.size);
  }
  async fireAlert(alert: MonitorAlert): Promise<boolean> {
    if (this.alerts.some((row) => row.target === alert.target && row.kind === alert.kind && row.status === "FIRING")) return false;
    this.alerts.push(structuredClone(alert));
    return true;
  }
  async resolveAlerts(target: string, resolvedAt: string, kind?: MonitorAlertKind): Promise<MonitorAlert[]> {
    const resolved: MonitorAlert[] = [];
    for (const row of this.alerts) {
      if (row.target === target && row.status === "FIRING" && (!kind || row.kind === kind)) {
        row.status = "RESOLVED";
        row.resolvedAt = resolvedAt;
        resolved.push(structuredClone(row));
      }
    }
    return resolved;
  }
}

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : toIsoTimestamp(value);
}

function fromStatusRow(row: Record<string, unknown>): ServiceStatus {
  const latencyMs = row.latency_ms === null || row.latency_ms === undefined ? undefined : Number(row.latency_ms);
  const lastError = row.last_error === null || row.last_error === undefined ? undefined : String(row.last_error);
  const lastCheckedAt = optionalIso(row.last_checked_at);
  const lastUpAt = optionalIso(row.last_up_at);
  const lastDownAt = optionalIso(row.last_down_at);
  return {
    target: String(row.target), kind: row.kind as MonitorTargetKind, label: String(row.label),
    status: row.status as MonitorStatusValue, consecutiveFailures: Number(row.consecutive_failures),
    updatedAt: toIsoTimestamp(row.updated_at),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
    ...(lastUpAt === undefined ? {} : { lastUpAt }),
    ...(lastDownAt === undefined ? {} : { lastDownAt }),
  };
}

function fromRuleRow(row: Record<string, unknown>): MonitorRule {
  return {
    id: String(row.id), kind: row.kind as MonitorAlertKind,
    thresholdMs: Number(row.threshold_ms), consecutive: Number(row.consecutive),
    enabled: row.enabled === true, updatedAt: toIsoTimestamp(row.updated_at),
  };
}

function fromAlertRow(row: Record<string, unknown>): MonitorAlert {
  const resolvedAt = optionalIso(row.resolved_at);
  return {
    id: String(row.id), target: String(row.target), kind: row.kind as MonitorAlertKind,
    level: row.level as MonitorAlertLevel, status: row.status as MonitorAlertStatus,
    message: String(row.message), firedAt: toIsoTimestamp(row.fired_at),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
  };
}

export class SqlMonitorRepository implements MonitorRepository {
  constructor(private readonly client: PrismaClientLike) {}
  async listStatus(): Promise<ServiceStatus[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ops_service_status ORDER BY target ASC`);
    return rows.map(fromStatusRow);
  }
  async upsertStatus(record: ServiceStatus): Promise<void> {
    await this.client.$queryRawUnsafe(
      `INSERT INTO ops_service_status (target, kind, label, status, latency_ms, last_error, consecutive_failures, last_checked_at, last_up_at, last_down_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz)
       ON CONFLICT (target) DO UPDATE SET kind = EXCLUDED.kind, label = EXCLUDED.label, status = EXCLUDED.status,
         latency_ms = EXCLUDED.latency_ms, last_error = EXCLUDED.last_error, consecutive_failures = EXCLUDED.consecutive_failures,
         last_checked_at = EXCLUDED.last_checked_at, last_up_at = EXCLUDED.last_up_at, last_down_at = EXCLUDED.last_down_at, updated_at = EXCLUDED.updated_at`,
      record.target, record.kind, record.label, record.status, record.latencyMs ?? null, record.lastError ?? null,
      record.consecutiveFailures, record.lastCheckedAt ?? null, record.lastUpAt ?? null, record.lastDownAt ?? null, record.updatedAt,
    );
  }
  async listRules(): Promise<MonitorRule[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ops_monitor_rules ORDER BY id ASC`);
    return rows.map(fromRuleRow);
  }
  async findRule(id: string): Promise<MonitorRule | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ops_monitor_rules WHERE id = $1`, id);
    return rows[0] ? fromRuleRow(rows[0]) : null;
  }
  async saveRule(rule: MonitorRule): Promise<MonitorRule> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE ops_monitor_rules SET threshold_ms = $2, consecutive = $3, enabled = $4, updated_at = $5::timestamptz WHERE id = $1 RETURNING *`,
      rule.id, rule.thresholdMs, rule.consecutive, rule.enabled, rule.updatedAt,
    );
    return fromRuleRow(rows[0]!);
  }
  async pageAlerts(query: MonitorAlertQuery): Promise<PageResult<MonitorAlert>> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (query.status) { values.push(query.status); where.push(`status = $${values.length}`); }
    if (query.target) { values.push(query.target); where.push(`target = $${values.length}`); }
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const counts = await this.client.$queryRawUnsafe<Array<{ total: string }>>(`SELECT count(*) AS total FROM ops_monitor_alerts ${filter}`, ...values);
    const total = Number(counts[0]?.total ?? 0);
    values.push(query.size, (query.page - 1) * query.size);
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM ops_monitor_alerts ${filter} ORDER BY fired_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, ...values,
    );
    return toPage(rows.map(fromAlertRow), total, query.page, query.size);
  }
  async fireAlert(alert: MonitorAlert): Promise<boolean> {
    const rows = await this.client.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ops_monitor_alerts (id, target, kind, level, status, message, fired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (target, kind) WHERE status = 'FIRING' DO NOTHING RETURNING id`,
      alert.id, alert.target, alert.kind, alert.level, alert.status, alert.message, alert.firedAt,
    );
    return rows.length > 0;
  }
  async resolveAlerts(target: string, resolvedAt: string, kind?: MonitorAlertKind): Promise<MonitorAlert[]> {
    const rows = kind === undefined
      ? await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
          `UPDATE ops_monitor_alerts SET status = 'RESOLVED', resolved_at = $2::timestamptz WHERE target = $1 AND status = 'FIRING' RETURNING *`,
          target, resolvedAt,
        )
      : await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
          `UPDATE ops_monitor_alerts SET status = 'RESOLVED', resolved_at = $3::timestamptz WHERE target = $1 AND status = 'FIRING' AND kind = $2 RETURNING *`,
          target, kind, resolvedAt,
        );
    return rows.map(fromAlertRow);
  }
}