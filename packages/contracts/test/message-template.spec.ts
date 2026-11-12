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

  it("虫情识别按等级生成告警与消息", () => {
    const severe = buildMessageDraft(
      EventTopic.TelemetryPestDetected,
      { parcelId: "P-4", pestType: "稻飞虱", level: 3, confidence: 0.92, imageFileId: "file-1", detectedAt: "2026-11-05T01:10:00.000Z" },
      context,
    );
    expect(severe).toMatchObject({ type: "ALERT", level: "CRITICAL", plotCode: "P-4" });
    expect(severe?.title).toBe("虫情识别：P-4 严重");
    expect(severe?.content).toContain("稻飞虱");
    expect(severe?.content).toContain("92.0%");
    expect(severe?.content).toContain("file-1");

    const slight = buildMessageDraft(
      EventTopic.TelemetryPestDetected,
      { parcelId: "P-4", pestType: "稻飞虱", level: 1, confidence: 0.6, detectedAt: "2026-11-05T01:20:00.000Z" },
      context,
    );
    expect(slight).toMatchObject({ type: "NOTICE", level: "INFO" });
    // 同一小时、同一类型、同一等级的识别结果只保留一条通知
    expect(slight?.dedupeKey).not.toBe(severe?.dedupeKey);
  });

  it("地块建档生成通知，按来源事件去重", () => {
    const payload = {
      parcelId: "P-5", parcelCode: "511723-000001-01-00001-0000-5", parcelName: "示范田一号", tenantId: "tenant-demo",
      farmId: "farm-kaijiang-01", areaMu: 1.65, soilType: "PADDY_SOIL", geom: { type: "Polygon", coordinates: [], srid: 4490 },
    };
    const first = buildMessageDraft(EventTopic.PlotCreated, payload, { eventId: "evt-p1", occurredAt: context.occurredAt });
    expect(first).toMatchObject({ type: "NOTICE", level: "INFO", plotCode: "511723-000001-01-00001-0000-5" });
    expect(first?.title).toBe("新地块已建档：511723-000001-01-00001-0000-5");
    expect(first?.content).toContain("示范田一号");
    expect(first?.content).toContain("1.65 亩");
    expect(first?.content).toContain("水稻土");
    // 建档事件按来源事件唯一，两次不同事件各通知一次
    const second = buildMessageDraft(EventTopic.PlotCreated, payload, { eventId: "evt-p2", occurredAt: context.occurredAt });
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey);
    // 缺省土壤类型回落为「未登记」
    const noSoil = buildMessageDraft(EventTopic.PlotCreated, { ...payload, soilType: undefined }, context);
    expect(noSoil?.content).toContain("未登记");
  });

  it("指令超时按指令唯一收口，急停级别更高", () => {
    const payload = {
      commandId: "cmd-7", parcelId: "P-6", deviceId: "device-irri-001", commandType: "IRRIGATION" as const,
      pendingMin: 23, timeoutMin: 15, failedAt: "2026-11-05T01:40:00.000Z",
    };
    const draft = buildMessageDraft(EventTopic.ControlCommandTimeout, payload, context);
    expect(draft).toMatchObject({ type: "ALERT", level: "WARNING", plotCode: "P-6" });
    expect(draft?.title).toBe("指令超时未回执：P-6 灌溉");
    expect(draft?.content).toContain("设备 device-irri-001");
    expect(draft?.content).toContain("已等待 23 分钟");
    expect(draft?.content).toContain("超过 15 分钟");
    expect(draft?.occurredAt).toBe("2026-11-05T01:40:00.000Z");

    // 同一条指令的重复收口只提醒一次；换指令才另开一条
    const again = buildMessageDraft(EventTopic.ControlCommandTimeout, payload, { eventId: "evt-other", occurredAt: context.occurredAt });
    expect(again?.dedupeKey).toBe(draft?.dedupeKey);
    const estop = buildMessageDraft(EventTopic.ControlCommandTimeout, { ...payload, commandId: "cmd-8", commandType: "ESTOP" }, context);
    expect(estop?.level).toBe("CRITICAL");
    expect(estop?.title).toBe("指令超时未回执：P-6 急停");
    expect(estop?.dedupeKey).not.toBe(draft?.dedupeKey);
  });

  it("灌溉完成按指令结一笔账，用水量与时长都标来源", () => {
    const payload = {
      commandId: "cmd-9", parcelId: "P-7", deviceId: "device-irri-002",
      waterVolume: 48.5, waterVolumeSource: "DEVICE" as const,
      durationMin: 12, durationSource: "DEVICE" as const,
      finishedAt: "2026-11-05T02:00:00.000Z",
    };
    const draft = buildMessageDraft(EventTopic.ControlIrrigationFinished, payload, context);
    expect(draft).toMatchObject({ type: "NOTICE", level: "INFO", plotCode: "P-7" });
    expect(draft?.title).toBe("灌溉执行完成：P-7");
    expect(draft?.content).toContain("用水 48.5 立方米（设备实测）");
    expect(draft?.content).toContain("历时 12 分钟（设备实测）");
    expect(draft?.occurredAt).toBe("2026-11-05T02:00:00.000Z");

    // 设备没报量时只说「按分区方案推算」，不把它写成实测
    const estimated = buildMessageDraft(EventTopic.ControlIrrigationFinished, {
      ...payload, commandId: "cmd-10", waterVolume: 30, waterVolumeSource: "PLAN", durationSource: "RUNTIME",
    }, context);
    expect(estimated?.content).toContain("用水 30 立方米（按分区方案推算）");
    expect(estimated?.content).toContain("历时 12 分钟（按回执时间推算）");
    // 用水量完全无从得出时明说未上报，不留空也不编数
    const unmeasured = buildMessageDraft(EventTopic.ControlIrrigationFinished, {
      ...payload, commandId: "cmd-11", waterVolume: undefined, waterVolumeSource: undefined,
    }, context);
    expect(unmeasured?.content).toContain("用水量未上报");

    // 同一条指令只结一次账，换指令才另开一条
    const again = buildMessageDraft(EventTopic.ControlIrrigationFinished, payload, { eventId: "evt-irri-2", occurredAt: context.occurredAt });
    expect(again?.dedupeKey).toBe(draft?.dedupeKey);
    expect(again?.dedupeKey).not.toBe(estimated?.dedupeKey);
  });

  it("施肥完成按指令结一笔肥账，投肥量与时长都标来源", () => {
    const payload = {
      commandId: "cmd-12", parcelId: "P-7", deviceId: "device-irri-002",
      fertilizerKg: 96, fertilizerSource: "DEVICE" as const,
      durationMin: 14, durationSource: "DEVICE" as const,
      finishedAt: "2026-11-05T03:00:00.000Z",
    };
    const draft = buildMessageDraft(EventTopic.ControlFertilizationFinished, payload, context);
    expect(draft).toMatchObject({ type: "NOTICE", level: "INFO", plotCode: "P-7" });
    expect(draft?.title).toBe("施肥执行完成：P-7");
    expect(draft?.content).toContain("施氮磷钾合计 96 千克（设备实测）");
    expect(draft?.content).toContain("历时 14 分钟（设备实测）");
    expect(draft?.occurredAt).toBe("2026-11-05T03:00:00.000Z");

    // 配方推算说推算依据，完全不落空也不写「实测」
    const estimated = buildMessageDraft(EventTopic.ControlFertilizationFinished, {
      ...payload, commandId: "cmd-13", fertilizerKg: 150, fertilizerSource: "PLAN", durationSource: "RUNTIME",
    }, context);
    expect(estimated?.content).toContain("施氮磷钾合计 150 千克（按配方与面积推算）");
    expect(estimated?.content).toContain("历时 14 分钟（按回执时间推算）");
    const unmeasured = buildMessageDraft(EventTopic.ControlFertilizationFinished, {
      ...payload, commandId: "cmd-14", fertilizerKg: undefined, fertilizerSource: undefined,
    }, context);
    expect(unmeasured?.content).toContain("施肥量未上报");

    // 去重键带主题：同一指令号在灌溉与施肥两条主题下各自结一次账
    const irrigation = buildMessageDraft(EventTopic.ControlIrrigationFinished, {
      commandId: "cmd-12", parcelId: "P-7", deviceId: "device-irri-002", durationMin: 14, durationSource: "RUNTIME", finishedAt: payload.finishedAt,
    }, context);
    expect(irrigation?.dedupeKey).not.toBe(draft?.dedupeKey);
    const again = buildMessageDraft(EventTopic.ControlFertilizationFinished, payload, { eventId: "evt-fert-2", occurredAt: context.occurredAt });
    expect(again?.dedupeKey).toBe(draft?.dedupeKey);
  });

  it("未登记模板的主题不生成消息，级别权重可比较", () => {
    expect(buildMessageDraft(EventTopic.OperationTaskCompleted, {}, context)).toBeNull();
    expect(isMessageTemplateTopic(EventTopic.TelemetryThresholdBreached)).toBe(true);
    expect(isMessageTemplateTopic("unknown.topic.value")).toBe(false);
    expect(MESSAGE_TEMPLATE_TOPICS).toEqual([
      EventTopic.TelemetryThresholdBreached,
      EventTopic.TelemetryPestDetected,
      EventTopic.DecisionPrescriptionIssued,
      EventTopic.PlotCreated,
      EventTopic.ControlCommandTimeout,
      EventTopic.ControlIrrigationFinished,
      EventTopic.ControlFertilizationFinished,
    ]);
    expect(MESSAGE_LEVEL_RANK.CRITICAL).toBeGreaterThan(MESSAGE_LEVEL_RANK.WARNING);
  });
});
