import "reflect-metadata";

import { ALL_PERMISSIONS } from "@agri/contracts";
import type { EventTopicValue, GeoPolygon } from "@agri/contracts";
import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import type { PrismaClientLike } from "@agri/db";
import { EventLogPublisher, PgEventLogStore } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";
import { configureDecorators, LoggerService } from "@agri/observability";

import { createTractorHttpServer } from "./http.js";
import type { TractorHttpDependencies } from "./http.js";
import { InMemoryTractorJobRepository, SqlTractorJobRepository } from "./job.repository.js";
import type { TractorJobRepository } from "./job.repository.js";
import { InMemoryTractorSafetyEventRepository, SqlTractorSafetyEventRepository } from "./safety-event.repository.js";
import type { TractorSafetyEventRepository } from "./safety-event.repository.js";
import { createJobExecutor } from "./executor.js";
import type { ControlDispatchInput } from "./executor.js";
import { createTractorMonitor } from "./monitor.js";
import type { RtkSample } from "./monitor.js";
import { evaluatePrecheck, pointInsideWithBuffer, ringOf } from "./safety.js";
import type { SafetyGateResult } from "./safety.js";
import type { PlanOptions } from "./plan.js";

/**
 * 拖拉机作业服务启动（B2）。
 *
 * 作业编排与安全验证在本服务，指令生命周期复用控制服务（QUEUED→SENT→DONE），
 * 指令经控制侧出站表由场网关经 MQTT 下发给拖拉机，回执同链路回流。
 * 有数据库时作业、分步与安全事件落库（迁移 065）；没有数据库时内存降级，
 * 仅保留算法与端点，不提供持久化保证。
 */

/** 日志级别白名单，缺省 info */
function parseLogLevel(value?: string): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

/** 服务间调用身份：部署环境服务侧守卫强制鉴权，后台调用以 tractor-service 自标识并持全权限 */
const SERVICE_IDENTITY: Record<string, string> = { "x-user-id": "tractor-service", "x-permissions": ALL_PERMISSIONS };

