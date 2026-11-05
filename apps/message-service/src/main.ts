import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { InMemoryEventLogStore, PgEventLogStore } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";

import { createMessageEventConsumer } from "./consumer.js";
import { createMessageHttpServer } from "./http.js";
import { InMemoryMessageRepository, SqlMessageRepository } from "./message.repository.js";
import type { MessageRepository } from "./message.repository.js";
import { InMemoryMessagePreferenceRepository, SqlMessagePreferenceRepository } from "./preference.repository.js";
import type { MessagePreferenceRepository } from "./preference.repository.js";

/**
 * 消息服务启动。
 *
 * 有数据库时同时启用消息持久化与事件消费：消费位点保存在
 * event_log_offsets，重启后从上次位点继续；没有数据库时全部退回内存实现，
 * 仍可联调接口，但事件只在本进程内可见。
 */

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3012);
  if (process.env.SERVICE_MODE !== "http") {
    console.log("message-service service started (demo mode)");
    return;
  }

  const mode = process.env.MESSAGE_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";
  const tenantId = process.env.TENANT_ID ?? "tenant-demo";
  const pollIntervalMs = Number(process.env.MESSAGE_POLL_INTERVAL_MS ?? 1000);

  let client: PgClientAdapter | undefined;
  let messages: MessageRepository;
  let preferences: MessagePreferenceRepository;
  let store: EventLogStore;
  if (mode === "sql") {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    messages = new SqlMessageRepository(client);
    preferences = new SqlMessagePreferenceRepository(client);
    store = new PgEventLogStore(client);
  } else {
    messages = new InMemoryMessageRepository();
    preferences = new InMemoryMessagePreferenceRepository();
    store = new InMemoryEventLogStore();
  }

  const { consumer } = createMessageEventConsumer(messages, store, {
    group: process.env.MESSAGE_CONSUMER_GROUP ?? "message-service",
    pollIntervalMs,
    preferences,
    onError: (topic, eventId, error, attempt) => {
      console.error(`[message-service] 事件处理失败 topic=${topic} eventId=${eventId} attempt=${attempt}`, error.message);
    },
  });

  const server = createMessageHttpServer({ messages, preferences, tenantId });
  server.listen(port, "127.0.0.1", () => console.log(`message-service HTTP started on ${port}（${mode === "sql" ? "SQL 持久化" : "内存实现"}）`));
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
