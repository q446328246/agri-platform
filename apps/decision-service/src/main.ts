import "reflect-metadata";

import { ALL_PERMISSIONS } from "@agri/contracts";
import { PgClientAdapter, resolveDatabaseUrl } from "@agri/db";
import { EventLogPublisher, OutboxService, PgEventLogStore, setDefaultPublisher } from "@agri/mq";
import type { EventLogStore } from "@agri/mq";
import { configureDecorators, LoggerService } from "@agri/observability";

import { createDecisionEventConsumer } from "./consumer.js";
import { createDecisionHttpServer } from "./http.js";
import type { DecisionDependencies } from "./http.js";
import { buildAiChatFromEnv, createAiChatClient } from "./ai.client.js";
import type { AiChatClient } from "./ai.client.js";
import { SqlExecutionRepository } from "./execution.repository.js";
import { SqlOutcomeRepository } from "./outcome.repository.js";
import { SqlPrescriptionRepository } from "./prescription.repository.js";
import { DEFAULT_KNOWLEDGE, SqlKnowledgeRepository } from "./knowledge.repository.js";
import { SqlOutboxStore } from "./outbox.repository.js";
import { defaultRule, SqlRuleRepository } from "./rule.repository.js";
import { optionalFiniteNumber } from "./rule.engine.js";
import { SqlPredictionRepository } from "./prediction.repository.js";
import { createPredictionSweeper } from "./prediction.js";
import type { PredictionEngineOptions, PredictionFetchers } from "./prediction.js";

/** 日志级别白名单，缺省 info */
function parseLogLevel(value?: string): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

