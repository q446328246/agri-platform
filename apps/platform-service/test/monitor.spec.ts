import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { ServiceDownPayload, ServiceRecoveredPayload } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";

import { createPlatformHttpServer } from "../src/http.js";
import { InMemoryMonitorRepository, seedMonitorRules } from "../src/monitor.repository.js";
import type { MonitorAlert, ServiceStatus } from "../src/monitor.repository.js";
import { createMonitorEngine } from "../src/monitor.js";
import type { MonitorTarget } from "../src/monitor.js";

const servers: Server[] = [];

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

interface CapturedEvent { topic: string; payload: ServiceDownPayload | ServiceRecoveredPayload }

function controllableTarget(target: string, kind: MonitorTarget["kind"], label: string): { target: MonitorTarget; setUp: (up: boolean) => void } {
  let up = true;
  return {
    target: { target, kind, label, probe: async (): Promise<void> => { if (!up) throw new Error("connect ECONNREFUSED"); } },
    setUp: (next: boolean): void => { up = next; },
  };
}

describe("运维巡检引擎", () => {
  it("连续失败达到阈值才告警，在报期间不重复触发，恢复后撤销并发恢复事件", async () => {
    const repository = new InMemoryMonitorRepository({ rules: seedMonitorRules() });
    const demo = controllableTarget("demo", "SERVICE", "演示服务");
    const events: CapturedEvent[] = [];
    const engine = createMonitorEngine({
      repository,
      targets: [demo.target],
      publish: async (topic, payload): Promise<void> => { events.push({ topic, payload }); },
    });

    await engine.checkNow();
    let statuses = await repository.listStatus();
    expect(statuses[0]).toMatchObject({ target: "demo", status: "UP", consecutiveFailures: 0 });

    demo.setUp(false);
    await engine.checkNow();
    await engine.checkNow();
    expect((await repository.pageAlerts({ page: 1, size: 10 })).total).toBe(0);
    statuses = await repository.listStatus();
    expect(statuses[0]).toMatchObject({ status: "DOWN", consecutiveFailures: 2 });

    // 服务规则连续 3 轮：第三轮触发 CRITICAL 告警与 down 事件
    await engine.checkNow();
    const firing = await repository.pageAlerts({ page: 1, size: 10, status: "FIRING" });
    expect(firing.total).toBe(1);
    expect(firing.items[0]).toMatchObject({ target: "demo", kind: "SERVICE_DOWN", level: "CRITICAL" });
    expect(events.filter((event) => event.topic === EventTopic.PlatformServiceDown)).toHaveLength(1);

    // 第四轮仍失败：在报期间不重复触发
    await engine.checkNow();
    expect((await repository.pageAlerts({ page: 1, size: 10, status: "FIRING" })).total).toBe(1);
    expect(events.filter((event) => event.topic === EventTopic.PlatformServiceDown)).toHaveLength(1);

    demo.setUp(true);
    await engine.checkNow();
    statuses = await repository.listStatus();
    expect(statuses[0]).toMatchObject({ status: "UP", consecutiveFailures: 0 });
    expect((await repository.pageAlerts({ page: 1, size: 10, status: "FIRING" })).total).toBe(0);
    const resolved = await repository.pageAlerts({ page: 1, size: 10, status: "RESOLVED" });
    expect(resolved.total).toBe(1);
    expect(resolved.items[0]?.resolvedAt).toBeTruthy();
    const recovered = events.filter((event) => event.topic === EventTopic.PlatformServiceRecovered);
    expect(recovered).toHaveLength(1);
    expect((recovered[0]?.payload as ServiceRecoveredPayload).target).toBe("demo");
    expect((recovered[0]?.payload as ServiceRecoveredPayload).downtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("基础设施按自己的阈值判定：连续 2 轮失败即告警", async () => {
    const repository = new InMemoryMonitorRepository({ rules: seedMonitorRules() });
    const infra = controllableTarget("postgres", "INFRA", "PostgreSQL 数据库");
    const events: CapturedEvent[] = [];
    const engine = createMonitorEngine({
      repository,
      targets: [infra.target],
      publish: async (topic, payload): Promise<void> => { events.push({ topic, payload }); },
    });

    infra.setUp(false);
    await engine.checkNow();
    expect((await repository.pageAlerts({ page: 1, size: 10 })).total).toBe(0);
    await engine.checkNow();
    const firing = await repository.pageAlerts({ page: 1, size: 10, status: "FIRING" });
    expect(firing.total).toBe(1);
    expect(firing.items[0]).toMatchObject({ kind: "INFRA_DOWN", level: "CRITICAL" });
    expect((events[0]?.payload as ServiceDownPayload).alertKind).toBe("INFRA_DOWN");
  });

  it("响应过慢按连续轮次触发 WARNING，规则停用后自动撤销", async () => {
    const repository = new InMemoryMonitorRepository({ rules: seedMonitorRules() });
    // 阈值压到 0 毫秒：带 10 毫秒延时的探测必然记为过慢，避免赌真实耗时
    const slowRule = (await repository.findRule("rule-service-slow"))!;
    await repository.saveRule({ ...slowRule, thresholdMs: 0, consecutive: 2 });
    let slow = true;
    const target: MonitorTarget = {
      target: "demo", kind: "SERVICE", label: "演示服务",
      probe: async (): Promise<void> => { if (slow) await new Promise((resolve) => setTimeout(resolve, 10)); },
    };
    const events: CapturedEvent[] = [];
    const engine = createMonitorEngine({
      repository,
      targets: [target],
      publish: async (topic, payload): Promise<void> => { events.push({ topic, payload }); },
    });

    await engine.checkNow();
    expect((await repository.pageAlerts({ page: 1, size: 10 })).total).toBe(0);
    await engine.checkNow();
    const firing = await repository.pageAlerts({ page: 1, size: 10, status: "FIRING" });
    expect(firing.total).toBe(1);
    expect(firing.items[0]).toMatchObject({ kind: "SERVICE_SLOW", level: "WARNING" });
    expect((events[0]?.payload as ServiceDownPayload).alertKind).toBe("SERVICE_SLOW");
    // 过慢不改变可用性状态
    expect((await repository.listStatus())[0]?.status).toBe("UP");

    slow = false;
    await repository.saveRule({ ...slowRule, thresholdMs: 0, consecutive: 2, enabled: false });
    await engine.checkNow();
    expect((await repository.pageAlerts({ page: 1, size: 10, status: "FIRING" })).total).toBe(0);
    expect(events.filter((event) => event.topic === EventTopic.PlatformServiceRecovered)).toHaveLength(1);
  });

  it("停用的规则不触发告警，状态仍如实记录", async () => {
    const repository = new InMemoryMonitorRepository({ rules: seedMonitorRules() });
    const downRule = (await repository.findRule("rule-service-down"))!;
    await repository.saveRule({ ...downRule, enabled: false });
    const demo = controllableTarget("demo", "SERVICE", "演示服务");
    const engine = createMonitorEngine({ repository, targets: [demo.target] });

    demo.setUp(false);
    for (let round = 0; round < 4; round += 1) await engine.checkNow();
    expect((await repository.pageAlerts({ page: 1, size: 10 })).total).toBe(0);
    expect((await repository.listStatus())[0]).toMatchObject({ status: "DOWN", consecutiveFailures: 4 });
  });
});

describe("运维监控 HTTP API", () => {
  async function startMonitorServer(): Promise<{ base: string; repository: InMemoryMonitorRepository; checks: () => number }> {
    const repository = new InMemoryMonitorRepository({ rules: seedMonitorRules() });
    let checked = 0;
    const base = await start(createPlatformHttpServer({
      monitor: repository,
      monitorCheck: async (): Promise<void> => {
        checked += 1;
        const record: ServiceStatus = { target: "demo", kind: "SERVICE", label: "演示服务", status: "UP", latencyMs: 5, consecutiveFailures: 0, lastCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await repository.upsertStatus(record);
      },
    }));
    return { base, repository, checks: () => checked };
  }

  it("规则清单、编辑与入参校验，编辑留审计", async () => {
    const { base } = await startMonitorServer();
    const rules = await fetch(`${base}/api/v1/platform/monitor/rules`);
    expect(rules.status).toBe(200);
    expect((await rules.json() as { data: Array<{ id: string }> }).data.map((rule) => rule.id)).toEqual(["rule-infra-down", "rule-service-down", "rule-service-slow"]);

    const updated = await fetch(`${base}/api/v1/platform/monitor/rules/rule-service-slow`, {
      method: "PUT", headers: { "content-type": "application/json", "x-user-id": "user-admin" },
      body: JSON.stringify({ thresholdMs: 1500, consecutive: 2 }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { thresholdMs: number; consecutive: number } }).data).toMatchObject({ thresholdMs: 1500, consecutive: 2 });

    const badConsecutive = await fetch(`${base}/api/v1/platform/monitor/rules/rule-service-slow`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ consecutive: 0 }),
    });
    expect(badConsecutive.status).toBe(400);
    const badThreshold = await fetch(`${base}/api/v1/platform/monitor/rules/rule-service-slow`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ thresholdMs: -1 }),
    });
    expect(badThreshold.status).toBe(400);
    const missing = await fetch(`${base}/api/v1/platform/monitor/rules/rule-nope`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    expect(missing.status).toBe(404);

    const audit = await fetch(`${base}/api/v1/platform/audit-logs?keyword=monitorRule.update`);
    const logs = (await audit.json() as { data: { total: number; items: Array<{ operator: string; action: string }> } }).data;
    expect(logs.total).toBe(1);
    expect(logs.items[0]).toMatchObject({ operator: "user-admin", action: "monitorRule.update" });
  });

  it("监控接口按 system:monitor 权限放行与拒绝", async () => {
    const saved = process.env.AUTH_GUARD_MODE;
    process.env.AUTH_GUARD_MODE = "enforce";
    try {
      const { base } = await startMonitorServer();
      const anonymous = await fetch(`${base}/api/v1/platform/monitor/status`);
      expect(anonymous.status).toBe(401);
      const noPermission = await fetch(`${base}/api/v1/platform/monitor/status`, { headers: { "x-user-id": "u1", "x-permissions": "system:role" } });
      expect(noPermission.status).toBe(403);
      const ok = await fetch(`${base}/api/v1/platform/monitor/status`, { headers: { "x-user-id": "u1", "x-permissions": "system:monitor" } });
      expect(ok.status).toBe(200);
      const wildcard = await fetch(`${base}/api/v1/platform/monitor/rules`, { headers: { "x-user-id": "u1", "x-permissions": "*" } });
      expect(wildcard.status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.AUTH_GUARD_MODE;
      else process.env.AUTH_GUARD_MODE = saved;
    }
  });

  it("手动巡检触发引擎并返回最新状态，告警台账支持状态筛选", async () => {
    const { base, repository, checks } = await startMonitorServer();
    const alert: MonitorAlert = { id: "alert-test-1", target: "demo", kind: "SERVICE_DOWN", level: "CRITICAL", status: "FIRING", message: "连续 3 轮探测失败", firedAt: new Date().toISOString() };
    expect(await repository.fireAlert(alert)).toBe(true);
    // 同目标同类型在报期间重复触发被拒
    expect(await repository.fireAlert({ ...alert, id: "alert-test-2" })).toBe(false);

    const check = await fetch(`${base}/api/v1/platform/monitor/check`, { method: "POST", headers: { "content-type": "application/json", "x-user-id": "user-admin" }, body: "{}" });
    expect(check.status).toBe(200);
    expect(checks()).toBe(1);
    const statuses = (await check.json() as { data: Array<{ target: string; status: string }> }).data;
    expect(statuses.find((item) => item.target === "demo")?.status).toBe("UP");

    const firing = await fetch(`${base}/api/v1/platform/monitor/alerts?status=FIRING`);
    expect((await firing.json() as { data: { total: number } }).data.total).toBe(1);
    const resolved = await fetch(`${base}/api/v1/platform/monitor/alerts?status=RESOLVED`);
    expect((await resolved.json() as { data: { total: number } }).data.total).toBe(0);
    const badStatus = await fetch(`${base}/api/v1/platform/monitor/alerts?status=BOGUS`);
    expect(badStatus.status).toBe(400);

    const audit = await fetch(`${base}/api/v1/platform/audit-logs?keyword=monitor.check`);
    expect((await audit.json() as { data: { total: number } }).data.total).toBe(1);
  });
});