import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import type { CommandTimeoutPayload } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createMessageEventConsumer } from "../src/consumer.js";
import { InMemoryMessageRepository } from "../src/message.repository.js";

/**
 * 指令超时事件 → 消息中心的消费闭环。
 *
 * 超时收口由 control-service 的定时任务写入 control_outbox，中继进共享 event_log 后
 * 由消息服务生成告警。这里用内存事件日志跑同一链路，验证「一条超时事件一条告警、
 * 同一指令的重复收口不刷屏、急停比普通作业更严重」。
 */

const TENANT = "tenant-demo";

function payload(overrides: Partial<CommandTimeoutPayload> = {}): CommandTimeoutPayload {
  return {
    commandId: "cmd-9",
    parcelId: "511723-000001-01-00001-0000-5",
    deviceId: "device-irri-001",
    commandType: "IRRIGATION",
    pendingMin: 23,
    timeoutMin: 15,
    failedAt: "2026-11-12T02:23:00.000Z",
    ...overrides,
  };
}

function makeClosure() {
  const store = new InMemoryEventLogStore();
  const messages = new InMemoryMessageRepository();
  const publisher = new EventLogPublisher(store, { tenantId: TENANT, traceId: "control-relay", producer: "control" });
  const { consumer } = createMessageEventConsumer(messages, store, { pollIntervalMs: 20 });
  return { publisher, messages, consumer };
}

describe("指令超时事件驱动消息中心", () => {
  it("消费 ControlCommandTimeout 生成告警，等待与阈值都取自事件载荷", async () => {
    const { publisher, messages, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlCommandTimeout, payload());

    expect(await consumer.pollOnce()).toBe(1);
    const rows = messages.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: TENANT, type: "ALERT", level: "WARNING", plotCode: "511723-000001-01-00001-0000-5" });
    expect(rows[0]?.title).toBe("指令超时未回执：511723-000001-01-00001-0000-5 灌溉");
    expect(rows[0]?.content).toContain("已等待 23 分钟");
    expect(rows[0]?.content).toContain("超过 15 分钟未收到回执");
    expect(rows[0]?.createdAt).toBe("2026-11-12T02:23:00.000Z");

    // 位点已提交：再次轮询不重复生成消息
    expect(await consumer.pollOnce()).toBe(0);
    expect(messages.all()).toHaveLength(1);
  });

  it("同一指令被重复收口时按指令聚合，只留一条告警", async () => {
    const { publisher, messages, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlCommandTimeout, payload({ pendingMin: 23 }));
    expect(await consumer.pollOnce()).toBe(1);
    // 中继重试或收口任务重跑会换事件标识，但指令还是那条指令
    await publisher.publish(EventTopic.ControlCommandTimeout, payload({ pendingMin: 84 }));
    expect(await consumer.pollOnce()).toBe(1);

    expect(messages.all()).toHaveLength(1);
  });

  it("急停指令的超时按 CRITICAL，普通作业按 WARNING", async () => {
    const { publisher, messages, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlCommandTimeout, payload({ commandId: "cmd-estop", commandType: "ESTOP", parcelId: "" }));
    await publisher.publish(EventTopic.ControlCommandTimeout, payload({ commandId: "cmd-weed", commandType: "WEEDING" }));
    expect(await consumer.pollOnce()).toBe(2);

    const rows = messages.all();
    const estop = rows.find((row) => row.title.includes("急停"));
    expect(estop?.level).toBe("CRITICAL");
    expect(estop?.title).toBe("指令超时未回执：未绑定地块 急停");
    expect(estop?.plotCode).toBe("");
    expect(rows.find((row) => row.title.includes("除草"))?.level).toBe("WARNING");
  });
});
