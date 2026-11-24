import { createHash, randomUUID } from "node:crypto";

import type { PrismaClientLike } from "@agri/db";

export type MqttDeliveryDirection = "INBOUND" | "OUTBOUND";
export type MqttDeliveryStatus = "PENDING" | "DONE";

export interface MqttDelivery {
  id: string;
  direction: MqttDeliveryDirection;
  tenantId: string;
  deviceNo: string;
  deviceId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: MqttDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
}

export interface MqttInboundOptions {
  packetId?: number;
  duplicate?: boolean;
}

export interface MqttDeliveryRepository {
  enqueueInbound(input: Omit<MqttDelivery, "id" | "status" | "attempts" | "nextAttemptAt" | "createdAt">, options?: MqttInboundOptions): Promise<MqttDelivery>;
  enqueueOutbound(input: Omit<MqttDelivery, "id" | "direction" | "status" | "attempts" | "nextAttemptAt" | "createdAt">): Promise<MqttDelivery>;
  due(nowMs: number, limit: number): Promise<MqttDelivery[]>;
  fail(id: string, error: string, nowMs: number): Promise<void>;
  complete(id: string): Promise<void>;
  cleanup(nowMs: number, limit: number): Promise<void>;
}

const COLUMNS = "id, direction, tenant_id, device_no, device_id, topic, payload, status, attempts, next_attempt_at, last_error, created_at";

function digest(topic: string, payload: string): string {
  return createHash("sha256").update(`${topic}\n${payload}`).digest("hex");
}

function inboundKey(input: { tenantId: string; topic: string; payload: Record<string, unknown> }, options?: MqttInboundOptions): string | null {
  if (!options?.packetId || !Number.isInteger(options.packetId)) return null;
  return digest(`${input.tenantId}\n${input.topic}\n${options.packetId}`, JSON.stringify(input.payload));
}

function retryAt(attempts: number, nowMs: number): string {
  return new Date(nowMs + Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))).toISOString();
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function toRecord(row: Record<string, unknown>): MqttDelivery {
  const raw = row.payload;
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    id: String(row.id),
    direction: row.direction as MqttDeliveryDirection,
    tenantId: String(row.tenant_id),
    deviceNo: String(row.device_no),
    deviceId: String(row.device_id),
    topic: String(row.topic),
    payload: parsed as Record<string, unknown>,
    status: row.status as MqttDeliveryStatus,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: toIso(row.next_attempt_at),
    ...(row.last_error === null || row.last_error === undefined ? {} : { lastError: String(row.last_error) }),
    createdAt: toIso(row.created_at),
  };
}

export class SqlMqttDeliveryRepository implements MqttDeliveryRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async enqueueInbound(input: Omit<MqttDelivery, "id" | "status" | "attempts" | "nextAttemptAt" | "createdAt">, options?: MqttInboundOptions): Promise<MqttDelivery> {
    const id = `in-${randomUUID()}`;
    const packetKey = inboundKey(input, options);
    const now = new Date().toISOString();
    if (packetKey && !options?.duplicate) {
      await this.client.$executeRawUnsafe(
        `UPDATE mqtt_deliveries SET packet_key = NULL
          WHERE packet_key = $1 AND direction = 'INBOUND' AND status = 'DONE'`,
        packetKey,
      );
    }
    await this.client.$executeRawUnsafe(
      `INSERT INTO mqtt_deliveries (id, direction, tenant_id, device_no, device_id, topic, payload, packet_key, status, attempts, next_attempt_at, created_at)
       VALUES ($1, 'INBOUND', $2, $3, $4, $5, $6::jsonb, $7, 'PENDING', 0, $8, $8)
       ON CONFLICT (packet_key) WHERE direction = 'INBOUND' AND packet_key IS NOT NULL DO NOTHING`,
      id, input.tenantId, input.deviceNo, input.deviceId, input.topic, JSON.stringify(input.payload), packetKey, now,
    );
    const rows = packetKey
      ? await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${COLUMNS} FROM mqtt_deliveries WHERE packet_key = $1 AND direction = 'INBOUND'`, packetKey)
      : await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${COLUMNS} FROM mqtt_deliveries WHERE id = $1`, id);
    return toRecord(rows[0]!);
  }

  async enqueueOutbound(input: Omit<MqttDelivery, "id" | "direction" | "status" | "attempts" | "nextAttemptAt" | "createdAt">): Promise<MqttDelivery> {
    const commandId = String(input.payload.id ?? "").trim();
    if (!commandId) throw new Error("MQTT 指令缺少 id");
    const id = `out-${commandId}`;
    const now = new Date().toISOString();
    await this.client.$executeRawUnsafe(
      `INSERT INTO mqtt_deliveries (id, direction, tenant_id, device_no, device_id, topic, payload, status, attempts, next_attempt_at, created_at)
       VALUES ($1, 'OUTBOUND', $2, $3, $4, $5, $6::jsonb, 'PENDING', 0, $7, $7)
       ON CONFLICT (id) DO UPDATE SET device_no = EXCLUDED.device_no, device_id = EXCLUDED.device_id, topic = EXCLUDED.topic, payload = EXCLUDED.payload
       WHERE mqtt_deliveries.status = 'PENDING'`,
      id, input.tenantId, input.deviceNo, input.deviceId, input.topic, JSON.stringify(input.payload), now,
    );
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT ${COLUMNS} FROM mqtt_deliveries WHERE id = $1`, id);
    return toRecord(rows[0]!);
  }

  async due(nowMs: number, limit: number): Promise<MqttDelivery[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM mqtt_deliveries
       WHERE status = 'PENDING' AND next_attempt_at <= $1
       ORDER BY next_attempt_at, created_at, id LIMIT $2`,
      new Date(nowMs).toISOString(), limit,
    );
    return rows.map(toRecord);
  }

  async fail(id: string, error: string, nowMs: number): Promise<void> {
    await this.client.$executeRawUnsafe(
      `UPDATE mqtt_deliveries
          SET attempts = attempts + 1,
              next_attempt_at = $2::timestamptz + LEAST(INTERVAL '30 seconds', INTERVAL '1 second' * power(2, LEAST(attempts + 1, 5))),
              last_error = $3
        WHERE id = $1 AND status = 'PENDING'`,
      id, new Date(nowMs).toISOString(), error.slice(0, 1000),
    );
  }

  async complete(id: string): Promise<void> {
    await this.client.$executeRawUnsafe(
      `DELETE FROM mqtt_deliveries WHERE id = $1 AND direction = 'OUTBOUND'`,
      id,
    );
    await this.client.$executeRawUnsafe(
      `UPDATE mqtt_deliveries SET status = 'DONE', last_error = NULL WHERE id = $1 AND direction = 'INBOUND'`,
      id,
    );
  }

  async cleanup(nowMs: number, limit: number): Promise<void> {
    await this.client.$executeRawUnsafe(
      `DELETE FROM mqtt_deliveries
        WHERE id IN (
          SELECT id FROM mqtt_deliveries
           WHERE direction = 'INBOUND' AND status = 'DONE' AND created_at < $1
           ORDER BY created_at LIMIT $2
        )`,
      new Date(nowMs - 86_400_000).toISOString(), limit,
    );
  }
}

