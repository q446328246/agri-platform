import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { InMemoryEventPublisher, OutboxService, setDefaultPublisher } from "@agri/mq";
import { configureDecorators, LoggerService } from "@agri/observability";

import { createTelemetryHttpServer } from "./http.js";
import type { TelemetryDependencies } from "./http.js";
import { SqlAlertRepository, SqlReadingRepository } from "./reading.repository.js";
import { TelemetryOutboxStore } from "./outbox.repository.js";

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
      const relay = new OutboxService(outbox, new InMemoryEventPublisher(), { tenantId, traceId: "telemetry-relay", producer: "telemetry" });
      relay.start();
      setDefaultPublisher(relay.publisher);
      const dependencies: TelemetryDependencies = {
        readings: new SqlReadingRepository(client),
        alerts: new SqlAlertRepository(client),
        outbox,
        publisher: relay.publisher,
        tenantId,
        publishEvents: process.env.TELEMETRY_PUBLISH_EVENTS === "true",
      };
      const server = createTelemetryHttpServer(dependencies);
      server.listen(port, "127.0.0.1", () => logger.info("telemetry-service HTTP 已启动（SQL 持久化）", { port }));
      const shutdown = async (): Promise<void> => {
        server.close();
        relay.stop();
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
