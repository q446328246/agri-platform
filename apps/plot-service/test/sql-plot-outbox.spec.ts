import { describe, expect, it } from "vitest";

import { EventTopic } from "@agri/contracts";
import type { OutboxRecord } from "@agri/mq";

import { SqlPlotOutboxStore } from "../src/outbox.repository.js";

/**
 * 地块本地消息表（plot_outbox）的映射与事务约束回归测试。
 *
 * 建档事件与地块同事务落库，中继把待投递记录写入共享事件日志后被其他服务消费。
 * 关键约定：时间列必须映射为 ISO 字符串（否则写回 event_log 会报 timestamp 语法错误）、
 * enqueue 必须在事务中执行（脱离事务就等于绕过「同事务」保证）。
 */

const row = {
  id: "outbox-plot-1",
  topic: EventTopic.PlotCreated,
  payload_json: { parcelId: "p-1", parcelCode: "511723-000001-01-00001-0000-5", areaMu: 1.65 },
  tenant_id: "tenant-demo",
  trace_id: "trace-1",
  producer: "plot",
  created_at: new Date("2026-11-11T00:33:12.000Z"),
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

describe("地块服务本地消息表 plot_outbox", () => {
  it("listPending 把时间列映射为 ISO 字符串，可直接写回事件日志", async () => {
    const { client } = makeFake([row]);
    const store = new SqlPlotOutboxStore(client as never);
    const records: OutboxRecord[] = await store.listPending(10);
    expect(records).toHaveLength(1);
    expect(records[0]?.createdAt).toBe("2026-11-11T00:33:12.000Z");
    expect(records[0]?.publishedAt).toBeUndefined();
    expect(Number.isNaN(Date.parse(String(records[0]?.createdAt)))).toBe(false);
  });

  it("enqueue 必须携带事务客户端，脱离事务直接拒绝", async () => {
    const { client } = makeFake([]);
    const store = new SqlPlotOutboxStore(client as never);
    const record: OutboxRecord = {
      id: "outbox-plot-2",
      topic: EventTopic.PlotCreated,
      payload: { parcelCode: "x" },
      tenantId: "tenant-demo",
      traceId: "trace-2",
      producer: "plot",
      createdAt: "2026-11-11T00:00:00.000Z",
      retryCount: 0,
    };
    await expect(store.enqueue(undefined, record)).rejects.toThrow("必须在事务中执行");
  });

  it("enqueue 在事务上写入 plot_outbox，payload 以 jsonb 落库", async () => {
    const { client, queries } = makeFake([]);
    const store = new SqlPlotOutboxStore(client as never);
    const tx = { async $executeRawUnsafe(sql: string, ...params: unknown[]) { queries.push({ sql, params }); return 1; } };
    const record: OutboxRecord = {
      id: "outbox-plot-3",
      topic: EventTopic.PlotCreated,
      payload: { parcelCode: "511723-000001-01-00001-0000-5" },
      tenantId: "tenant-demo",
      traceId: "trace-3",
      producer: "plot",
      createdAt: "2026-11-11T00:00:00.000Z",
      retryCount: 0,
    };
    await store.enqueue(tx, record);
    expect(queries[0]?.sql).toContain("INSERT INTO plot_outbox");
    expect(queries[0]?.sql).toContain("$3::jsonb");
    expect(queries[0]?.params[2]).toBe(JSON.stringify(record.payload));
  });

  it("markPublished / markFailed 分别更新投递时间与重试次数", async () => {
    const { client, queries } = makeFake([]);
    const store = new SqlPlotOutboxStore(client as never);
    await store.markPublished("outbox-plot-1");
    await store.markFailed("outbox-plot-1", "网络超时");
    expect(queries[0]?.sql).toContain("UPDATE plot_outbox SET published_at = now()");
    expect(queries[1]?.sql).toContain("retry_count = retry_count + 1");
    expect(queries[1]?.params).toEqual(["outbox-plot-1", "网络超时"]);
  });
});
