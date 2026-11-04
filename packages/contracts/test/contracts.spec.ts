import { describe, expect, it } from "vitest";

import {
  API_PREFIX,
  ErrorCode,
  EventTopic,
  EVENT_TOPIC_VALUES,
  HEADER_REQUEST_ID,
  HEADER_TENANT_ID,
  PAGE_DEFAULT_SIZE,
  PAGE_MAX_SIZE,
  pageQuerySchema,
  PlotStatus,
  TelemetryMetric,
} from "../src/index.js";

/**
 * 契约包是全平台接口真相来源，测试重点在于「稳定性」：
 * 主题名、错误码取值一经发布不得漂移，分页上限不得被随意放宽。
 */
describe("接口契约", () => {
  it("事件主题唯一且以生产者服务名为前缀", () => {
    expect(EVENT_TOPIC_VALUES).toHaveLength(Object.keys(EventTopic).length);
    expect(new Set(EVENT_TOPIC_VALUES).size).toBe(EVENT_TOPIC_VALUES.length);
    for (const topic of EVENT_TOPIC_VALUES) {
      expect(topic.split(".")).toHaveLength(3);
    }
    expect(EventTopic.PlotCreated).toBe("plot.plot.created");
  });

  it("错误码格式统一且不重复", () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
    expect(ErrorCode.OK).toBe("OK");
    for (const value of values.filter((item) => item !== "OK")) {
      expect(value).toMatch(/^[A-Z]+-\d{3}-\d{3}$/);
    }
  });

  it("分页参数按默认值补齐并拒绝超过上限的取值", () => {
    const parsed = pageQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.size).toBe(PAGE_DEFAULT_SIZE);
    expect(PAGE_MAX_SIZE).toBe(200);
    expect(pageQuerySchema.safeParse({ size: PAGE_MAX_SIZE + 1 }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ order: "random" }).success).toBe(false);
  });

  it("枚举取值稳定，前端标签映射不受影响", () => {
    expect(PlotStatus.Normal).toBe(1);
    expect(PlotStatus.Closed).toBe(4);
    expect(TelemetryMetric.SoilMoisture).toBe("soil.moisture");
  });

  it("路由前缀与透传请求头固定", () => {
    expect(API_PREFIX).toBe("/api/v1");
    expect(HEADER_REQUEST_ID).toBe("x-request-id");
    expect(HEADER_TENANT_ID).toBe("x-tenant-id");
  });
});
