import "reflect-metadata";
import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { EventLogPublisher, OutboxService, PgEventLogStore } from "@agri/mq";
import { createOperationHttpServer } from "./http.js";
import { SqlTaskRepository } from "./task.repository.js";
import { SqlTaskChangeLogRepository } from "./task-change-log.repository.js";
import { SqlOperationOutbox } from "./outbox.repository.js";
import { SqlVariableRatePlanRepository } from "./variable-rate.repository.js";
import { createWeatherForecastFetcher } from "./weather-conflict.js";

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE !== "http") { console.log("operation-service service started (demo mode)"); return; }
  const sql = Boolean(process.env.DB_URL) && process.env.OPERATION_REPOSITORY_MODE !== "memory";
  const client = sql ? PgClientAdapter.fromUrl(resolveDatabaseUrl()) : undefined;
  await client?.$connect();
  // 天气冲突提示（方案 8.4/8.7）：与决策侧同一接入模式，直连 weather-service 只读本地预报库
  const fetchWeatherForecast = createWeatherForecastFetcher(process.env.WEATHER_SERVICE_URL ?? "http://127.0.0.1:3005");
  const server = createOperationHttpServer({ ...(client ? { tasks: new SqlTaskRepository(client, new SqlTaskChangeLogRepository(client)), variablePlans: new SqlVariableRatePlanRepository(client) } : {}), fetchWeatherForecast });
  const relayDefaults = { tenantId: process.env.TENANT_ID ?? "tenant-demo", traceId: "operation-relay", producer: "operation" };
  const relay = client ? new OutboxService(new SqlOperationOutbox(client), new EventLogPublisher(new PgEventLogStore(client), relayDefaults), relayDefaults) : undefined;
  relay?.start();
  const port = Number(process.env.PORT ?? 3007);
  server.listen(port, "127.0.0.1", () => console.log(`operation-service HTTP started on ${port} (${sql ? "SQL" : "memory demo, not persistent"})`));
  const shutdown = async (): Promise<void> => {
    relay?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client?.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await bootstrap();
