import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { EventLogPublisher, PgEventLogStore, setDefaultPublisher } from "@agri/mq";
import { configureDecorators, LoggerService } from "@agri/observability";

import { createTelemetryHttpServer } from "./http.js";
import type { TelemetryDependencies } from "./http.js";
import { SqlAlertRepository, SqlReadingRepository } from "./reading.repository.js";
import { TelemetryOutboxStore } from "./outbox.repository.js";
import { SqlPestEventRepository } from "./pest.repository.js";
import { DEFAULT_TELEMETRY_RULES, SqlRuleRepository } from "./rule.repository.js";

/** 日志级别白名单，缺省 info */
function parseLogLevel(value?: string): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3004);
  const logger = new LoggerService({ serviceName: "telemetry-service", level: parseLogLevel(process.env.LOG_LEVEL) });
  configureDecorators({ logger });
  // 默认持久化到 PostgreSQL；显式设置 memory 时使用内存实现
  const mode = process.env.TELEMETRY_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";
  const tenantId = process.env.TENANT_ID ?? "tenant-demo";

  if (process.env.SERVICE_MODE === "http") {
    if (mode === "sql") {
      const client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
      await client.$connect();
      const outbox = new TelemetryOutboxStore(client);
      // 阈值规则表为空时回填默认规则（迁移已种过则不再写）
      const rules = new SqlRuleRepository(client);
      const seeded = await rules.seed(DEFAULT_TELEMETRY_RULES.map((rule) => ({ ...rule, updatedAt: new Date().toISOString() })));
      if (seeded > 0) logger.info("已回填默认阈值规则", { seeded });
      // 越限事件经本地消息表中继写入共享事件日志，供消息中心等消费方订阅
      const publisher = new EventLogPublisher(new PgEventLogStore(client), { tenantId, traceId: "telemetry-relay", producer: "telemetry" });
      setDefaultPublisher(publisher);
      const dependencies: TelemetryDependencies = {
        readings: new SqlReadingRepository(client),
        alerts: new SqlAlertRepository(client),
        rules,
        pests: new SqlPestEventRepository(client),
        outbox,
        publisher,
        tenantId,
        publishEvents: process.env.TELEMETRY_PUBLISH_EVENTS === "true",
      };
      const server = createTelemetryHttpServer(dependencies);
      server.listen(port, "127.0.0.1", () => logger.info("telemetry-service HTTP 已启动（SQL 持久化）", { port }));
      const shutdown = async (): Promise<void> => {
        server.close();
        await client.$disconnect();
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      return;
    }
    const server = createTelemetryHttpServer({ tenantId });
    server.listen(port, "127.0.0.1", () => logger.info("telemetry-service HTTP 已启动（内存实现）", { port }));
    return;
  }
  logger.info("telemetry-service 已启动（demo 模式）");
}

await bootstrap();
