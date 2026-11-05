import { describe, expect, it } from "vitest";

import type { OutboxRecord } from "@agri/mq";

import { SqlOutboxStore } from "../src/outbox.repository.js";

/**
 * 本地消息表时间字段映射的回归测试。
 *
 * pg 驱动把 TIMESTAMPTZ 解析为 Date，早期实现用 String(row.created_at) 映射，
 * 中继把该值写回事件日志时 Postgres 报 `invalid input syntax for type timestamp`，
 * 事件永远送不出去。这里用一个假的客户端固定住「必须是 ISO 字符串」的约定。
 */

const row = {
  id: "outbox-1",
  topic: "decision.prescription.issued",
  payload_json: { parcelId: "P-1", planType: "irrigation", items: [] },
  tenant_id: "tenant-demo",
  trace_id: "trace-1",
  producer: "decision",
  created_at: new Date("2026-11-05T00:33:12.000Z"),
  published_at: new Date("2026-11-05T00:33:15.000Z"),
  retry_count: 0,
  last_error: null,
};

function fakeClient(rows: Array<Record<string, unknown>>): { $queryRawUnsafe: () => Promise<Array<Record<string, unknown>>>; $executeRawUnsafe: () => Promise<number> } {
  return {
    async $queryRawUnsafe() {
      return rows;
    },
    async $executeRawUnsafe() {
      return 1;
    },
  };
}

describe("决策服务本地消息表", () => {
  it("时间列映射为 ISO 字符串，可直接写回事件日志", async () => {
    const store = new SqlOutboxStore(fakeClient([row]) as never);
    const records: OutboxRecord[] = await store.listPending(10);
    expect(records).toHaveLength(1);
    expect(records[0]?.createdAt).toBe("2026-11-05T00:33:12.000Z");
    expect(records[0]?.publishedAt).toBe("2026-11-05T00:33:15.000Z");
    // 中继按 createdAt 还原事件信封，必须能被 Date 正确解析
    expect(Number.isNaN(Date.parse(String(records[0]?.createdAt)))).toBe(false);
  });
});