/** 从天气预报服务取未来 24h 降雨概率；不可用时返回缺测，绝不假定无雨。 */
function createRainProbabilityFetcher(weatherUrl: string): NonNullable<DecisionDependencies["fetchRainProbability"]> {
  return async (_plotCode, identity) => {
    try {
      // 透传身份头；鉴权失败或天气不可用时保留缺测状态。
      const res = await fetch(`${weatherUrl}/api/v1/weather/forecast?days=1`, { headers: identity, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { forecast?: Array<{ rainProbability?: unknown }> } };
      return optionalFiniteNumber(json.data?.forecast?.[0]?.rainProbability);
    } catch { return undefined; }
  };
}

/** 从地块台账取面积（亩）；取不到就返回缺测，控制侧据此拒绝自动执行而不是猜一个面积。 */
function createPlotAreaFetcher(plotUrl: string): NonNullable<DecisionDependencies["fetchPlotArea"]> {
  return async (plotCode, identity) => {
    try {
      const res = await fetch(`${plotUrl}/api/v1/plots/${encodeURIComponent(plotCode)}`, { headers: identity, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { areaMu?: unknown } };
      return optionalFiniteNumber(json.data?.areaMu);
    } catch { return undefined; }
  };
}

/** AI 问答通道：凭据不全时返回 undefined，/ask 降级规则式回答，不影响启动 */
function createAiClientFromEnv(logger: LoggerService): AiChatClient | undefined {
  const config = buildAiChatFromEnv(process.env);
  if (!config) return undefined;
  const client = createAiChatClient(config);
  logger.info("AI 问答通道已启用", { model: config.model, baseUrl: config.baseUrl });
  return client;
}

/** 服务间后台拉取身份：部署环境服务侧守卫强制鉴权，扫描器没有用户上下文，以决策服务自标识并持全权限 */
const SERVICE_IDENTITY: Record<string, string> = { "x-user-id": "decision-service", "x-permissions": ALL_PERMISSIONS };

/** 环境变量数值解析：缺省或非法一律缺测，由引擎按保守口径处理，不猜数 */
function optionalEnvNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return optionalFiniteNumber(value);
}

/**
 * 预测数据拉取（C3）：遥测历史/虫情/生育期、气象预报、地块清单。
 * 拉取失败返回空集，引擎按数据不足或保守判定留痕，不中断整轮扫描。
 */
function createPredictionFetchers(deps: { telemetryUrl: string; weatherUrl: string; plotUrl: string }): PredictionFetchers {
  const getJson = async (url: string): Promise<unknown> => {
    const res = await fetch(url, { headers: SERVICE_IDENTITY, signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
    return res.json();
  };
  return {
    async fetchPlotCodes(): Promise<string[]> {
      const json = await getJson(`${deps.plotUrl}/api/v1/plots?size=200`);
      const items = (json as { data?: { items?: Array<{ parcelCode?: string }> } }).data?.items ?? [];
      return items.map((item) => item.parcelCode ?? "").filter((code) => code !== "");
    },
    async fetchSoilSeries(plotCode: string, fromIso: string, toIso: string): Promise<Array<{ recordedAt: string; value: number }>> {
      const url = `${deps.telemetryUrl}/api/v1/telemetry/history/series?plotCode=${encodeURIComponent(plotCode)}&metric=soilMoisture&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=200`;
      const data = (await getJson(url)) as { data?: Array<{ recordedAt?: string; value?: number }> };
      const points = data.data ?? [];
      return points
        .map((point) => ({ recordedAt: String(point.recordedAt ?? ""), value: Number(point.value) }))
        .filter((point) => point.recordedAt !== "" && Number.isFinite(point.value))
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    },
    async fetchPestEvents(plotCode: string): Promise<Array<{ detectedAt: string; level: 1 | 2 | 3; handled: boolean; pestType: string }>> {
      const json = await getJson(`${deps.telemetryUrl}/api/v1/telemetry/pests?plotCode=${encodeURIComponent(plotCode)}&size=50`);
      const rows = (json as { data?: Array<Record<string, unknown>> }).data ?? [];
      return rows.map((row) => ({
        detectedAt: String(row.detectedAt ?? ""),
        level: Number(row.level) === 3 ? 3 : Number(row.level) === 2 ? 2 : 1,
        handled: row.handled === true,
        pestType: String(row.pestType ?? ""),
      }));
    },
    async fetchForecast(): Promise<Array<{ date: string; rainProbability?: number; tempMin?: number; tempMax?: number }>> {
      const json = await getJson(`${deps.weatherUrl}/api/v1/weather/forecast?days=3`);
      const days = (json as { data?: { forecast?: Array<Record<string, unknown>> } }).data?.forecast ?? [];
      return days.map((day) => {
        const forecast: { date: string; rainProbability?: number; tempMin?: number; tempMax?: number } = { date: String(day.date ?? "") };
        const rainProbability = optionalFiniteNumber(day.rainProbability);
        if (rainProbability !== undefined) forecast.rainProbability = rainProbability;
        const tempMin = optionalFiniteNumber(day.tempMin);
        if (tempMin !== undefined) forecast.tempMin = tempMin;
        const tempMax = optionalFiniteNumber(day.tempMax);
        if (tempMax !== undefined) forecast.tempMax = tempMax;
        return forecast;
      });
    },
    async fetchGrowthStages(plotCode: string): Promise<Array<{ stage: string; recordedAt?: string }>> {
      const json = await getJson(`${deps.telemetryUrl}/api/v1/telemetry/growth-stages?plotCode=${encodeURIComponent(plotCode)}`);
      const rows = (json as { data?: Array<Record<string, unknown>> }).data ?? [];
      return rows.map((row) => ({
        stage: String(row.stage ?? ""),
        ...(row.updatedAt !== undefined ? { recordedAt: String(row.updatedAt) } : {}),
      }));
    },
  };
}

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? 3006);
  const logger = new LoggerService({ serviceName: "decision-service", level: parseLogLevel(process.env.LOG_LEVEL) });
  configureDecorators({ logger });
  const ai = createAiClientFromEnv(logger);

  // 默认连接数据库持久化规则与处方留痕；内存路径仅供测试，
  // 不提供持久化、事务或自动控制可靠性保证。
  const mode = process.env.DECISION_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql";

  if (mode === "sql" && process.env.SERVICE_MODE === "http") {
    const client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    const rules = new SqlRuleRepository(client);
    // 首次启动播种默认补灌规则，保证开箱可用
    if ((await rules.count()) === 0) await rules.create({ ...defaultRule(new Date().toISOString()), condition: { ...defaultRule(new Date().toISOString()).condition }, action: { ...defaultRule(new Date().toISOString()).action } });
    const prescriptions = new SqlPrescriptionRepository(client);
    const outcomes = new SqlOutcomeRepository(client);
    const executions = new SqlExecutionRepository(client);
    const outbox = new SqlOutboxStore(client);
    const tenantId = process.env.TENANT_ID ?? "tenant-demo";
    const knowledge = new SqlKnowledgeRepository(client);
    // 首次启动播种默认农艺知识（迁移 061 已种种子，空表时回填保证开箱可用）
    if ((await knowledge.count(tenantId)) === 0) {
      const now = new Date().toISOString();
      await knowledge.seed(DEFAULT_KNOWLEDGE.map((entry) => ({ ...entry, tenantId, createdAt: now, updatedAt: now })));
    }
    const weatherUrl = process.env.WEATHER_SERVICE_URL ?? "http://127.0.0.1:3005";
    const fetchRainProbability = createRainProbabilityFetcher(weatherUrl);
    const fetchPlotArea = createPlotAreaFetcher(process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002");
    // 中继把本地消息表投递到共享事件日志，其他服务据此消费处方事件
    const store: EventLogStore = new PgEventLogStore(client);
    const publisher = new EventLogPublisher(store, { tenantId, traceId: "decision-relay", producer: "decision" });
    const relay = new OutboxService(outbox, publisher, { tenantId, traceId: "decision-relay", producer: "decision" });
    relay.start();
    setDefaultPublisher(publisher);
    // C3 预测扫描器：按周期拉取遥测/气象/地块数据，推算墒情/虫害/产量并落台账，
    // 达到预警/严重级发布预测预警事件进消息中心；DECISION_PREDICTION_ENABLED=false 关闭
    const telemetryUrl = process.env.TELEMETRY_SERVICE_URL ?? "http://127.0.0.1:3004";
    const predictions = new SqlPredictionRepository(client);
    const soilWarning = optionalEnvNumber("DECISION_PREDICTION_SOIL_WARNING_PCT");
    const soilCritical = optionalEnvNumber("DECISION_PREDICTION_SOIL_CRITICAL_PCT");
    const rainSuppress = optionalEnvNumber("DECISION_PREDICTION_RAIN_SUPPRESS_PCT");
    const pestWarn = optionalEnvNumber("DECISION_PREDICTION_PEST_WARN_SCORE");
    const pestCritical = optionalEnvNumber("DECISION_PREDICTION_PEST_CRITICAL_SCORE");
    const yieldBaseline = optionalEnvNumber("DECISION_PREDICTION_YIELD_BASELINE_KG_MU");
    const horizonHours = optionalEnvNumber("DECISION_PREDICTION_HORIZON_HOURS");
    const predictionOptions: PredictionEngineOptions = {
      ...(soilWarning !== undefined ? { soilWarningPct: soilWarning } : {}),
      ...(soilCritical !== undefined ? { soilCriticalPct: soilCritical } : {}),
      ...(rainSuppress !== undefined ? { rainSuppressProbability: rainSuppress } : {}),
      ...(pestWarn !== undefined ? { pestWarnScore: pestWarn } : {}),
      ...(pestCritical !== undefined ? { pestCriticalScore: pestCritical } : {}),
      ...(yieldBaseline !== undefined ? { yieldBaselineKgMu: yieldBaseline } : {}),
      ...(horizonHours !== undefined ? { horizonHours } : {}),
    };
    const predictionSweeper = createPredictionSweeper({
      repository: predictions,
      fetchers: createPredictionFetchers({ telemetryUrl, weatherUrl, plotUrl: process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002" }),
      tenantId,
      ...(publisher ? { publish: async (topic, payload): Promise<void> => { await publisher.publish(topic, payload); } } : {}),
      options: predictionOptions,
      intervalMs: Number(process.env.DECISION_PREDICTION_SWEEP_INTERVAL_MS ?? 21_600_000),
      onError: (error, phase) => logger.warn("decision-service 预测扫描失败", { phase, message: error.message }),
    });
    const predictionEnabled = process.env.DECISION_PREDICTION_ENABLED !== "false";
    if (predictionEnabled) predictionSweeper.start();
    const server = createDecisionHttpServer({ rules, prescriptions, outcomes, executions, knowledge, outbox, publisher, tenantId, fetchRainProbability, fetchPlotArea, predictions, ...(predictionEnabled ? { predictionSweeper } : {}), ...(ai ? { ai } : {}), withTransaction: (run) => client.$transaction(run) } satisfies Partial<DecisionDependencies>);
    server.listen(port, "127.0.0.1", () => logger.info("decision-service HTTP 已启动（SQL 持久化）", { port }));
    // 消费控制服务的结单事件，把处方实际执行的水肥用量回流到 decision_prescription_executions；
    // 同时消费遥测越限事件（A18）：EC/pH 偏离生成保守配比调整处方，复用同一条消息表中继发布
    const { consumer } = createDecisionEventConsumer(executions, prescriptions, store, {
      group: process.env.DECISION_CONSUMER_GROUP ?? "decision-service",
      pollIntervalMs: Number(process.env.DECISION_POLL_INTERVAL_MS ?? 1000),
      outbox: relay,
      withTransaction: (run) => client.$transaction(run),
      onError: (topic, eventId, error, attempt) => {
        logger.warn("decision-service 事件处理失败", { topic, eventId, attempt, message: error.message });
      },
    });
    await consumer.start();
    const shutdown = async (): Promise<void> => {
      await consumer.stop();
      server.close();
      relay.stop();
      predictionSweeper.stop();
      await client.$disconnect();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }

  if (process.env.SERVICE_MODE === "http") {
    const weatherUrl = process.env.WEATHER_SERVICE_URL ?? "http://127.0.0.1:3005";
    const fetchRainProbability = createRainProbabilityFetcher(weatherUrl);
    const fetchPlotArea = createPlotAreaFetcher(process.env.PLOT_SERVICE_URL ?? "http://127.0.0.1:3002");
    const server = createDecisionHttpServer({ fetchRainProbability, fetchPlotArea, ...(ai ? { ai } : {}) });
    server.listen(port, "127.0.0.1", () => logger.warn("decision-service HTTP 已启动（仅供内存测试，无事务保证）", { port }));
    return;
  }
  logger.info("decision-service 已启动（demo 模式）");
}

await bootstrap();
