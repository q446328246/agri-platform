import "reflect-metadata";
import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { createVideoHttpServer } from "./http.js";
import { InMemoryAiEventRepository, SqlAiEventRepository } from "./ai-event.repository.js";
import type { AiEventRepository } from "./ai-event.repository.js";
import { demoCameras, InMemoryCameraRepository, SqlCameraRepository } from "./camera.repository.js";
import type { CameraRepository } from "./camera.repository.js";
import { InMemoryPtzRepository, SqlPtzRepository } from "./ptz.repository.js";
import type { PtzRepository } from "./ptz.repository.js";
import { InMemoryRecordingArchiveRepository, SqlRecordingArchiveRepository } from "./recording-archive.repository.js";
import type { RecordingArchiveRepository } from "./recording-archive.repository.js";
import { UnconfiguredPtzChannel, WebhookPtzChannel } from "./ptz-channel.js";
import { AiForwardRelay } from "./ai-relay.js";

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE !== "http") { console.log("video-service service started (demo mode)"); return; }
  const sql = Boolean(process.env.DB_URL) && process.env.VIDEO_REPOSITORY_MODE !== "memory";
  const client = sql ? PgClientAdapter.fromUrl(resolveDatabaseUrl()) : undefined;
  await client?.$connect();
  const tenantId = process.env.TENANT_ID?.trim() || "tenant-demo";
  const aiEvents: AiEventRepository = client ? new SqlAiEventRepository(client) : new InMemoryAiEventRepository();
  const ptz: PtzRepository = client ? new SqlPtzRepository(client) : new InMemoryPtzRepository();
  const archives: RecordingArchiveRepository = client ? new SqlRecordingArchiveRepository(client) : new InMemoryRecordingArchiveRepository();
  // 摄像机台账：SQL 模式读库，内存模式注入演示摄像机（与迁移 070 的种子同口径）
  const cameras: CameraRepository = client ? new SqlCameraRepository(client) : new InMemoryCameraRepository(demoCameras(tenantId));
  const ptzUrl = (process.env.PTZ_WEBHOOK_URL ?? "").trim();
  const channel = ptzUrl ? new WebhookPtzChannel(ptzUrl) : new UnconfiguredPtzChannel();
  const server = createVideoHttpServer({ aiEvents, ptz, archives, cameras, channel });
  const relay = new AiForwardRelay(aiEvents, {
    baseUrl: process.env.TELEMETRY_BASE_URL ?? "http://127.0.0.1:3004",
    deviceToken: process.env.DEVICE_CALLBACK_TOKEN,
    intervalMs: positiveIntEnv("VIDEO_AI_RETRY_INTERVAL_MS", 30_000),
    maxRetries: positiveIntEnv("VIDEO_AI_MAX_RETRIES", 5),
  });
  relay.start();
  const port = Number(process.env.PORT ?? 3009);
  server.listen(port, "127.0.0.1", () => console.log(`video-service HTTP started on ${port} (${sql ? "SQL" : "memory demo, not persistent"})`));
  const shutdown = async (): Promise<void> => {
    relay.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client?.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await bootstrap();