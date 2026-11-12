import { describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { EventTopic } from "@agri/contracts";
import type { CommandTimeoutPayload } from "@agri/contracts";
import type { OutboxRecord } from "@agri/mq";
import { OutboxService } from "@agri/mq";
import { PgClientAdapter } from "@agri/db";
import type { Tx } from "@agri/db";

import { buildIrrigationPlan, waterVolumeOf } from "../src/command-spec.js";
import { SqlControlCommandRepository } from "../src/control.repository.js";
import { createControlHttpServer } from "../src/http.js";
import { SqlControlOutboxStore } from "../src/outbox.repository.js";
import { ControlReceiptSweeper } from "../src/receipt-sweeper.js";

/**
 * 控制指令本地消息表（control_outbox）与超时收口的 SQL 侧回归。
 *
 * 关键约定：时间列必须映射为 ISO 字符串（中继写回 event_log 时才是合法时间戳）、
 * enqueue 必须在事务中执行（脱离事务等于绕过「状态与事件同事务」的保证）、
 * 收口候选的超时口径与列表 overdue=true 共用同一个 SQL 谓词。
 * 真实库用例只在 DB_URL 存在时跑，且只写自己造的指令与消息记录，收尾删除。
 */

const TENANT = "tenant-demo";

/** 真实库用例自己起的 HTTP 服务，收尾统一关闭 */
const servers: Server[] = [];

const row = {
  id: "outbox-control-1",
  topic: EventTopic.ControlCommandTimeout,
  payload_json: { commandId: "cmd-1", parcelId: "511723-000001-01-00001-0000-5", deviceId: "device-irri-001", commandType: "IRRIGATION", pendingMin: 23, timeoutMin: 15, failedAt: "2026-11-12T02:23:00.000Z" },
  tenant_id: TENANT,
  trace_id: "control-timeout:cmd-1",
  producer: "control",
  created_at: new Date("2026-11-12T02:23:00.000Z"),
  published_at: null,
  retry_count: 0,
  last_error: null,
};

function makeFake(rows: Array<Record<string, unknown>>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async $queryRawUnsafe<T>() {
      return rows as T;
    },
    async $executeRawUnsafe(sql: string, ...params: unknown[]) {
      queries.push({ sql, params });
      return 1;
    },
  };
  return { client, queries };
}

function outboxRecord(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: "outbox-control-2",
    topic: EventTopic.ControlCommandTimeout,
    payload: { commandId: "cmd-2" },
    tenantId: TENANT,
    traceId: "control-timeout:cmd-2",
    producer: "control",
    createdAt: "2026-11-12T02:00:00.000Z",
    retryCount: 0,
    ...overrides,
  };
}

describe("控制服务本地消息表 control_outbox", () => {
  it("listPending 把时间列映射为 ISO 字符串，可直接写回事件日志", async () => {
    const { client } = makeFake([row]);
    const store = new SqlControlOutboxStore(client as never);
    const records = await store.listPending(10);
    expect(records).toHaveLength(1);
    expect(records[0]?.createdAt).toBe("2026-11-12T02:23:00.000Z");
    expect(records[0]?.publishedAt).toBeUndefined();
    expect(records[0]?.topic).toBe(EventTopic.ControlCommandTimeout);
    expect(records[0]?.tenantId).toBe(TENANT);
  });

  it("enqueue 必须携带事务客户端，脱离事务直接拒绝", async () => {
    const { client } = makeFake([]);
    const store = new SqlControlOutboxStore(client as never);
    await expect(store.enqueue(undefined, outboxRecord())).rejects.toThrow("必须在事务中执行");
  });

  it("enqueue 在事务上写入 control_outbox，payload 以 jsonb 落库", async () => {
    const { client, queries } = makeFake([]);
    const store = new SqlControlOutboxStore(client as never);
    const record = outboxRecord();
    const tx = { async $executeRawUnsafe(sql: string, ...params: unknown[]) { queries.push({ sql, params }); return 1; } };
    await store.enqueue(tx, record);
    expect(queries[0]?.sql).toContain("INSERT INTO control_outbox");
    expect(queries[0]?.sql).toContain("$3::jsonb");
    expect(queries[0]?.params[2]).toBe(JSON.stringify(record.payload));
    expect(queries[0]?.params[3]).toBe(TENANT);
  });

  it("markPublished / markFailed 分别更新投递时间与重试次数", async () => {
    const { client, queries } = makeFake([]);
    const store = new SqlControlOutboxStore(client as never);
    await store.markPublished("outbox-control-1");
    await store.markFailed("outbox-control-1", "网络超时");
    expect(queries[0]?.sql).toContain("UPDATE control_outbox SET published_at = now()");
    expect(queries[1]?.sql).toContain("retry_count = retry_count + 1");
  });
});