async function getJson(url: string, identity: Record<string, string> = SERVICE_IDENTITY): Promise<unknown> {
  const response = await fetch(url, { headers: identity, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
  return response.json();
}

/** 环境变量数值解析：缺省或非法一律用缺省值 */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envToolCodes(): Record<string, string> | undefined {
  const raw = process.env.TRACTOR_TOOL_CODES;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch {
    // 配置非法时忽略，用缺省机具编码，不影响启动
  }
  return undefined;
}

interface ControlCommandView {
  id: string;
  status: string;
}

/** 控制服务客户端：指令下发与收口等待 */
function createControlClient(baseUrl: string, tenantId: string) {
  return {
    async dispatch(input: ControlDispatchInput): Promise<{ commandId: string } | null> {
      try {
        const response = await fetch(`${baseUrl}/api/v1/control/commands`, {
          method: "POST",
          headers: { "content-type": "application/json", ...SERVICE_IDENTITY, "x-tenant-id": tenantId, "x-confirm-action": "CONFIRM" },
          body: JSON.stringify({ deviceId: input.deviceId, plotCode: input.plotCode, type: input.type, parameters: input.parameters }),
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as { data?: { id?: string } };
        const commandId = payload.data?.id;
        return commandId ? { commandId } : null;
      } catch {
        return null;
      }
    },
    async commandsOf(deviceId: string): Promise<ControlCommandView[]> {
      const payload = await getJson(`${baseUrl}/api/v1/control/commands?deviceId=${encodeURIComponent(deviceId)}&size=20`);
      return (payload as { data?: { items?: ControlCommandView[] } }).data?.items ?? [];
    },
  };
}

/** 遥测服务客户端：最新 RTK 定位（经度/纬度/HDOP/定位状态四个指标合成采样） */
function createTelemetryClient(baseUrl: string) {
  async function latestMetric(deviceId: string, metric: string): Promise<{ value: number; recordedAt: string } | null> {
    const payload = await getJson(`${baseUrl}/api/v1/telemetry/latest?deviceId=${encodeURIComponent(deviceId)}&metric=${metric}`);
    const rows = (payload as { data?: Array<{ value?: number; recordedAt?: string }> }).data ?? [];
    const row = rows[0];
    if (!row || row.value === undefined || !row.recordedAt) return null;
    return { value: Number(row.value), recordedAt: String(row.recordedAt) };
  }
  return {
    async fetchRtk(deviceId: string): Promise<RtkSample | null> {
      const [lng, lat, hdop, fix] = await Promise.all([
        latestMetric(deviceId, "rtkLongitude").catch(() => null),
        latestMetric(deviceId, "rtkLatitude").catch(() => null),
        latestMetric(deviceId, "rtkHdop").catch(() => null),
        latestMetric(deviceId, "rtkFix").catch(() => null),
      ]);
      if (!lng || !lat) return null;
      // 以经度上报时刻为基准，避免两个指标时刻错位拼出假位置
      return {
        lng: lng.value,
        lat: lat.value,
        recordedAt: lng.recordedAt,
        hasFix: fix !== null,
        ...(hdop ? { hdop: hdop.value } : {}),
      };
    },
  };
}

/** 地块/设备档案客户端 */
function createCatalogClient(plotUrl: string, iotUrl: string) {
  return {
    async getPlot(plotCode: string): Promise<{ status: string; hasBoundary: boolean; geom: GeoPolygon | null } | null> {
      const payload = await getJson(`${plotUrl}/api/v1/plots/${encodeURIComponent(plotCode)}`);
      const plot = (payload as { data?: { plotStatus?: string; geom?: unknown } }).data;
      if (!plot) return null;
      return { status: String(plot.plotStatus ?? ""), hasBoundary: plot.geom !== undefined && plot.geom !== null, geom: (plot.geom ?? null) as GeoPolygon | null };
    },
    async getDevice(deviceId: string): Promise<{ type: string; status: string; plotCode?: string } | null> {
      const payload = await getJson(`${iotUrl}/api/v1/devices/${encodeURIComponent(deviceId)}`);
      const device = (payload as { data?: { type?: string; status?: string; plotCode?: string } }).data;
      if (!device) return null;
      return { type: String(device.type ?? ""), status: String(device.status ?? ""), ...(device.plotCode ? { plotCode: String(device.plotCode) } : {}) };
    },
  };
}

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE !== "http") {
    console.log("tractor-service service started (demo mode)");
    return;
  }

  const port = Number(process.env.PORT ?? 3015);
  const logger = new LoggerService({ serviceName: "tractor-service", level: parseLogLevel(process.env.LOG_LEVEL) });
  configureDecorators({ logger });
  const tenantId = process.env.TENANT_ID?.trim() || "tenant-demo";
  const mode = process.env.TRACTOR_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";

  const controlUrl = process.env.CONTROL_SERVICE_URL ?? "http://127.0.0.1:3008";
  const telemetryUrl = process.env.TELEMETRY_SERVICE_URL ?? "http://127.0.0.1:3004";
  const plotUrl = process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002";
  const iotUrl = process.env.IOT_SERVICE_URL ?? "http://127.0.0.1:3003";
  const control = createControlClient(controlUrl, tenantId);
  const telemetry = createTelemetryClient(telemetryUrl);
  const catalog = createCatalogClient(plotUrl, iotUrl);

  const hdopMax = envNumber("TRACTOR_RTK_HDOP_MAX", 2);
  const bufferM = envNumber("TRACTOR_GEOFENCE_BUFFER_M", 2);
  // 地块边界缓存：一次作业期内边界不变，避免每轮监测重复拉取
  const ringCache = new Map<string, Array<[number, number]> | null>();
  const insideGeofence = async (plotCode: string, lng: number, lat: number): Promise<boolean> => {
    let ring = ringCache.get(plotCode);
    if (ring === undefined) {
      const plot = await catalog.getPlot(plotCode).catch(() => null);
      ring = plot ? ringOf(plot.geom) : null;
      ringCache.set(plotCode, ring);
    }
    if (!ring) return false;
    return pointInsideWithBuffer(lng, lat, ring, bufferM);
  };

  // 作业前安全预检：设备、绑定、地块、在途互锁、RTK 质量五道门
  const precheck = async (input: { plotCode: string; deviceId: string; operator: string }): Promise<{ passed: boolean; gates: SafetyGateResult[]; tenantId: string }> => {
    const [device, plot] = await Promise.all([
      catalog.getDevice(input.deviceId).catch(() => null),
      catalog.getPlot(input.plotCode).catch(() => null),
    ]);
    const commands = await control.commandsOf(input.deviceId).catch(() => [] as ControlCommandView[]);
    const inTransit = commands.some((command) => command.status === "SENT" || command.status === "ACKED");
    const rtk = await telemetry.fetchRtk(input.deviceId).catch(() => null);
    const result = evaluatePrecheck({
      device: device ? { type: device.type, status: device.status, ...(device.plotCode !== undefined ? { plotCode: device.plotCode } : {}) } : null,
      plot: plot ? { status: plot.status, hasBoundary: plot.hasBoundary } : null,
      deviceBoundToPlot: device?.plotCode === input.plotCode,
      inTransitJob: inTransit,
      rtkQuality: rtk ? { ...(rtk.hdop !== undefined ? { hdop: rtk.hdop } : {}), ...(rtk.hasFix !== undefined ? { hasFix: rtk.hasFix } : {}) } : null,
    }, { rtkHdopMax: hdopMax });
    return { ...result, tenantId };
  };

  let client: PrismaClientLike | undefined;
  let jobs: TractorJobRepository;
  let safetyEvents: TractorSafetyEventRepository;
  let publish: ((topic: EventTopicValue, payload: unknown) => Promise<void>) | undefined;
  if (mode === "sql") {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    jobs = new SqlTractorJobRepository(client);
    safetyEvents = new SqlTractorSafetyEventRepository(client);
    const store: EventLogStore = new PgEventLogStore(client);
    const publisher = new EventLogPublisher(store, { tenantId, traceId: "tractor", producer: "tractor" });
    publish = async (topic, payload): Promise<void> => { await publisher.publish(topic, payload); };
  } else {
    jobs = new InMemoryTractorJobRepository();
    safetyEvents = new InMemoryTractorSafetyEventRepository();
  }

  const waitCommand = async (deviceId: string, commandId: string, timeoutMs: number): Promise<"DONE" | "FAILED" | "TIMEOUT"> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const commands = await control.commandsOf(deviceId).catch(() => [] as ControlCommandView[]);
      const command = commands.find((item) => item.id === commandId);
      if (command?.status === "DONE") return "DONE";
      if (command?.status === "FAILED") return "FAILED";
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return "TIMEOUT";
  };

  const executor = createJobExecutor({
    jobs,
    safetyEvents,
    dispatch: control.dispatch,
    waitCommand,
    ...(publish ? { publish } : {}),
    onError: (error, phase) => logger.warn("tractor-service 作业执行失败", { phase, message: error.message }),
  });

  const monitor = createTractorMonitor({
    jobs,
    safetyEvents,
    fetchRtk: telemetry.fetchRtk,
    insideGeofence,
    dispatch: control.dispatch,
    ...(publish ? { publish } : {}),
    intervalMs: envNumber("TRACTOR_MONITOR_INTERVAL_MS", 5000),
    commLossSeconds: envNumber("TRACTOR_COMM_LOSS_SECONDS", 30),
    rtkHdopMax: hdopMax,
    onError: (error, phase) => logger.warn("tractor-service 安全监测失败", { phase, message: error.message }),
  });
  if (mode === "sql" && process.env.TRACTOR_MONITOR_ENABLED !== "false") monitor.start();

  const toolCodes = envToolCodes();
  const planOptions: PlanOptions = { ...(toolCodes !== undefined ? { toolCodes } : {}) };
  const server = createTractorHttpServer({
    jobs,
    safetyEvents,
    executor,
    precheck,
    planOptions,
    tenantId,
  } satisfies Partial<TractorHttpDependencies>);
  server.listen(port, "127.0.0.1", () => logger.info("tractor-service HTTP 已启动", { port, mode }));

  const shutdown = async (): Promise<void> => {
    monitor.stop();
    server.close();
    await client?.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await bootstrap();
