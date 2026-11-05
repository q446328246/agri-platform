import "reflect-metadata";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventLogPublisher, InMemoryEventLogStore } from "@agri/mq";
import { describe, expect, it } from "vitest";

import { createDecisionHttpServer } from "../../decision-service/src/http.js";
import { InMemoryOutcomeRepository } from "../../decision-service/src/outcome.repository.js";
import { InMemoryPrescriptionRepository } from "../../decision-service/src/prescription.repository.js";
import { InMemoryRuleRepository } from "../../decision-service/src/rule.repository.js";
import { createTelemetryHttpServer } from "../../telemetry-service/src/http.js";
import { createMessageEventConsumer } from "../src/consumer.js";
import { createMessageHttpServer } from "../src/http.js";
import { InMemoryMessageRepository } from "../src/message.repository.js";

/**
 * 事件闭环联调测试。
 *
 * 与 scripts/smoke-events.mjs 覆盖同一条链路（遥测越限 / 处方生成 → 事件日志
 * → 消息中心 → 效果回流调优），区别是不依赖 PostgreSQL：三个服务在本进程内
 * 启动真实 HTTP 端口，共享同一个内存事件日志，因此可以放进常规测试基线。
 */

const PLOT = "P-CLOSURE-0001";
const TENANT = "tenant-demo";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function call(base: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json", "x-tenant-id": TENANT },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

describe("事件闭环：遥测越限与处方下发驱动消息中心，效果回流调优规则", () => {
  it("一次完整闭环：两条事件生成两条消息，评估建议写回规则阈值", async () => {
    const store = new InMemoryEventLogStore();
    const messages = new InMemoryMessageRepository();
    const rules = new InMemoryRuleRepository();
    const prescriptions = new InMemoryPrescriptionRepository();
    const outcomes = new InMemoryOutcomeRepository();

    const telemetry = createTelemetryHttpServer({
      publisher: new EventLogPublisher(store, { tenantId: TENANT, traceId: "telemetry", producer: "telemetry" }),
      publishEvents: true,
      tenantId: TENANT,
    });
    const decision = createDecisionHttpServer({
      rules,
      prescriptions,
      outcomes,
      publisher: new EventLogPublisher(store, { tenantId: TENANT, traceId: "decision", producer: "decision" }),
      tenantId: TENANT,
    });
    const { consumer } = createMessageEventConsumer(messages, store, { pollIntervalMs: 20 });
    const messageServer = createMessageHttpServer({ messages, tenantId: TENANT });

    const telemetryBase = await listen(telemetry);
    const decisionBase = await listen(decision);
    const messageBase = await listen(messageServer);
    try {
      // 1. 遥测越限：含水率 18 低于阈值 30，落告警并发布越限事件
      const reported = await call(telemetryBase, "POST", "/api/v1/telemetry/report", {
        deviceId: "device-closure-1",
        plotCode: PLOT,
        metric: "soilMoisture",
        value: 18,
        unit: "%",
        recordedAt: "2026-11-05T01:00:00.000Z",
      });
      expect(reported.status).toBe(201);
      expect(reported.body.data.alert).not.toBeNull();

      // 2. 处方生成：命中默认规则并发布处方事件
      const issued = await call(decisionBase, "POST", "/api/v1/decision/prescriptions", {
        plotCode: PLOT,
        plotName: "闭环验证地块",
        soilMoisture: 20,
        rainProbability: 10,
      });
      expect(issued.status).toBe(201);
      expect(issued.body.data.status).toBe("RECOMMENDED");
      expect(issued.body.data.actions).toHaveLength(1);

      // 3. 消息中心从同一事件日志读到两条事件，各生成一条消息
      expect(await consumer.pollOnce()).toBe(2);
      const rows = messages.all();
      expect(rows).toHaveLength(2);

      const alert = rows.find((row) => row.type === "ALERT");
      expect(alert?.level).toBe("WARNING");
      expect(alert?.title).toContain("土壤含水率越限");
      expect(alert?.plotCode).toBe(PLOT);

      const notice = rows.find((row) => row.type === "NOTICE");
      expect(notice?.title).toContain("灌溉处方已生成");
      expect(notice?.plotCode).toBe(PLOT);

      // 4. 位点已提交：再次轮询不重复生成消息
      expect(await consumer.pollOnce()).toBe(0);
      expect(messages.all()).toHaveLength(2);

      // 5. 消息接口与角标计数对事件消息同样生效
      const list = await call(messageBase, "GET", `/api/v1/messages?plotCode=${PLOT}`);
      expect(list.body.data.total).toBe(2);
      expect(await call(messageBase, "GET", "/api/v1/messages/unread-count")).toMatchObject({ body: { data: { unread: 2 } } });
      const firstId = list.body.data.items[0].id as string;
      expect((await call(messageBase, "POST", `/api/v1/messages/${firstId}/read`)).status).toBe(200);
      expect(await call(messageBase, "GET", "/api/v1/messages/unread-count")).toMatchObject({ body: { data: { unread: 1 } } });

      // 6. 效果回流：复测几乎无回升，给出提高阈值的建议（30 → 35）
      const evaluated = await call(decisionBase, "POST", `/api/v1/decision/prescriptions/${issued.body.data.id as string}/outcome`, {
        soilMoistureAfter: 21,
        note: "闭环联调复测",
      });
      expect(evaluated.status).toBe(201);
      expect(evaluated.body.data.outcome.effective).toBe(false);
      expect(evaluated.body.data.outcome.suggestion.suggestedThreshold).toBe(35);

      // 7. 建议写回规则：阈值热更新后条件表达式同步刷新
      const applied = await call(decisionBase, "POST", `/api/v1/decision/prescriptions/${issued.body.data.id as string}/outcome`, {
        soilMoistureAfter: 21,
        applySuggestion: true,
      });
      expect(applied.body.data.outcome.applied).toBe(true);
      const tuned = await call(decisionBase, "GET", `/api/v1/decision/rules/${evaluated.body.data.outcome.ruleId as string}`);
      expect(tuned.body.data.condition.soilMoistureBelow).toBe(35);
      expect(tuned.body.data.expression).toContain("soilMoisture < 35");

      // 8. 评估留痕可回读，形成可追溯闭环
      const latest = await call(decisionBase, "GET", `/api/v1/decision/prescriptions/${issued.body.data.id as string}/outcome`);
      expect(latest.body.data.applied).toBe(true);
      expect(latest.body.data.soilMoistureAfter).toBe(21);
    } finally {
      await Promise.all([close(telemetry), close(decision), close(messageServer)]);
    }
  });
});
