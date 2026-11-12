import "reflect-metadata";

import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { EventLogPublisher, InMemoryEventLogStore, OutboxService, PgEventLogStore } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";

import { createControlEventConsumer } from "./consumer.js";
import { InMemoryControlCommandRepository, SqlControlCommandRepository } from "./control.repository.js";
import type { ControlCommandRepository } from "./control.repository.js";
import { createControlHttpServer, DEFAULT_TENANT, resolveReceiptTimeoutMin } from "./http.js";
import { SqlControlOutboxStore } from "./outbox.repository.js";
import { ControlReceiptSweeper } from "./receipt-sweeper.js";

/**
 * 控制服务启动。
 *
 * 有数据库时指令落库并订阅共享事件日志：越限与处方事件会在本服务里
 * 转成水肥指令入队，重启后从已提交位点继续消费；没有数据库时退回内存
 * 实现，接口可用但事件只在本进程内可见。
 *
 * HTTP 模式还会拉起两件事：本地消息表中继（把 control_outbox 待投递事件
 * 写进共享事件日志）与超时收口任务（在途超过 CONTROL_RECEIPT_TIMEOUT_MIN
 * 的指令置 FAILED 并推超时事件）。两者只在 HTTP 模式跑，演示模式的单进程
 * 装配不需要后台定时改状态。
 *
 * 消息表只在 SQL 模式装配：收口要「状态与事件同事务」，而内存实现既没有
 * 事务边界、事件也出不了本进程，因此内存模式只收口状态、不发事件。
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

  // SQL 模式：超时收口与超时事件同事务落 control_outbox，再由中继写进共享事件日志
  const db = client;
  const tenantId = process.env.TENANT_ID?.trim() || DEFAULT_TENANT;
  const relayContext = { tenantId, traceId: "control-relay", producer: "control" };
  const relay = db ? new OutboxService(new SqlControlOutboxStore(db), new EventLogPublisher(store, relayContext), relayContext) : undefined;
  relay?.start(Number(process.env.CONTROL_OUTBOX_RELAY_INTERVAL_MS ?? 1000));

  const timeoutMin = resolveReceiptTimeoutMin();
  const sweepIntervalMs = Number(process.env.CONTROL_RECEIPT_SWEEP_INTERVAL_MS ?? 60_000);
  const sweeper = new ControlReceiptSweeper(commands, {
    timeoutMin,
    intervalMs: sweepIntervalMs,
    ...(relay && db ? { outbox: relay, withTransaction: (run) => db.$transaction(run) } : {}),
    onError: (commandId, error) => {
      console.error(`[control-service] 超时收口失败 commandId=${commandId}`, error.message);
    },
  });

  const server = createControlHttpServer(commands);
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `control-service HTTP started on ${port}（${mode === "sql" ? "SQL 持久化" : "内存实现"}，超时阈值 ${timeoutMin} 分钟，收口间隔 ${sweepIntervalMs} 毫秒）`,
    ),
  );
  await consumer.start();
  sweeper.start();

  const shutdown = async (): Promise<void> => {
    sweeper.stop();
    relay?.stop();
    await consumer.stop();
    server.close();
    await client?.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await bootstrap();
