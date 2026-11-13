import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { EventLogPublisher, OutboxService, PgEventLogStore, setDefaultPublisher } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";
import { configureDecorators, LoggerService } from "@agri/observability";

import { createDecisionEventConsumer } from "./consumer.js";
import { createDecisionHttpServer } from "./http.js";
import type { DecisionDependencies } from "./http.js";
import { SqlExecutionRepository } from "./execution.repository.js";
import { SqlOutcomeRepository } from "./outcome.repository.js";
import { SqlPrescriptionRepository } from "./prescription.repository.js";
import { SqlOutboxStore } from "./outbox.repository.js";
import { defaultRule, SqlRuleRepository } from "./rule.repository.js";
import { optionalFiniteNumber } from "./rule.engine.js";

/** 日志级别白名单，缺省 info */
function parseLogLevel(value?: string): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

/** 从天气预报服务取未来 24h 降雨概率；不可用时返回缺测，绝不假定无雨。 */
function createRainProbabilityFetcher(weatherUrl: string): NonNullable<DecisionDependencies["fetchRainProbability"]> {
  return async (_plotCode, identity) => {
    try {
      // 透传身份头；鉴权失败或天气不可用时保留缺测状态。
      const res = await fetch(`${weatherUrl}/api/v1/weather/forecast?days=1`, { headers: identity, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { forecast?: Array<{ rainProbability?: unknown }> } };
      return optionalFiniteNumber(json.data?.forecast?.[0]?.rainProbability);
    } catch { return undefined; }
  };
}

/** 从地块台账取面积（亩）；取不到就返回缺测，控制侧据此拒绝自动执行而不是猜一个面积。 */
function createPlotAreaFetcher(plotUrl: string): NonNullable<DecisionDependencies["fetchPlotArea"]> {
  return async (plotCode, identity) => {
    try {
      const res = await fetch(`${plotUrl}/api/v1/plots/${encodeURIComponent(plotCode)}`, { headers: identity, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { areaMu?: unknown } };
      return optionalFiniteNumber(json.data?.areaMu);
    } catch { return undefined; }
  };
}

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3006);
  const logger = new LoggerService({ serviceName: "decision-service", level: parseLogLevel(process.env.LOG_LEVEL) });
  configureDecorators({ logger });

  // 默认连接数据库持久化规则与处方留痕；内存路径仅供测试，
  // 不提供持久化、事务或自动控制可靠性保证。
  const mode = process.env.DECISION_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";

  if (mode === "sql" && process.env.SERVICE_MODE === "http") {
    const client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    const rules = new SqlRuleRepository(client);
    // 首次启动播种默认补灌规则，保证开箱可用
    if ((await rules.count()) === 0) await rules.create({ ...defaultRule(new Date().toISOString()), condition: { ...defaultRule(new Date().toISOString()).condition }, action: { ...defaultRule(new Date().toISOString()).action } });
    const prescriptions = new SqlPrescriptionRepository(client);
    const outcomes = new SqlOutcomeRepository(client);
    const executions = new SqlExecutionRepository(client);
    const outbox = new SqlOutboxStore(client);
    const tenantId = process.env.TENANT_ID ?? "tenant-demo";
    const weatherUrl = process.env.WEATHER_SERVICE_URL ?? "http://127.0.0.1:3005";
    const fetchRainProbability = createRainProbabilityFetcher(weatherUrl);
    const fetchPlotArea = createPlotAreaFetcher(process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002");
    // 中继把本地消息表投递到共享事件日志，其他服务据此消费处方事件
    const store: EventLogStore = new PgEventLogStore(client);
    const publisher = new EventLogPublisher(store, { tenantId, traceId: "decision-relay", producer: "decision" });
    const relay = new OutboxService(outbox, publisher, { tenantId, traceId: "decision-relay", producer: "decision" });
    relay.start();
    setDefaultPublisher(publisher);
    const server = createDecisionHttpServer({ rules, prescriptions, outcomes, executions, outbox, publisher, tenantId, fetchRainProbability, fetchPlotArea, withTransaction: (run) => client.$transaction(run) } satisfies Partial<DecisionDependencies>);
    server.listen(port, "127.0.0.1", () => logger.info("decision-service HTTP 已启动（SQL 持久化）", { port }));
    // 消费控制服务的结单事件，把处方实际执行的水肥用量回流到 decision_prescription_executions
    const { consumer } = createDecisionEventConsumer(executions, prescriptions, store, {
      group: process.env.DECISION_CONSUMER_GROUP ?? "decision-service",
      pollIntervalMs: Number(process.env.DECISION_POLL_INTERVAL_MS ?? 1000),
      onError: (topic, eventId, error, attempt) => {
        logger.warn("decision-service 事件处理失败", { topic, eventId, attempt, message: error.message });
      },
    });
    await consumer.start();
    const shutdown = async (): Promise<void> => {
      await consumer.stop();
      server.close();
      relay.stop();
      await client.$disconnect();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }

  if (process.env.SERVICE_MODE === "http") {
    const weatherUrl = process.env.WEATHER_SERVICE_URL ?? "http://127.0.0.1:3005";
    const fetchRainProbability = createRainProbabilityFetcher(weatherUrl);
    const fetchPlotArea = createPlotAreaFetcher(process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002");
    const server = createDecisionHttpServer({ fetchRainProbability, fetchPlotArea });
    server.listen(port, "127.0.0.1", () => logger.warn("decision-service HTTP 已启动（仅供内存测试，无事务保证）", { port }));
    return;
  }
  logger.info("decision-service 已启动（demo 模式）");
}

await bootstrap();
