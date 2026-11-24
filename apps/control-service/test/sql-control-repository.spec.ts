import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PgClientAdapter } from "@agri/db";

import { SqlControlCommandRepository } from "../src/control.repository.js";
import type { ControlCommand } from "../src/control.repository.js";

const databaseUrl = process.env.DB_URL;
const MINUTE = 60_000;

function command(id: string, tenantId: string, overrides: Partial<ControlCommand> = {}): ControlCommand {
  return {
    id, tenantId, deviceId: "device-smoke-control", plotCode: "P-SMOKE", operatorId: "smoke",
    confirmedAt: new Date().toISOString(), type: "SEEDING", parameters: { areaMu: 1, durationMin: 1 },
    status: "QUEUED", origin: "MANUAL", reason: "SQL 回归", version: 1, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.runIf(databaseUrl)("SqlControlCommandRepository 互锁与动态超时（真实库）", () => {
  it("数据库拒绝同设备第二条在途作业，长作业不被通用阈值提前收口", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlControlCommandRepository(client);
    const tenantId = "tenant-smoke-control-sql";
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const first = command(`job-a-${suffix}`, tenantId);
      const second = command(`job-b-${suffix}`, tenantId);
      const safety = command(`pause-${suffix}`, tenantId, { type: "PAUSE", parameters: { targetCommandId: first.id } });
      expect(await repository.create(first)).not.toBeNull();
      expect(await repository.create(second)).toBeNull();
      expect(await repository.create(safety)).not.toBeNull();

      const long = command(`long-${suffix}`, tenantId, {
        deviceId: "device-smoke-long",
        parameters: { areaMu: 20, durationMin: 120, plan: { totalDurationMin: 120 } },
        createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      });
      const short = command(`short-${suffix}`, tenantId, {
        deviceId: "device-smoke-short",
        createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      });
      expect(await repository.create(long)).not.toBeNull();
      expect(await repository.create(short)).not.toBeNull();
      const overdue = await repository.listOverdue(15, Date.now(), 50);
      expect(overdue.map((item) => item.id)).toContain(short.id);
      expect(overdue.map((item) => item.id)).not.toContain(long.id);
    } finally {
      await client.$executeRawUnsafe("DELETE FROM control_commands WHERE tenant_id = $1", tenantId);
      await client.$disconnect();
    }
  });

  it("SQL 超时扫描使用注入时钟、数值类型与向上取整阈值", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlControlCommandRepository(client);
    const tenantId = "tenant-smoke-control-clock";
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const nowMs = Date.now();
    try {
      const injectedDue = command(`injected-due-${suffix}`, tenantId, {
        deviceId: `device-clock-due-${suffix}`, createdAt: new Date(nowMs - 10 * MINUTE).toISOString(),
      });
      const notDue = command(`fractional-not-due-${suffix}`, tenantId, {
        deviceId: `device-clock-not-due-${suffix}`, createdAt: new Date(nowMs - 9.5 * MINUTE).toISOString(),
      });
      const stringPlan = command(`string-plan-${suffix}`, tenantId, {
        deviceId: `device-clock-string-${suffix}`, createdAt: new Date(nowMs - 20 * MINUTE).toISOString(),
        parameters: { plan: { totalDurationMin: "120" } },
      });
      expect(await repository.create(injectedDue)).not.toBeNull();
      expect(await repository.create(notDue)).not.toBeNull();
      expect(await repository.create(stringPlan)).not.toBeNull();

      const overdue = await repository.listOverdue(15, nowMs, 50);
      expect(overdue.map((item) => item.id)).not.toContain(injectedDue.id);
      expect(overdue.map((item) => item.id)).not.toContain(notDue.id);
      expect(overdue.map((item) => item.id)).toContain(stringPlan.id);

      const future = await repository.listOverdue(15.2, nowMs + 6 * MINUTE + 30_000, 50);
      expect(future.map((item) => item.id)).toContain(injectedDue.id);
      expect(future.map((item) => item.id)).not.toContain(notDue.id);
    } finally {
      await client.$executeRawUnsafe("DELETE FROM control_commands WHERE tenant_id = $1", tenantId);
      await client.$disconnect();
    }
  });

  it("连续两轮暂停恢复符合迁移约束，新暂停清空旧恢复时刻", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlControlCommandRepository(client);
    const tenantId = "tenant-smoke-control-pause";
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const id = `pause-cycle-${suffix}`;
    try {
      expect(await repository.create(command(id, tenantId, { deviceId: `device-pause-${suffix}` }))).not.toBeNull();
      let current = await repository.find(tenantId, id);
      const transitions = [
        { status: "SENT" as const, at: "2026-11-12T00:01:00.000Z" },
        { status: "ACKED" as const, at: "2026-11-12T00:02:00.000Z" },
        { status: "PAUSED" as const, at: "2026-11-12T00:03:00.000Z" },
        { status: "ACKED" as const, at: "2026-11-12T00:04:00.000Z" },
        { status: "PAUSED" as const, at: "2026-11-12T00:05:00.000Z" },
        { status: "ACKED" as const, at: "2026-11-12T00:06:00.000Z" },
      ];
      for (const transition of transitions) {
        current = await repository.transition(tenantId, { id, version: current!.version, ...transition });
        expect(current).not.toBeNull();
        if (transition.status === "PAUSED") expect(current?.resumedAt).toBeUndefined();
        if (transition.status === "ACKED" && Date.parse(transition.at) >= Date.parse("2026-11-12T00:04:00.000Z")) {
          expect(current?.resumedAt).toBe(transition.at);
        }
      }
      expect(current).toMatchObject({
        status: "ACKED", pausedAt: "2026-11-12T00:05:00.000Z", resumedAt: "2026-11-12T00:06:00.000Z",
      });
    } finally {
      await client.$executeRawUnsafe("DELETE FROM control_commands WHERE tenant_id = $1", tenantId);
      await client.$disconnect();
    }
  });

  it("设备互锁迁移取消重复待执行指令，并拒绝多条已执行中指令", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const schema = `migration_079_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const migration = readFileSync(new URL("../../../infra/postgres/migrations/079_control_active_device_job.sql", import.meta.url), "utf8");
    try {
      await client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await client.$executeRawUnsafe(`SET search_path TO "${schema}"`);
      await client.$executeRawUnsafe(`CREATE TABLE control_commands (
        id text PRIMARY KEY, tenant_id text NOT NULL, device_id text NOT NULL, type text NOT NULL,
        status text NOT NULL, created_at timestamptz NOT NULL, version integer NOT NULL,
        finished_at timestamptz, receipt_message text
      )`);
      await client.$executeRawUnsafe(`INSERT INTO control_commands (id, tenant_id, device_id, type, status, created_at, version)
        VALUES ('old', 'tenant', 'device-a', 'IRRIGATION', 'QUEUED', now() - interval '2 minutes', 1),
               ('new', 'tenant', 'device-a', 'IRRIGATION', 'QUEUED', now(), 1),
               ('sent', 'tenant', 'device-b', 'SEEDING', 'SENT', now() - interval '1 minute', 1),
               ('queued', 'tenant', 'device-b', 'SEEDING', 'QUEUED', now(), 1)`);
      await client.$executeRawUnsafe(migration);
      const rows = await client.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        "SELECT id, status FROM control_commands ORDER BY id",
      );
      expect(rows).toEqual([
        { id: "new", status: "QUEUED" },
        { id: "old", status: "CANCELLED" },
        { id: "queued", status: "CANCELLED" },
        { id: "sent", status: "SENT" },
      ]);
      await expect(client.$executeRawUnsafe(`INSERT INTO control_commands (id, tenant_id, device_id, type, status, created_at, version)
        VALUES ('duplicate', 'tenant', 'device-b', 'SEEDING', 'ACKED', now(), 1)`)).rejects.toThrow();
      await client.$executeRawUnsafe("DROP INDEX uq_control_commands_active_device_job");
      await client.$executeRawUnsafe(`INSERT INTO control_commands (id, tenant_id, device_id, type, status, created_at, version)
        VALUES ('duplicate', 'tenant', 'device-b', 'SEEDING', 'ACKED', now(), 1)`);
      await expect(client.$executeRawUnsafe(migration)).rejects.toThrow("多条已执行中的作业指令");
    } finally {
      await client.$executeRawUnsafe("SET search_path TO public").catch(() => undefined);
      await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.$disconnect();
    }
  });
});
