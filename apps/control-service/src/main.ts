import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { InMemoryEventLogStore, PgEventLogStore } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";

import { createControlEventConsumer } from "./consumer.js";
import { InMemoryControlCommandRepository, SqlControlCommandRepository } from "./control.repository.js";
import type { ControlCommandRepository } from "./control.repository.js";
import { createControlHttpServer } from "./http.js";

/**
 * 控制服务启动。
 *
 * 有数据库时指令落库并订阅共享事件日志：越限与处方事件会在本服务里
 * 转成水肥指令入队，重启后从已提交位点继续消费；没有数据库时退回内存
 * 实现，接口可用但事件只在本进程内可见。
 */

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3008);
  if (process.env.SERVICE_MODE !== "http") {
    console.log("control-service service started (demo mode)");
    return;
  }

  const mode = process.env.CONTROL_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";
  const pollIntervalMs = Number(process.env.CONTROL_POLL_INTERVAL_MS ?? 1000);

  let client: PgClientAdapter | undefined;
  let commands: ControlCommandRepository;
  let store: EventLogStore;
  if (mode === "sql") {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    commands = new SqlControlCommandRepository(client);
    store = new PgEventLogStore(client);
  } else {
    commands = new InMemoryControlCommandRepository();
    store = new InMemoryEventLogStore();
  }

  const { consumer } = createControlEventConsumer(commands, store, {
    group: process.env.CONTROL_CONSUMER_GROUP ?? "control-service",
    pollIntervalMs,
    onError: (topic, eventId, error, attempt) => {
      console.error(`[control-service] 事件处理失败 topic=${topic} eventId=${eventId} attempt=${attempt}`, error.message);
    },
  });

  const server = createControlHttpServer(commands);
  server.listen(port, "127.0.0.1", () =>
    console.log(`control-service HTTP started on ${port}（${mode === "sql" ? "SQL 持久化" : "内存实现"}）`),
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
