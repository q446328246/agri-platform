import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createMessageEventConsumer } from "../src/consumer.js";
import { InMemoryMessageRepository } from "../src/message.repository.js";

/**
 * 地块建档事件 → 消息中心的消费闭环。
 *
 * 建档事件由 plot_outbox 中继进共享 event_log，消息服务作为跨进程消费方读取并生成通知。
 * 本测试不依赖 PostgreSQL：生产者与消费者共享同一内存事件日志，验证「一条建档事件生成一条
 * 通知、位点提交后重投不重复」这一契约。
 */

const TENANT = "tenant-demo";

describe("地块建档事件驱动消息中心", () => {
  it("消费 PlotCreated 生成一条建档通知，位点提交后重投不重复", async () => {
    const store = new InMemoryEventLogStore();
    const messages = new InMemoryMessageRepository();
    const publisher = new EventLogPublisher(store, { tenantId: TENANT, traceId: "plot-relay", producer: "plot" });
    const { consumer } = createMessageEventConsumer(messages, store, { pollIntervalMs: 20 });

    await publisher.publish(EventTopic.PlotCreated, {
      parcelId: "p-1",
      parcelCode: "511723-000001-01-00001-0000-5",
      parcelName: "开江县任市镇示范田一号地块",
      tenantId: TENANT,
      farmId: "farm-kaijiang-01",
      areaMu: 1.65,
      soilType: "PADDY_SOIL",
      geom: { type: "Polygon", coordinates: [], srid: 4490 },
    });

    expect(await consumer.pollOnce()).toBe(1);
    const rows = messages.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      type: "NOTICE",
      level: "INFO",
      plotCode: "511723-000001-01-00001-0000-5",
    });
    expect(rows[0]?.title).toBe("新地块已建档：511723-000001-01-00001-0000-5");
    expect(rows[0]?.content).toContain("水稻土");
    expect(rows[0]?.sourceEventId).toBeTruthy();

    // 位点已提交：再次轮询不重复生成消息
    expect(await consumer.pollOnce()).toBe(0);
    expect(messages.all()).toHaveLength(1);
  });
});
