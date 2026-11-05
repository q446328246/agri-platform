import { describe, expect, it } from "vitest";

import {
  buildMessageDraft,
  EventTopic,
  isMessageTemplateTopic,
  MESSAGE_LEVEL_RANK,
  MESSAGE_TEMPLATE_TOPICS,
} from "../src/index.js";

/**
 * 消息模板属于平台契约：标题、级别与去重键被前端、消费侧与冒烟共同依赖，
 * 因此用测试固定文案关键片段与去重窗口，防止无意的行为漂移。
 */

const context = { eventId: "evt-1", occurredAt: "2026-11-05T01:30:00.000Z" };

describe("消息模板与去重键", () => {
  it("越限事件渲染告警并在一小时内聚合", () => {
    const first = buildMessageDraft(
      EventTopic.TelemetryThresholdBreached,
      { parcelId: "P-1", metric: "soilMoisture", value: 18, threshold: 30, direction: "below", occurredAt: "2026-11-05T01:00:00.000Z" },
      context,
    );
    expect(first).toMatchObject({ type: "ALERT", level: "WARNING", plotCode: "P-1" });
    expect(first?.title).toBe("土壤含水率越限：P-1");
    expect(first?.content).toContain("低于下限阈值 30");

    const sameHour = buildMessageDraft(
      EventTopic.TelemetryThresholdBreached,
      { parcelId: "P-1", metric: "soilMoisture", value: 17, threshold: 30, direction: "below", occurredAt: "2026-11-05T01:45:00.000Z" },
      context,
    );
    expect(sameHour?.dedupeKey).toBe(first?.dedupeKey);

    const nextHour = buildMessageDraft(
      EventTopic.TelemetryThresholdBreached,
      { parcelId: "P-1", metric: "soilMoisture", value: 17, threshold: 30, direction: "below", occurredAt: "2026-11-05T02:01:00.000Z" },
      context,
    );
    expect(nextHour?.dedupeKey).not.toBe(first?.dedupeKey);
  });

  it("风速越限按严重级别处理", () => {
    const draft = buildMessageDraft(
      EventTopic.TelemetryThresholdBreached,
      { parcelId: "P-2", metric: "windSpeed", value: 12, threshold: 10, direction: "above", occurredAt: "2026-11-05T02:00:00.000Z" },
      context,
    );
    expect(draft?.level).toBe("CRITICAL");
    expect(draft?.content).toContain("高于上限");
  });

  it("处方通知按来源事件去重，每份处方都要通知", () => {
    const payload = {
      parcelId: "P-3",
      seasonId: "2026",
      planType: "fertilization" as const,
      items: [{ materialCode: "urea", dosage: 12, windowStart: "2026-11-05T02:00:00.000Z", windowEnd: "2026-11-05T06:00:00.000Z" }],
    };
    const first = buildMessageDraft(EventTopic.DecisionPrescriptionIssued, payload, { eventId: "evt-a", occurredAt: context.occurredAt });
    const second = buildMessageDraft(EventTopic.DecisionPrescriptionIssued, payload, { eventId: "evt-b", occurredAt: context.occurredAt });
    expect(first?.title).toBe("施肥处方已生成：P-3");
    expect(first?.content).toContain("1 项作业建议");
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey);
  });

  it("未登记模板的主题不生成消息，级别权重可比较", () => {
    expect(buildMessageDraft(EventTopic.OperationTaskCompleted, {}, context)).toBeNull();
    expect(isMessageTemplateTopic(EventTopic.TelemetryThresholdBreached)).toBe(true);
    expect(isMessageTemplateTopic("unknown.topic.value")).toBe(false);
    expect(MESSAGE_TEMPLATE_TOPICS).toEqual([EventTopic.TelemetryThresholdBreached, EventTopic.DecisionPrescriptionIssued]);
    expect(MESSAGE_LEVEL_RANK.CRITICAL).toBeGreaterThan(MESSAGE_LEVEL_RANK.WARNING);
  });
});
