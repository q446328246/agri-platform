import type { MessageLevel } from "@agri/contracts";
import { MESSAGE_TEMPLATES, MESSAGE_TEMPLATE_TOPICS } from "@agri/contracts";
import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 消息订阅偏好。
 *
 * 偏好按「租户 + 来源主题」保存，消费侧先查偏好再决定是否落库：
 * 关闭订阅则完全不写消息，最低级别高于消息级别则跳过。
 * 没有偏好记录等同于「全部启用、最低 INFO」，因此新主题上线无需初始化数据。
 */

/** 订阅偏好 */
export interface MessagePreference {
  tenantId: string;
  /** 来源事件主题，取值来自消息模板目录 */
  topic: string;
  enabled: boolean;
  /** 最低级别：低于该级别的消息不落库 */
  minLevel: MessageLevel;
  updatedAt: string;
}

/** 更新偏好入参 */
export interface MessagePreferenceInput {
  enabled?: boolean;
  minLevel?: MessageLevel;
}

export interface MessagePreferenceRepository {
  /** 读取租户的全部偏好，未配置的主题不返回 */
  list(tenantId: string): Promise<MessagePreference[]>;
  find(tenantId: string, topic: string): Promise<MessagePreference | null>;
  upsert(preference: MessagePreference): Promise<MessagePreference>;
}

/** 缺省偏好：全部启用、最低 INFO */
export function defaultPreference(tenantId: string, topic: string): MessagePreference {
  return { tenantId, topic, enabled: true, minLevel: "INFO", updatedAt: "" };
}

/** 合并模板目录与已保存偏好，供接口与前端直接展示 */
export function mergePreferences(tenantId: string, stored: MessagePreference[]): Array<MessagePreference & { label: string; type: string }> {
  const byTopic = new Map(stored.map((item) => [item.topic, item]));
  return MESSAGE_TEMPLATE_TOPICS.map((topic) => {
    const preference = byTopic.get(topic) ?? defaultPreference(tenantId, topic);
    const template = MESSAGE_TEMPLATES[topic];
    return { ...preference, label: template.label, type: template.type };
  });
}

function toRecord(row: Record<string, unknown>): MessagePreference {
  return {
    tenantId: String(row.tenant_id),
    topic: String(row.topic),
    enabled: Boolean(row.enabled),
    minLevel: row.min_level === "CRITICAL" ? "CRITICAL" : row.min_level === "WARNING" ? "WARNING" : "INFO",
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/** PostgreSQL 实现，表结构由迁移 006 管理 */
export class SqlMessagePreferenceRepository implements MessagePreferenceRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async list(tenantId: string): Promise<MessagePreference[]> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT tenant_id, topic, enabled, min_level, updated_at FROM ops_message_preferences WHERE tenant_id = $1 ORDER BY topic",
      tenantId,
    );
    return rows.map(toRecord);
  }

  async find(tenantId: string, topic: string): Promise<MessagePreference | null> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT tenant_id, topic, enabled, min_level, updated_at FROM ops_message_preferences WHERE tenant_id = $1 AND topic = $2 LIMIT 1",
      tenantId,
      topic,
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async upsert(preference: MessagePreference): Promise<MessagePreference> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO ops_message_preferences (tenant_id, topic, enabled, min_level, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, topic) DO UPDATE SET enabled = EXCLUDED.enabled, min_level = EXCLUDED.min_level, updated_at = now()
       RETURNING tenant_id, topic, enabled, min_level, updated_at`,
      preference.tenantId,
      preference.topic,
      preference.enabled,
      preference.minLevel,
    );
    const row = rows[0];
    if (!row) throw new Error("订阅偏好写入失败");
    return toRecord(row);
  }
}

/** 内存实现：未接入数据库的本地模式与测试使用 */
export class InMemoryMessagePreferenceRepository implements MessagePreferenceRepository {
  private readonly rows = new Map<string, MessagePreference>();

  private key(tenantId: string, topic: string): string {
    return `${tenantId}:${topic}`;
  }

  async list(tenantId: string): Promise<MessagePreference[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((left, right) => left.topic.localeCompare(right.topic));
  }

  async find(tenantId: string, topic: string): Promise<MessagePreference | null> {
    return this.rows.get(this.key(tenantId, topic)) ?? null;
  }

  async upsert(preference: MessagePreference): Promise<MessagePreference> {
    const record: MessagePreference = { ...preference, updatedAt: preference.updatedAt || new Date().toISOString() };
    this.rows.set(this.key(preference.tenantId, preference.topic), record);
    return record;
  }
}