const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("超时收口真实库链路", () => {
  it("SQL 候选捞出陈旧指令，收口与事件同事务落 control_outbox", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const commands = new SqlControlCommandRepository(client);
    const store = new SqlControlOutboxStore(client);
    const id = `cmd-sweeper-smoke-${Date.now()}`;
    const traceId = `control-timeout:${id}`;
    try {
      // 入队时间放到 40 分钟前：是否超时由库内时钟判定，不靠测试自己造 now
      const createdAt = new Date(Date.now() - 40 * 60_000).toISOString();
      expect(await commands.create({
        id,
        tenantId: TENANT,
        deviceId: "device-irri-smoke",
        plotCode: "511723-000001-01-00001-0000-5",
        operatorId: "user-admin",
        type: "IRRIGATION",
        parameters: { zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }] },
        status: "QUEUED",
        origin: "MANUAL",
        reason: "超时收口冒烟",
        version: 1,
        createdAt,
      })).not.toBeNull();

      const candidate = (await commands.listOverdue(15, Date.now(), 500)).find((item) => item.id === id);
      expect(candidate).toMatchObject({ id, status: "QUEUED", tenantId: TENANT, version: 1 });

      // 收口任务本身是跨租户的，这里把候选限定成自己造的那条，避免动到演示库其它在途指令
      const scoped = {
        listOverdue: async () => (await commands.listOverdue(15, Date.now(), 500)).filter((item) => item.id === id),
        transition: (tenantId: string, transition: Parameters<SqlControlCommandRepository["transition"]>[1], tx?: Tx) =>
          commands.transition(tenantId, transition, tx),
      } as unknown as SqlControlCommandRepository;
      // 中继用假发布器：真实投递由服务启动时的中继负责，这里只验证消息表落库
      const outbox = new OutboxService(store, { async publish() {} } as never, { tenantId: TENANT, traceId: "control-smoke", producer: "control" });
      const sweeper = new ControlReceiptSweeper(scoped, {
        timeoutMin: 15,
        outbox,
        withTransaction: (run) => client.$transaction(run),
      });

      expect(await sweeper.sweepOnce(Date.now())).toBe(1);
      expect(await commands.find(TENANT, id)).toMatchObject({ status: "FAILED", version: 2 });
      expect((await commands.find(TENANT, id))?.receiptMessage).toContain("超过 15 分钟未收到设备回执");

      const pending = (await store.listPending(500)).filter((record) => record.traceId === traceId);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ topic: EventTopic.ControlCommandTimeout, tenantId: TENANT, producer: "control", traceId });
      const payload = pending[0]?.payload as CommandTimeoutPayload;
      expect(payload).toMatchObject({ commandId: id, commandType: "IRRIGATION", parcelId: "511723-000001-01-00001-0000-5", timeoutMin: 15 });
      // 等待时长由指令时间戳现算，库内时钟与本机时钟允许少量偏差
      expect(payload.pendingMin).toBeGreaterThanOrEqual(38);
      expect(payload.pendingMin).toBeLessThanOrEqual(42);

      // 已结束的指令不再进候选，也不会被再收口一次
      expect((await commands.listOverdue(15, Date.now(), 500)).some((item) => item.id === id)).toBe(false);
      expect(await sweeper.sweepOnce(Date.now())).toBe(0);
    } finally {
      await client.$executeRawUnsafe(`DELETE FROM control_outbox WHERE trace_id = $1`, traceId);
      await client.$executeRawUnsafe("DELETE FROM control_commands WHERE id = $1", id);
      await client.$disconnect();
    }
  });

  it("事务内跃迁成功但事件写入失败时整体回滚", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const commands = new SqlControlCommandRepository(client);
    const id = `cmd-sweeper-rollback-${Date.now()}`;
    try {
      expect(await commands.create({
        id,
        tenantId: TENANT,
        deviceId: "device-irri-smoke",
        plotCode: "511723-000001-01-00001-0000-5",
        operatorId: "user-admin",
        type: "WEEDING",
        parameters: {},
        status: "QUEUED",
        origin: "MANUAL",
        reason: "超时收口回滚冒烟",
        version: 1,
        createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      })).not.toBeNull();

      const brokenStore = { async enqueue() { throw new Error("消息表写不进去"); } };
      const outbox = new OutboxService(brokenStore as never, { async publish() {} } as never, { tenantId: TENANT, traceId: "control-smoke", producer: "control" });
      const scoped = {
        listOverdue: async () => (await commands.listOverdue(15, Date.now(), 500)).filter((item) => item.id === id),
        transition: (tenantId: string, transition: Parameters<SqlControlCommandRepository["transition"]>[1], tx?: Tx) =>
          commands.transition(tenantId, transition, tx),
      } as unknown as SqlControlCommandRepository;
      const sweeper = new ControlReceiptSweeper(scoped, {
        timeoutMin: 15,
        outbox,
        withTransaction: (run) => client.$transaction(run),
        onError: () => {},
      });

      expect(await sweeper.sweepOnce(Date.now())).toBe(0);
      // 跃迁已经在事务里做过一次，入队炸了就跟着回滚：状态与版本都必须停在原位
      expect(await commands.find(TENANT, id)).toMatchObject({ status: "QUEUED", version: 1 });
    } finally {
      await client.$executeRawUnsafe("DELETE FROM control_commands WHERE id = $1", id);
      await client.$disconnect();
    }
  });

  it("SQL 模式结单：DONE 与作业完成事件同一事务落库，灌溉与施肥各一条", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const commands = new SqlControlCommandRepository(client);
    const store = new SqlControlOutboxStore(client);
    const stamp = Date.now();
    // 两类指令共用同一条入队代码，只有主题与用量字段不同；数值全部由分区参数现算
    const cases = [
      {
        type: "IRRIGATION" as const,
        topic: EventTopic.ControlIrrigationFinished,
        parameters: { zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }] },
        amountKey: "waterVolume" as const,
        amount: waterVolumeOf(10, 20),
      },
      {
        type: "FERTILIZATION" as const,
        topic: EventTopic.ControlFertilizationFinished,
        parameters: { zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }], recipe: { nitrogen: 8, phosphorus: 4, potassium: 3 } },
        amountKey: "fertilizerKg" as const,
        amount: buildIrrigationPlan({
          zones: [{ zoneCode: "ZONE-01", areaMu: 10, targetMm: 20 }],
          recipe: { nitrogen: 8, phosphorus: 4, potassium: 3 },
        }).recipe?.totalKg,
      },
    ];
    const created: Array<{ id: string; traceId: string }> = [];
    const server = createControlHttpServer(commands, {
      outbox: new OutboxService(store, { async publish() {} } as never, { tenantId: "tenant-boot", traceId: "boot", producer: "control" }),
      withTransaction: (run) => client.$transaction(run),
    });
    try {
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
      const base = `http://127.0.0.1:${address.port}`;

      for (const item of cases) {
        const id = `cmd-${item.type.toLowerCase()}-finish-${stamp}`;
        const traceId = `control-finished:${id}`;
        created.push({ id, traceId });
        // 入队时刻比结单早 20 分钟，下发时刻早 19 分钟；两条时间戳都走真实状态机落库，
        // 否则 SQL 模式的 create 只会写默认版本，内存模式却照单全收，两套口径对不上。
        const createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
        const sentAt = new Date(Date.now() - 19 * 60_000).toISOString();
        expect(await commands.create({
          id,
          tenantId: TENANT,
          deviceId: "device-irri-smoke",
          plotCode: "511723-000001-01-00001-0000-5",
          operatorId: "user-admin",
          type: item.type,
          parameters: item.parameters,
          status: "QUEUED",
          origin: "MANUAL",
          reason: "作业完成事件冒烟",
          version: 1,
          createdAt,
        })).not.toBeNull();
        expect(await commands.transition(TENANT, { id, status: "SENT", at: sentAt, version: 1 })).toMatchObject({
          status: "SENT",
          version: 2,
          sentAt,
        });

        const response = await fetch(`${base}/api/v1/control/device/receipt`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant-id": TENANT },
          body: JSON.stringify({ commandId: id, status: "DONE", at: new Date().toISOString() }),
        });
        expect(response.status).toBe(200);
        expect(await commands.find(TENANT, id)).toMatchObject({ status: "DONE", version: 3 });

        const pending = (await store.listPending(500)).filter((record) => record.traceId === traceId);
        expect(pending).toHaveLength(1);
        const payload = pending[0]?.payload as { commandId: string; parcelId: string; durationMin: number } & Record<string, unknown>;
        expect(pending[0]).toMatchObject({ topic: item.topic, tenantId: TENANT, producer: "control" });
        expect(payload).toMatchObject({ commandId: id, parcelId: "511723-000001-01-00001-0000-5", durationSource: "RUNTIME" });
        // 用量与指令方案同一口径，时长由 sentAt 到结单时刻现算
        expect(payload[item.amountKey]).toBe(item.amount);
        expect(payload.durationMin).toBeGreaterThanOrEqual(18);
        expect(payload.durationMin).toBeLessThanOrEqual(21);

        // DONE 是终态，重复回执走幂等分支，不会再排一条事件
        await fetch(`${base}/api/v1/control/device/receipt`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant-id": TENANT },
          body: JSON.stringify({ commandId: id, status: "DONE", at: new Date().toISOString() }),
        });
        expect((await store.listPending(500)).filter((record) => record.traceId === traceId)).toHaveLength(1);
      }
    } finally {
      for (const { id, traceId } of created) {
        await client.$executeRawUnsafe("DELETE FROM control_outbox WHERE trace_id = $1", traceId);
        await client.$executeRawUnsafe("DELETE FROM control_commands WHERE id = $1", id);
      }
      await Promise.all(servers.splice(0).map((item) => new Promise<void>((resolve) => item.close(() => resolve()))));
      await client.$disconnect();
    }
  });
});
