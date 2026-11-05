import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { InMemoryEventLogStore, PgEventLogStore } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";

import { createTraceEventConsumer } from "./consumer.js";
import { createTraceHttpServer } from "./http.js";
import { InMemoryTraceRepository, SqlTraceRepository } from "./repository.js";
import type { TraceRepository } from "./repository.js";

/**
 * 追溯服务启动。
 *
 * 有数据库时档案落库并订阅共享事件日志：处方生成后自动写入生产档案，
 * 追溯码按来源事件固定，重启或重放都不会重复建档；没有数据库时退回
 * 内存实现，接口可用但事件只在本进程内可见。
 */

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3011);
  if (process.env.SERVICE_MODE !== "http") {
    console.log("trace-service service started (demo mode)");
    return;
  }

  const mode = process.env.TRACE_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";
  const pollIntervalMs = Number(process.env.TRACE_POLL_INTERVAL_MS ?? 1000);

  let client: PgClientAdapter | undefined;
  let records: TraceRepository;
  let store: EventLogStore;
  if (mode === "sql") {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    records = new SqlTraceRepository(client);
    store = new PgEventLogStore(client);
  } else {
    records = new InMemoryTraceRepository();
    store = new InMemoryEventLogStore();
  }

  const { consumer } = createTraceEventConsumer(records, store, {
    group: process.env.TRACE_CONSUMER_GROUP ?? "trace-service",
    pollIntervalMs,
    onError: (topic, eventId, error, attempt) => {
      console.error(`[trace-service] 事件处理失败 topic=${topic} eventId=${eventId} attempt=${attempt}`, error.message);
    },
  });

  const server = createTraceHttpServer(records);
  server.listen(port, "127.0.0.1", () =>
    console.log(`trace-service HTTP started on ${port}（${mode === "sql" ? "SQL 持久化" : "内存实现"}）`),
  );
  await consumer.start();

  const shutdown = async (): Promise<void> => {
    await consumer.stop();
    server.close();
    await client?.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await bootstrap();
