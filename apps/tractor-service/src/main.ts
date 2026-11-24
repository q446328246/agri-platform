import "reflect-metadata";

import { ALL_PERMISSIONS } from "@agri/contracts";
import type { EventTopicValue, GeoPolygon } from "@agri/contracts";
import { PgClientAdapter, resolveDatabaseUrl, withTransaction } from "@agri/db";
import type { PrismaClientLike } from "@agri/db";
import { EventLogPublisher, PgEventLogStore } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";
import { configureDecorators, LoggerService } from "@agri/observability";

import { createTractorHttpServer } from "./http.js";
import type { TractorHttpDependencies } from "./http.js";
import { InMemoryTractorJobRepository, SqlTractorJobRepository } from "./job.repository.js";
import type { TractorJobRepository, TractorStageKind } from "./job.repository.js";
import { InMemoryTractorSafetyEventRepository, SqlTractorSafetyEventRepository } from "./safety-event.repository.js";
import type { TractorSafetyEventRepository } from "./safety-event.repository.js";
import { InMemoryTrajectoryRepository, SqlTrajectoryRepository } from "./trajectory.repository.js";
import type { TrajectoryRepository } from "./trajectory.repository.js";
import { createTrajectoryPlanner } from "./trajectory.js";
import type { CoveragePlanView } from "./trajectory.js";
import { createJobExecutor, recoverUnfinishedJobs, recoveryCommand } from "./executor.js";
import type { ControlDispatchInput } from "./executor.js";
import { createTractorMonitor } from "./monitor.js";
import type { RtkSample } from "./monitor.js";
import { buildValidRtkSample, evaluatePrecheck, pointInsidePolygonWithBuffer, polygonRingsOf } from "./safety.js";
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

/** 环境变量数值解析：缺省或非法一律用缺省值（空串解析为 0，必须先判空） */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
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
  idempotencyKey?: string;
}

