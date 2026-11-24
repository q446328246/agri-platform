import "reflect-metadata";

import { ALL_PERMISSIONS } from "@agri/contracts";
import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { EventLogPublisher, InMemoryEventLogStore, OutboxService, PgEventLogStore } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";

import { createControlEventConsumer } from "./consumer.js";
import { InMemoryControlAuthorizationRepository, SqlControlAuthorizationRepository } from "./authorization.repository.js";
import type { ControlAuthorizationRepository } from "./authorization.repository.js";
import { InMemoryControlCommandRepository, SqlControlCommandRepository } from "./control.repository.js";
import type { ControlCommandRepository } from "./control.repository.js";
import { createControlHttpServer, DEFAULT_TENANT, resolveReceiptTimeoutMin } from "./http.js";
import type { ControlHttpOptions } from "./http.js";
import { SqlControlOutboxStore } from "./outbox.repository.js";
import { ControlReceiptSweeper } from "./receipt-sweeper.js";

/** 解析正数环境变量，缺省或非法时回落到默认值 */
function parseEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 服务间后台调用身份：部署环境服务侧守卫强制鉴权，以控制服务自标识并持全权限 */
const SERVICE_IDENTITY: Record<string, string> = { "x-user-id": "control-service", "x-permissions": ALL_PERMISSIONS };

/** 水肥指令类型 → 可执行该动作的设备类型（与 command-spec 的设备推断口径同源） */
const DEVICES_BY_COMMAND: Record<string, readonly string[]> = {
  IRRIGATION: ["IRRIGATION_PUMP", "IRRIGATION_VALVE"],
  FERTILIZATION: ["FERTILIZER_VALVE"],
};

/**
 * 自动指令目标设备解析：按地块向 iot-service 设备台账取可执行的真实水肥设备。
 * 自动指令必须落到台账设备——auto-* 伪设备没有领取方，指令会永远停在 QUEUED。
 * 拉取失败返回空集，消费方按「无设备不建单」留痕，不猜一台设备。
 */
function createDeviceResolver(iotUrl: string): (plotCode: string, commandType: string) => Promise<Array<{ id: string }>> {
  return async (plotCode, commandType) => {
    const types = DEVICES_BY_COMMAND[commandType] ?? [];
    try {
      const response = await fetch(`${iotUrl}/api/v1/devices?plotCode=${encodeURIComponent(plotCode)}&size=200`, {
        headers: SERVICE_IDENTITY,
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as { data?: { items?: Array<{ id?: string; type?: string }> } };
      return (payload.data?.items ?? [])
        .filter((device) => types.includes(device.type ?? ""))
        .map((device) => ({ id: String(device.id) }));
    } catch {
      return [];
    }
  };
}

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
 * 装配不需要后台定时改状态。消息表里的事件有两个来源：超时收口，以及灌溉
 * 指令结单（DONE 回执同事务追加 control.irrigation.finished）。
 *
 * 消息表只在 SQL 模式装配：事件要「与状态同事务」，而内存实现既没有
 * 事务边界、事件也出不了本进程，因此内存模式只改状态、不发事件。
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
  let authorizations: ControlAuthorizationRepository;
  let store: EventLogStore;
  if (mode === "sql") {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    commands = new SqlControlCommandRepository(client);
    authorizations = new SqlControlAuthorizationRepository(client);
    store = new PgEventLogStore(client);
  } else {
    commands = new InMemoryControlCommandRepository();
    authorizations = new InMemoryControlAuthorizationRepository();
    store = new InMemoryEventLogStore();
  }

  const { consumer } = createControlEventConsumer(commands, store, {
    group: process.env.CONTROL_CONSUMER_GROUP ?? "control-service",
    pollIntervalMs,
    // 越限补灌定额（D3 口径一）：缺省 15mm，在确认的 10–20 范围内，按土壤质地与作物需水调整
    supplementIrrigationMm: parseEnvNumber(process.env.AUTO_SUPPLEMENT_IRRIGATION_MM, 15),
    // 自动指令解析真实水肥设备逐台建单，不再产生无领取方的 auto-* 伪设备指令
    resolveDevices: createDeviceResolver(process.env.IOT_SERVICE_URL ?? "http://127.0.0.1:3003"),
    onSkip: (reason) => console.warn(`[control-service] 自动指令未建单：${reason}`),
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
  // 消息表与事务句柄成对装配：收口任务与结单接口用的是同一条 outbox
  const eventDeps: Pick<ControlHttpOptions, "outbox" | "withTransaction"> = db && relay
    ? { outbox: relay, withTransaction: (run) => db.$transaction(run) }
    : {};

  const timeoutMin = resolveReceiptTimeoutMin();
  const sweepIntervalMs = Number(process.env.CONTROL_RECEIPT_SWEEP_INTERVAL_MS ?? 60_000);
  const sweeper = new ControlReceiptSweeper(commands, {
    timeoutMin,
    intervalMs: sweepIntervalMs,
    ...eventDeps,
    onError: (commandId, error) => {
      console.error(`[control-service] 超时收口失败 commandId=${commandId}`, error.message);
    },
  });

  const server = createControlHttpServer(commands, {
    receiptTimeoutMin: timeoutMin,
    authorizations,
    // 料液密度（D1 口径）：升计量设备回执换算施肥千克数，缺省 1.0 kg/L，按现场配方调整
    fertilizerDensityKgPerL: parseEnvNumber(process.env.FERTILIZER_DENSITY_KG_L, 1),
    ...eventDeps,
  });
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
