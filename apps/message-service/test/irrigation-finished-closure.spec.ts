import "reflect-metadata";

import { EventTopic } from "@agri/contracts";
import type { IrrigationFinishedPayload } from "@agri/contracts";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createMessageEventConsumer } from "../src/consumer.js";
import { InMemoryMessageRepository } from "../src/message.repository.js";
import { InMemoryMessagePreferenceRepository } from "../src/preference.repository.js";

/**
 * 灌溉结单事件 → 消息中心的消费闭环。
 *
 * DONE 回执由 control-service 写入 control_outbox，中继进共享 event_log 后由消息服务生成通知。
 * 这里验证三件事：结单一条通知、同一指令的重复投递不刷屏、文案把「设备实测」与「方案推算」
 * 分开——把估算写成实测，现场就会照着假数字算水费。
 */

const TENANT = "tenant-demo";

function payload(overrides: Partial<IrrigationFinishedPayload> = {}): IrrigationFinishedPayload {
  return {
    commandId: "cmd-irri-1",
    parcelId: "511723-000001-01-00001-0000-5",
    deviceId: "device-irri-001",
    waterVolume: 133.33,
    waterVolumeSource: "PLAN",
    durationMin: 40,
    durationSource: "RUNTIME",
    finishedAt: "2026-11-12T02:00:00.000Z",
    ...overrides,
  };
}

function makeClosure(preferences = new InMemoryMessagePreferenceRepository()) {
  const store = new InMemoryEventLogStore();
  const messages = new InMemoryMessageRepository();
  const publisher = new EventLogPublisher(store, { tenantId: TENANT, traceId: "control-relay", producer: "control" });
  const { consumer } = createMessageEventConsumer(messages, store, { pollIntervalMs: 20, preferences });
  return { store, messages, publisher, preferences, consumer };
}

describe("灌溉完成事件驱动消息中心", () => {
  it("消费 ControlIrrigationFinished 生成通知，数值与来源都来自事件载荷", async () => {
    const { messages, publisher, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlIrrigationFinished, payload());

    expect(await consumer.pollOnce()).toBe(1);
    const rows = messages.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: TENANT, type: "NOTICE", level: "INFO", plotCode: "511723-000001-01-00001-0000-5" });
    expect(rows[0]?.title).toBe("灌溉执行完成：511723-000001-01-00001-0000-5");
    expect(rows[0]?.content).toContain("设备 device-irri-001");
    expect(rows[0]?.content).toContain("用水 133.33 立方米（按分区方案推算）");
    expect(rows[0]?.content).toContain("历时 40 分钟（按回执时间推算）");
    expect(rows[0]?.createdAt).toBe("2026-11-12T02:00:00.000Z");

    // 位点已提交：再次轮询不重复生成消息
    expect(await consumer.pollOnce()).toBe(0);
    expect(messages.all()).toHaveLength(1);
  });

  it("设备实测与方案推算的文案分开", async () => {
    const { messages, publisher, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlIrrigationFinished, payload({ commandId: "cmd-2", waterVolumeSource: "DEVICE", durationSource: "DEVICE" }));
    expect(await consumer.pollOnce()).toBe(1);
    expect(messages.all()[0]?.content).toContain("用水 133.33 立方米（设备实测）");
    expect(messages.all()[0]?.content).toContain("历时 40 分钟（设备实测）");
  });

  it("设备没报用水量时直说未上报，不编一个数", async () => {
    const { messages, publisher, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlIrrigationFinished, {
      commandId: "cmd-3", parcelId: "", deviceId: "device-irri-002", durationMin: 12, durationSource: "RUNTIME", finishedAt: "2026-11-12T03:00:00.000Z",
    });
    expect(await consumer.pollOnce()).toBe(1);

    const row = messages.all()[0];
    expect(row?.title).toBe("灌溉执行完成：未绑定地块");
    expect(row?.plotCode).toBe("");
    expect(row?.content).toContain("用水量未上报");
    expect(row?.content).not.toContain("立方米");
  });

  it("同一指令重复投递按指令聚合，只留一条通知", async () => {
    const { messages, publisher, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlIrrigationFinished, payload());
    expect(await consumer.pollOnce()).toBe(1);
    // 中继重试会换事件标识，但结的还是同一条指令的单
    await publisher.publish(EventTopic.ControlIrrigationFinished, payload({ durationMin: 41 }));
    expect(await consumer.pollOnce()).toBe(1);

    expect(messages.all()).toHaveLength(1);
  });

  it("换指令另开一条；关闭订阅后不再落库", async () => {
    const { messages, publisher, preferences, consumer } = makeClosure();

    await publisher.publish(EventTopic.ControlIrrigationFinished, payload({ commandId: "cmd-a" }));
    expect(await consumer.pollOnce()).toBe(1);
    await publisher.publish(EventTopic.ControlIrrigationFinished, payload({ commandId: "cmd-b" }));
    expect(await consumer.pollOnce()).toBe(1);
    expect(messages.all()).toHaveLength(2);

    await preferences.upsert({ tenantId: TENANT, topic: EventTopic.ControlIrrigationFinished, enabled: false, minLevel: "INFO", updatedAt: "" });
    await publisher.publish(EventTopic.ControlIrrigationFinished, payload({ commandId: "cmd-c" }));
    expect(await consumer.pollOnce()).toBe(1);
    expect(messages.all()).toHaveLength(2);
  });
});
