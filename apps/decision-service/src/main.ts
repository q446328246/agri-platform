import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { EventLogPublisher, OutboxService, PgEventLogStore, setDefaultPublisher } from "@agri/mq";
import { configureDecorators, LoggerService } from "@agri/observability";

import { createDecisionHttpServer } from "./http.js";
import type { DecisionDependencies } from "./http.js";
import { SqlOutcomeRepository } from "./outcome.repository.js";
import { SqlPrescriptionRepository } from "./prescription.repository.js";
import { SqlOutboxStore } from "./outbox.repository.js";
import { defaultRule, InMemoryRuleRepository, SqlRuleRepository } from "./rule.repository.js";

/** 日志级别白名单，缺省 info */
function parseLogLevel(value?: string): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

/** 从天气预报服务取未来 24h 降雨概率，用于规则求值（无降雨时不会误推迟） */
function createRainProbabilityFetcher(weatherUrl: string): NonNullable<DecisionDependencies["fetchRainProbability"]> {
  return async (_plotCode, identity) => {
    try {
      // 服务侧守卫为 enforce 时必须透传身份头，否则天气服务判 401，降雨概率静默退化成 0
      const res = await fetch(`${weatherUrl}/api/v1/weather/forecast?days=1`, { headers: identity, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { forecast?: Array<{ rainProbability: number }> } };
      return json.data?.forecast?.[0]?.rainProbability;
    } catch { return undefined; }
  };
}

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3006);
  const logger = new LoggerService({ serviceName: "decision-service", level: parseLogLevel(process.env.LOG_LEVEL) });
  configureDecorators({ logger });

  // 默认连接数据库持久化规则与处方留痕；显式设置为 memory 时使用内存实现，
  // 无数据库的本地演示仍可运行，但处方事件与留痕不再落库。
  const mode = process.env.DECISION_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";

  if (mode === "sql" && process.env.SERVICE_MODE === "http") {
    const client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    const rules = new SqlRuleRepository(client);
    // 首次启动播种默认补灌规则，保证开箱可用
    if ((await rules.count()) === 0) await rules.create({ ...defaultRule(new Date().toISOString()), condition: { ...defaultRule(new Date().toISOString()).condition }, action: { ...defaultRule(new Date().toISOString()).action } });
    const prescriptions = new SqlPrescriptionRepository(client);
    const outcomes = new SqlOutcomeRepository(client);
    const outbox = new SqlOutboxStore(client);
    const tenantId = process.env.TENANT_ID ?? "tenant-demo";
    const weatherUrl = process.env.WEATHER_SERVICE_URL ?? "http://127.0.0.1:3005";
    const fetchRainProbability = createRainProbabilityFetcher(weatherUrl);
    // 中继把本地消息表投递到共享事件日志，其他服务据此消费处方事件
    const publisher = new EventLogPublisher(new PgEventLogStore(client), { tenantId, traceId: "decision-relay", producer: "decision" });
    const relay = new OutboxService(outbox, publisher, { tenantId, traceId: "decision-relay", producer: "decision" });
    relay.start();
    setDefaultPublisher(publisher);
    const server = createDecisionHttpServer({ rules, prescriptions, outcomes, outbox, publisher, tenantId, fetchRainProbability } satisfies Partial<DecisionDependencies>);
    server.listen(port, "127.0.0.1", () => logger.info("decision-service HTTP 已启动（SQL 持久化）", { port }));
    const shutdown = async (): Promise<void> => {
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
    const server = createDecisionHttpServer({ fetchRainProbability });
    server.listen(port, "127.0.0.1", () => logger.info("decision-service HTTP 已启动（内存实现）", { port }));
    return;
  }
  logger.info("decision-service 已启动（demo 模式）");
}

await bootstrap();