export class InMemoryMqttDeliveryRepository implements MqttDeliveryRepository {
  private readonly rows = new Map<string, MqttDelivery>();
  private readonly packetKeys = new Map<string, string>();

  async enqueueInbound(input: Omit<MqttDelivery, "id" | "status" | "attempts" | "nextAttemptAt" | "createdAt">, options?: MqttInboundOptions): Promise<MqttDelivery> {
    const packetKey = inboundKey(input, options);
    const existingId = packetKey ? this.packetKeys.get(packetKey) : undefined;
    if (existingId) {
      const existing = this.rows.get(existingId);
      if (existing && (options?.duplicate || existing.status === "PENDING")) return structuredClone(existing);
      this.packetKeys.delete(packetKey!);
    }
    const id = `in-${randomUUID()}`;
    const delivery = this.put({ ...input, id, direction: "INBOUND", status: "PENDING", attempts: 0, nextAttemptAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    if (packetKey) this.packetKeys.set(packetKey, id);
    return delivery;
  }

  async enqueueOutbound(input: Omit<MqttDelivery, "id" | "direction" | "status" | "attempts" | "nextAttemptAt" | "createdAt">): Promise<MqttDelivery> {
    const commandId = String(input.payload.id ?? "").trim();
    if (!commandId) throw new Error("MQTT 指令缺少 id");
    const id = `out-${commandId}`;
    const existing = this.rows.get(id);
    if (existing?.status === "PENDING") {
      const updated: MqttDelivery = {
        ...input,
        id,
        direction: "OUTBOUND",
        status: "PENDING",
        attempts: existing.attempts,
        nextAttemptAt: existing.nextAttemptAt,
        createdAt: existing.createdAt,
      };
      this.rows.set(id, structuredClone(updated));
      return structuredClone(updated);
    }
    return this.put({ ...input, id, direction: "OUTBOUND", status: "PENDING", attempts: 0, nextAttemptAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  }

  private put(row: MqttDelivery): MqttDelivery {
    const existing = this.rows.get(row.id);
    if (existing) return structuredClone(existing);
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async due(nowMs: number, limit: number): Promise<MqttDelivery[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === "PENDING" && Date.parse(row.nextAttemptAt) <= nowMs)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async fail(id: string, error: string, nowMs: number): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.status !== "PENDING") return;
    row.attempts += 1;
    row.nextAttemptAt = retryAt(row.attempts, nowMs);
    row.lastError = error.slice(0, 1000);
  }

  async complete(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    if (row.direction === "OUTBOUND") this.rows.delete(id);
    else row.status = "DONE";
  }

  async cleanup(nowMs: number, limit: number): Promise<void> {
    const cutoff = nowMs - 86_400_000;
    [...this.rows.values()]
      .filter((row) => row.direction === "INBOUND" && row.status === "DONE" && Date.parse(row.createdAt) < cutoff)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .forEach((row) => this.rows.delete(row.id));
  }
}