/** 控制服务客户端：指令下发与收口等待 */
function createControlClient(baseUrl: string) {
  return {
    async dispatch(input: ControlDispatchInput): Promise<{ commandId: string } | null> {
      try {
        const response = await fetch(`${baseUrl}/api/v1/control/commands`, {
          method: "POST",
          headers: { "content-type": "application/json", ...SERVICE_IDENTITY, "x-tenant-id": input.tenantId, "x-confirm-action": "CONFIRM" },
          body: JSON.stringify({
            deviceId: input.deviceId,
            plotCode: input.plotCode,
            type: input.type,
            parameters: input.parameters,
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
          signal: AbortSignal.timeout(3000),
        });
        if (response.status >= 400 && response.status < 500) return null;
        if (!response.ok) throw new Error(`控制服务返回 ${response.status}`);
        const payload = (await response.json()) as { data?: { id?: string } };
        const commandId = payload.data?.id;
        return commandId ? { commandId } : null;
      } catch (error) {
        throw new Error(`控制服务不可用：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async healthy(): Promise<boolean> {
      try {
        const response = await fetch(`${baseUrl}/health`, { headers: SERVICE_IDENTITY, signal: AbortSignal.timeout(2000) });
        return response.ok;
      } catch {
        return false;
      }
    },
    async hasActiveJob(tenantId: string, deviceId: string, excludeCommandId?: string): Promise<boolean> {
      const payload = await getJson(
        `${baseUrl}/api/v1/control/device/in-transit?deviceId=${encodeURIComponent(deviceId)}${excludeCommandId ? `&excludeCommandId=${encodeURIComponent(excludeCommandId)}` : ""}`,
        { ...SERVICE_IDENTITY, "x-tenant-id": tenantId },
      );
      const value = (payload as { data?: { inTransit?: boolean } }).data?.inTransit;
      if (typeof value !== "boolean") throw new Error("控制服务未返回在途作业状态");
      return value;
    },
    async commandOf(tenantId: string, commandId: string): Promise<ControlCommandView> {
      const payload = await getJson(
        `${baseUrl}/api/v1/control/commands/${encodeURIComponent(commandId)}`,
        { ...SERVICE_IDENTITY, "x-tenant-id": tenantId },
      );
      const command = (payload as { data?: ControlCommandView }).data;
      if (!command?.id) throw new Error("控制服务未返回指令");
      return command;
    },
    async commandByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<ControlCommandView | null> {
      const payload = await getJson(
        `${baseUrl}/api/v1/control/commands/by-idempotency-key?key=${encodeURIComponent(idempotencyKey)}`,
        { ...SERVICE_IDENTITY, "x-tenant-id": tenantId },
      );
      return (payload as { data?: ControlCommandView | null }).data ?? null;
    },
    async cancelCommand(tenantId: string, commandId: string, reason: string): Promise<boolean> {
      const response = await fetch(`${baseUrl}/api/v1/control/commands/${encodeURIComponent(commandId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", ...SERVICE_IDENTITY, "x-tenant-id": tenantId },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(3000),
      }).catch((error: unknown) => {
        throw new Error(`控制服务不可用：${error instanceof Error ? error.message : String(error)}`);
      });
      if (response.status === 409) return false;
      if (!response.ok) throw new Error(`控制服务返回 ${response.status}`);
      return true;
    },
  };
}

/** 遥测服务客户端：最新 RTK 定位（经度/纬度/HDOP/定位状态四个指标合成采样） */
function createTelemetryClient(baseUrl: string) {
  async function latestMetric(tenantId: string, deviceId: string, metric: string): Promise<{ value: number; recordedAt: string } | null> {
    const payload = await getJson(
      `${baseUrl}/api/v1/telemetry/latest?deviceId=${encodeURIComponent(deviceId)}&metric=${metric}`,
      { ...SERVICE_IDENTITY, "x-tenant-id": tenantId },
    );
    const rows = (payload as { data?: Array<{ value?: number; recordedAt?: string }> }).data ?? [];
    const row = rows[0];
    if (!row || row.value === undefined || !row.recordedAt) return null;
    return { value: Number(row.value), recordedAt: String(row.recordedAt) };
  }
  return {
    async fetchRtk(tenantId: string, deviceId: string): Promise<RtkSample | null> {
      const [lng, lat, hdop, fix] = await Promise.all([
        latestMetric(tenantId, deviceId, "rtkLongitude").catch(() => null),
        latestMetric(tenantId, deviceId, "rtkLatitude").catch(() => null),
        latestMetric(tenantId, deviceId, "rtkHdop").catch(() => null),
        latestMetric(tenantId, deviceId, "rtkFix").catch(() => null),
      ]);
      const sample = buildValidRtkSample({ lng, lat, hdop, fix });
      return sample;
    },
  };
}

/** 地块/设备档案客户端 */
function createCatalogClient(plotUrl: string, iotUrl: string) {
  return {
    async getPlot(tenantId: string, plotCode: string): Promise<{ status: string; hasBoundary: boolean; geom: GeoPolygon | null } | null> {
      const payload = await getJson(`${plotUrl}/api/v1/plots/${encodeURIComponent(plotCode)}`, { ...SERVICE_IDENTITY, "x-tenant-id": tenantId });
      const plot = (payload as { data?: { plotStatus?: string; geom?: unknown } }).data;
      if (!plot) return null;
      return { status: String(plot.plotStatus ?? ""), hasBoundary: plot.geom !== undefined && plot.geom !== null, geom: (plot.geom ?? null) as GeoPolygon | null };
    },
    async getDevice(tenantId: string, deviceId: string): Promise<{ type: string; status: string; plotCode?: string } | null> {
      const payload = await getJson(`${iotUrl}/api/v1/devices/${encodeURIComponent(deviceId)}`, { ...SERVICE_IDENTITY, "x-tenant-id": tenantId });
      const device = (payload as { data?: { type?: string; status?: string; plotCode?: string } }).data;
      if (!device) return null;
      return { type: String(device.type ?? ""), status: String(device.status ?? ""), ...(device.plotCode ? { plotCode: String(device.plotCode) } : {}) };
    },
  };
}

/** operation-service 客户端：覆盖规划（按地块边界 + 幅宽算牛耕式作业轨迹） */
function createOperationClient(baseUrl: string) {
  return {
    async coveragePlan(input: { tenantId: string; plotCode: string; boundary: GeoPolygon; implementWidthM: number }): Promise<CoveragePlanView | null> {
      try {
        const response = await fetch(`${baseUrl}/api/v1/operations/coverage-plan`, {
          method: "POST",
          headers: { "content-type": "application/json", ...SERVICE_IDENTITY, "x-tenant-id": input.tenantId },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as { data?: CoveragePlanView };
        return payload.data ?? null;
      } catch {
        return null;
      }
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
  const control = createControlClient(controlUrl);
  const telemetry = createTelemetryClient(telemetryUrl);
  const catalog = createCatalogClient(plotUrl, iotUrl);
  const operation = createOperationClient(process.env.OPERATION_SERVICE_URL ?? "http://127.0.0.1:3007");

  const hdopMax = envNumber("TRACTOR_RTK_HDOP_MAX", 2);
  const bufferM = envNumber("TRACTOR_GEOFENCE_BUFFER_M", 2);
  const rtkMaxAgeSeconds = envNumber("TRACTOR_RTK_MAX_AGE_SECONDS", 30);
  // 边界短期缓存，查询失败不缓存；null 表示本轮无法判定，监测不能将其当作越界。
  const ringCache = new Map<string, { rings: Array<Array<[number, number]>>; expiresAt: number }>();
  const insideGeofence = async (tenantId: string, plotCode: string, lng: number, lat: number): Promise<boolean | null> => {
    const cacheKey = `${tenantId}:${plotCode}`;
    const cached = ringCache.get(cacheKey);
    let rings: Array<Array<[number, number]>> | null | undefined = cached && cached.expiresAt > Date.now() ? cached.rings : undefined;
    if (!rings) {
      const plot = await catalog.getPlot(tenantId, plotCode).catch(() => null);
      rings = plot ? polygonRingsOf(plot.geom) : null;
      if (rings) ringCache.set(cacheKey, { rings, expiresAt: Date.now() + 60_000 });
    }
    if (!rings) return null;
    return pointInsidePolygonWithBuffer(lng, lat, rings, bufferM);
  };

  // 作业前安全预检：设备、绑定、地块、在途互锁、RTK 质量五道门
  const precheck = async (input: { tenantId: string; plotCode: string; deviceId: string; operator: string; allowCommandId?: string; stageKind?: TractorStageKind }): Promise<{ passed: boolean; gates: SafetyGateResult[]; tenantId: string }> => {
    const [device, plot] = await Promise.all([
      catalog.getDevice(input.tenantId, input.deviceId).catch(() => null),
      catalog.getPlot(input.tenantId, input.plotCode).catch(() => null),
    ]);
    const inTransit = await control.hasActiveJob(input.tenantId, input.deviceId, input.allowCommandId);
    const rtk = await telemetry.fetchRtk(input.tenantId, input.deviceId).catch(() => null);
    const rings = plot ? polygonRingsOf(plot.geom) : null;
    const positionInside = rtk !== null && rings !== null && rtk.lng !== undefined && rtk.lat !== undefined
      && Number.isFinite(rtk.lng) && Number.isFinite(rtk.lat)
      && pointInsidePolygonWithBuffer(rtk.lng, rtk.lat, rings, bufferM);
    const result = evaluatePrecheck({
      device: device ? { type: device.type, status: device.status, ...(device.plotCode !== undefined ? { plotCode: device.plotCode } : {}) } : null,
      plot: plot ? { status: plot.status, hasBoundary: plot.hasBoundary, boundaryValid: rings !== null } : null,
      deviceBoundToPlot: device?.plotCode === input.plotCode,
      inTransitJob: inTransit,
      rtkQuality: rtk,
      positionInside,
      requirePositionInside: input.stageKind === undefined || input.stageKind === "OPERATION",
    }, { rtkHdopMax: hdopMax, rtkMaxAgeSeconds });
    return { ...result, tenantId: input.tenantId };
  };

  const trajectoryPlanner = createTrajectoryPlanner({
    getPlot: (input) => catalog.getPlot(input.tenantId, input.plotCode),
    coveragePlan: (input) => operation.coveragePlan(input),
  });

  let client: PrismaClientLike | undefined;
  let jobs: TractorJobRepository;
  let safetyEvents: TractorSafetyEventRepository;
  let trajectories: TrajectoryRepository;
  let transaction: TractorHttpDependencies["transaction"];
  let publish: ((topic: EventTopicValue, payload: unknown) => Promise<void>) | undefined;
  if (mode === "sql") {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    jobs = new SqlTractorJobRepository(client);
    safetyEvents = new SqlTractorSafetyEventRepository(client);
    trajectories = new SqlTrajectoryRepository(client);
    const store: EventLogStore = new PgEventLogStore(client);
    const publisher = new EventLogPublisher(store, { tenantId, traceId: "tractor", producer: "tractor" });
    publish = async (topic, payload): Promise<void> => { await publisher.publish(topic, payload); };
    transaction = async (handler) => withTransaction(client!, handler);
  } else {
    jobs = new InMemoryTractorJobRepository();
    safetyEvents = new InMemoryTractorSafetyEventRepository();
    trajectories = new InMemoryTrajectoryRepository();
  }

  const waitCommand = async (tenantId: string, _deviceId: string, commandId: string, timeoutMs: number): Promise<"DONE" | "FAILED" | "PAUSED" | "TIMEOUT" | "UNAVAILABLE"> => {
    const deadline = Date.now() + timeoutMs;
    let reachable = false;
    while (Date.now() < deadline) {
      const command = await control.commandOf(tenantId, commandId).catch(() => null);
      if (command) reachable = true;
      if (command?.status === "DONE") return "DONE";
      if (command?.status === "FAILED" || command?.status === "CANCELLED") return "FAILED";
      if (command?.status === "PAUSED") return "PAUSED";
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return reachable ? "TIMEOUT" : "UNAVAILABLE";
  };

  const executor = createJobExecutor({
    jobs,
    safetyEvents,
    dispatch: control.dispatch,
    waitCommand,
    beforeStage: async (job, stage) => {
      const allowCommand = await recoveryCommand(stage, (key) => control.commandByIdempotencyKey(tenantId, key));
      const result = await precheck({
        tenantId,
        plotCode: job.plotCode,
        deviceId: job.deviceId,
        operator: job.operator,
        stageKind: stage.stage,
        ...(allowCommand ? { allowCommandId: allowCommand.id } : {}),
      });
      const failed = result.gates.filter((gate) => !gate.passed);
      if (!result.passed) {
        await safetyEvents.create(undefined, {
          tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
          kind: "PRECHECK_FAIL", level: "WARNING",
          message: `分步 ${stage.stage} 下发前预检未通过：${failed.map((gate) => gate.message).join("；")}`,
        });
      }
      return {
        passed: result.passed,
        ...(allowCommand ? { commandId: allowCommand.id, commandStatus: allowCommand.status } : {}),
      };
    },
    commandOf: (tenant, commandId) => control.commandOf(tenant, commandId),
    cancelCommand: (tenant, commandId, reason) => control.cancelCommand(tenant, commandId, reason),
    safetyCommandTimeoutMs: envNumber("TRACTOR_SAFETY_COMMAND_TIMEOUT_MS", 30_000),
    ...(publish ? { publish } : {}),
    onError: (error, phase) => logger.warn("tractor-service 作业执行失败", { phase, message: error.message }),
  });

  const monitor = createTractorMonitor({
    tenantId,
    jobs,
    safetyEvents,
    fetchRtk: (deviceId) => telemetry.fetchRtk(tenantId, deviceId),
    insideGeofence: (plotCode, lng, lat) => insideGeofence(tenantId, plotCode, lng, lat),
    dispatch: control.dispatch,
    waitCommand,
    safetyCommandTimeoutMs: envNumber("TRACTOR_SAFETY_COMMAND_TIMEOUT_MS", 30_000),
    ...(publish ? { publish } : {}),
    intervalMs: envNumber("TRACTOR_MONITOR_INTERVAL_MS", 5000),
    commLossSeconds: envNumber("TRACTOR_COMM_LOSS_SECONDS", 30),
    rtkHdopMax: hdopMax,
    trajectories,
    trajectoryDeviationMaxM: envNumber("TRACTOR_TRAJECTORY_DEVIATION_MAX_M", 5),
    onError: (error, phase) => logger.warn("tractor-service 安全监测失败", { phase, message: error.message }),
  });
  if (mode === "sql" && process.env.TRACTOR_MONITOR_ENABLED !== "false") monitor.start();

  const toolCodes = envToolCodes();
  const planOptions: PlanOptions = { ...(toolCodes !== undefined ? { toolCodes } : {}) };
  const server = createTractorHttpServer({
    jobs,
    safetyEvents,
    trajectories,
    trajectoryPlanner,
    executor,
    precheck,
    planOptions,
    ...(transaction ? { transaction } : {}),
    tenantId,
  } satisfies Partial<TractorHttpDependencies>);
  let recoveryRunning = false;
  const recover = async (): Promise<void> => {
    if (recoveryRunning || !await control.healthy()) return;
    recoveryRunning = true;
    try {
      await recoverUnfinishedJobs({
        tenantId,
        jobs,
        executor,
        onError: (error, jobId) => logger.warn("tractor-service 未完成作业恢复失败", { jobId, message: error.message }),
      });
    } catch (error) {
      logger.warn("tractor-service 未完成作业扫描失败", { error: String(error) });
    } finally {
      recoveryRunning = false;
    }
  };
  const recoveryTimer = setInterval(() => { void recover(); }, envNumber("TRACTOR_RECOVERY_INTERVAL_MS", 30_000));
  recoveryTimer.unref?.();
  server.listen(port, "127.0.0.1", () => {
    logger.info("tractor-service HTTP 已启动", { port, mode });
    if (mode === "sql") void recover();
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(recoveryTimer);
    monitor.stop();
    server.close();
    await client?.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await bootstrap();
