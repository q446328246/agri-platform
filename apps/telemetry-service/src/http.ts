import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ApiResponse } from "@agri/contracts";
import { publishEvent, setDefaultPublisher } from "@agri/mq";
import type { EventPublisher } from "@agri/mq";
import { InMemoryEventPublisher, InMemoryOutboxStore, OutboxService } from "@agri/mq";
import type { OutboxStore } from "@agri/mq";
import { EventTopic } from "@agri/contracts";
import type { PestDetectedPayload, ThresholdBreachedPayload } from "@agri/contracts";
import type { EventTopicValue } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { newReadingId } from "./reading.repository.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "./reading.repository.js";
import type { AlertRepository, CreateReadingInput, HistoryQuery, Reading, ReadingPoint, ReadingRepository, TelemetryAlert } from "./reading.repository.js";
import { InMemoryPestEventRepository } from "./pest.repository.js";
import type { CreatePestEventInput, PestEventRepository, PestLevel } from "./pest.repository.js";
import { breaches, DEFAULT_TELEMETRY_RULES, InMemoryRuleRepository } from "./rule.repository.js";
import type { RuleLevel, RuleRepository, TelemetryRule } from "./rule.repository.js";

/** 阈值规则由 telemetry_rules 表维护，缺省回落到默认规则集 */
function defaultRules(): RuleRepository {
  return new InMemoryRuleRepository(DEFAULT_TELEMETRY_RULES.map((rule) => ({ ...rule, updatedAt: new Date().toISOString() })));
}

export interface TelemetryDependencies {
  readings?: ReadingRepository;
  alerts?: AlertRepository;
  rules?: RuleRepository;
  pests?: PestEventRepository;
  outbox?: OutboxStore;
  publisher?: EventPublisher;
  tenantId?: string;
  /** 遥测越限/虫情事件可选发布；缺省不发布，保持仅落库 */
  publishEvents?: boolean;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `TELEMETRY-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trace(req: IncomingMessage): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : crypto.randomUUID();
}

/** 取去空白后的查询参数，缺省与空串统一视为「不参与筛选」 */
function trimmed(query: URLSearchParams, name: string): string {
  return (query.get(name) ?? "").trim();
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function historyQuery(params: URLSearchParams): HistoryQuery {
  const deviceId = params.get("deviceId") ?? undefined;
  const metric = params.get("metric") ?? undefined;
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;
  return {
    ...(deviceId ? { deviceId } : {}),
    ...(metric ? { metric } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: Number(params.get("size") ?? 200),
  };
}

/** 解析并校验阈值规则入参 */
function parseRule(body: Record<string, unknown>): { rule?: TelemetryRule; error?: string } {
  const metric = String(body.metric ?? "").trim();
  if (!metric) return { error: "metric 不能为空" };
  const direction = body.direction === "below" ? "below" : body.direction === "above" ? "above" : null;
  if (!direction) return { error: "direction 只能是 above 或 below" };
  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold)) return { error: "threshold 必须是数字" };
  const level: RuleLevel = body.level === "CRITICAL" ? "CRITICAL" : body.level === "INFO" ? "INFO" : "WARNING";
  const message = String(body.message ?? "").trim() || `${metric} 越限告警`;
  return {
    rule: {
      id: String(body.id ?? `rule-${metric}`),
      metric,
      direction,
      threshold,
      level,
      message,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      updatedAt: new Date().toISOString(),
    },
  };
}

/** 解析并校验虫情识别事件入参；置信度缺省按 0.9 处理，超出 0-1 拒绝 */
function parsePestEvent(body: Record<string, unknown>): { input?: CreatePestEventInput; error?: string } {
  const pestType = String(body.pestType ?? "").trim();
  if (!pestType) return { error: "pestType 不能为空" };
  const level = Number(body.level);
  if (level !== 1 && level !== 2 && level !== 3) return { error: "level 只能是 1、2、3" };
  const confidence = body.confidence === undefined ? 0.9 : Number(body.confidence);
  if (!(confidence >= 0 && confidence <= 1)) return { error: "confidence 必须落在 0 到 1" };
  const input: CreatePestEventInput = {
    plotCode: String(body.plotCode ?? ""),
    deviceId: String(body.deviceId ?? ""),
    pestType,
    level: level as PestLevel,
    confidence,
    detectedAt: String(body.detectedAt ?? new Date().toISOString()),
  };
  if (body.imageFileId !== undefined && body.imageFileId !== null && String(body.imageFileId) !== "") {
    input.imageFileId = String(body.imageFileId);
  }
  return { input };
}

export function createTelemetryHttpServer(dependencies?: TelemetryDependencies): Server {
  const readings = dependencies?.readings ?? new InMemoryReadingRepository();
  const alerts = dependencies?.alerts ?? new InMemoryAlertRepository();
  const rules = dependencies?.rules ?? defaultRules();
  const pests = dependencies?.pests ?? new InMemoryPestEventRepository();
  const tenantId = dependencies?.tenantId ?? "tenant-demo";
  const publisher = dependencies?.publisher ?? new InMemoryEventPublisher();
  setDefaultPublisher(publisher);
  const relay = new OutboxService(dependencies?.outbox ?? new InMemoryOutboxStore(), publisher, { tenantId, traceId: "telemetry-relay", producer: "telemetry" });
  relay.start();

  /** 统一事件出口：有本地消息表时先落表再中继，保证服务重启不丢事件 */
  const emit = async (topic: EventTopicValue, payload: unknown, key?: string): Promise<void> => {
    if (!dependencies?.publishEvents) return;
    if (dependencies.outbox) {
      await relay.enqueue(undefined, topic, payload, { tenantId, traceId: "telemetry-emit", producer: "telemetry" });
      return;
    }
    await publishEvent({ topic, payload, tenantId, traceId: "telemetry-emit", producer: "telemetry", ...(key ? { key } : {}) }, publisher);
  };

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "telemetry" }, traceId); return; }
      // 设备直连上报与 AI 识别回调不走用户身份，其余接口需要遥测读写权限
      const denied = authorizeRequest(req, { read: "telemetry:read", write: "telemetry:write", publicPaths: ["/api/v1/telemetry/report", "/api/v1/telemetry/pest-events"] });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 最新读数：按设备过滤，每个设备每个指标只取最近一次；地块/指标为可选后置筛选
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/latest") {
        const deviceId = url.searchParams.get("deviceId") ?? undefined;
        const rows = await readings.latest(deviceId);
        const plotCode = trimmed(url.searchParams, "plotCode");
        const metric = trimmed(url.searchParams, "metric");
        send(res, 200, rows.filter((row) => (!plotCode || row.plotCode === plotCode) && (!metric || row.metric === metric)), traceId);
        return;
      }

      // 历史读数：按设备、指标与时间窗查询原始序列
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/history") {
        const rows = await readings.history(historyQuery(url.searchParams));
        send(res, 200, rows, traceId);
        return;
      }

      // 历史曲线：按时间升序返回 (时间, 数值)，供趋势图直接绑定
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/history/series") {
        const points: ReadingPoint[] = await readings.historySeries(historyQuery(url.searchParams));
        send(res, 200, points, traceId);
        return;
      }

      // 待处理告警：级别/指标/地块可选筛选，缺省返回全部待处置
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/alerts") {
        const level = trimmed(url.searchParams, "level");
        const metric = trimmed(url.searchParams, "metric");
        const plotCode = trimmed(url.searchParams, "plotCode");
        const rows = await alerts.pending();
        send(res, 200, rows.filter((row) => (!level || row.level === level) && (!metric || row.metric === metric) && (!plotCode || row.plotCode === plotCode)), traceId);
        return;
      }

      const alertMatch = url.pathname.match(/^\/api\/v1\/telemetry\/alerts\/([^/]+)\/handle$/);
      if (alertMatch && req.method === "POST") {
        const id = alertMatch[1]; if (!id) { send(res, 400, null, traceId, "告警 ID 不能为空"); return; } const handled = await alerts.markHandled(decodeURIComponent(id));
        if (!handled) { send(res, 404, null, traceId, "告警不存在或已处理"); return; }
        send(res, 200, null, traceId);
        return;
      }

      // 上报读数：落库后按阈值生成告警，并在越限时写入本地消息表发布事件
      if (req.method === "POST" && url.pathname === "/api/v1/telemetry/report") {
        const body = await json(req);
        const input: CreateReadingInput = {
          deviceId: String(body.deviceId ?? ""),
          plotCode: String(body.plotCode ?? ""),
          metric: String(body.metric ?? ""),
          value: Number(body.value),
          unit: String(body.unit ?? ""),
          recordedAt: String(body.recordedAt ?? new Date().toISOString()),
        };
        if (!input.deviceId || !input.metric) { send(res, 400, null, traceId, "deviceId 与 metric 不能为空"); return; }
        const reading = await readings.create(undefined, input);
        const rule = await rules.findEnabled(reading.metric);
        let alert: TelemetryAlert | null = null;
        if (rule && breaches(rule, reading.value)) {
          alert = {
            id: newReadingId(),
            deviceId: reading.deviceId,
            plotCode: reading.plotCode,
            level: rule.level,
            metric: reading.metric,
            message: rule.message,
            createdAt: reading.recordedAt,
            handled: false,
          };
          await alerts.create(undefined, alert);
          const payload: ThresholdBreachedPayload = {
            parcelId: reading.plotCode,
            metric: reading.metric,
            value: reading.value,
            threshold: rule.threshold,
            direction: rule.direction,
            occurredAt: reading.recordedAt,
          };
          await emit(EventTopic.TelemetryThresholdBreached, payload, reading.plotCode);
        }
        send(res, 201, { reading, alert }, traceId);
        return;
      }

      // 阈值规则：苗情/虫情/灾情共用一套判定口径，改阈值不需要发版
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/rules") {
        send(res, 200, await rules.list(), traceId);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/telemetry/rules") {
        const parsed = parseRule(await json(req));
        if (!parsed.rule) { send(res, 400, null, traceId, parsed.error ?? "规则参数非法"); return; }
        send(res, 200, await rules.save(parsed.rule), traceId);
        return;
      }

      const ruleMatch = url.pathname.match(/^\/api\/v1\/telemetry\/rules\/([^/]+)$/);
      if (ruleMatch && req.method === "DELETE") {
        const metric = decodeURIComponent(ruleMatch[1] ?? "");
        if (!(await rules.remove(metric))) { send(res, 404, null, traceId, "规则不存在"); return; }
        send(res, 200, null, traceId);
        return;
      }

      // 虫情识别结果：AI 回调、摄像头上报、人工核查统一入口，落库后发布虫情事件
      if (req.method === "POST" && url.pathname === "/api/v1/telemetry/pest-events") {
        const parsed = parsePestEvent(await json(req));
        if (!parsed.input) { send(res, 400, null, traceId, parsed.error ?? "虫情事件参数非法"); return; }
        const event = await pests.create(undefined, parsed.input);
        const levelLabel = event.level === 3 ? "严重" : event.level === 2 ? "中等" : "轻微";
        const alert = await alerts.create(undefined, {
          id: newReadingId(),
          deviceId: event.deviceId,
          plotCode: event.plotCode,
          level: event.level === 3 ? "CRITICAL" : event.level === 2 ? "WARNING" : "INFO",
          metric: "pestCount",
          message: `识别到 ${event.pestType}（${levelLabel}）`,
          createdAt: event.detectedAt,
          handled: false,
        });
        const payload: PestDetectedPayload = {
          parcelId: event.plotCode,
          pestType: event.pestType,
          level: event.level,
          confidence: event.confidence,
          detectedAt: event.detectedAt,
        };
        if (event.imageFileId) payload.imageFileId = event.imageFileId;
        await emit(EventTopic.TelemetryPestDetected, payload, event.plotCode);
        send(res, 201, { event, alert }, traceId);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/pests") {
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const pendingOnly = url.searchParams.get("pendingOnly") === "true";
        const pestType = trimmed(url.searchParams, "pestType");
        const level = trimmed(url.searchParams, "level");
        const rows = await pests.list({ ...(plotCode ? { plotCode } : {}), pendingOnly, limit: Number(url.searchParams.get("size") ?? 100) });
        send(res, 200, rows.filter((row) => (!pestType || row.pestType === pestType) && (!level || String(row.level) === level)), traceId);
        return;
      }

      const pestMatch = url.pathname.match(/^\/api\/v1\/telemetry\/pests\/([^/]+)\/handle$/);
      if (pestMatch && req.method === "POST") {
        const id = decodeURIComponent(pestMatch[1] ?? "");
        if (!(await pests.markHandled(id))) { send(res, 404, null, traceId, "虫情记录不存在或已处理"); return; }
        send(res, 200, null, traceId);
        return;
      }

      // 四情总览：一次拉齐最新读数、待处置告警、虫情记录与规则，减少看板请求数；筛选参数缺省时与历史行为完全一致
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/overview") {
        const plotCode = trimmed(url.searchParams, "plotCode");
        const metric = trimmed(url.searchParams, "metric");
        const level = trimmed(url.searchParams, "level");
        const pestType = trimmed(url.searchParams, "pestType");
        const [latestAll, pendingAlerts, pestEvents, ruleList] = await Promise.all([
          readings.latest(),
          alerts.pending(),
          pests.list({ limit: 20 }),
          rules.list(),
        ]);
        send(res, 200, {
          latest: latestAll.filter((row) => (!plotCode || row.plotCode === plotCode) && (!metric || row.metric === metric)),
          alerts: pendingAlerts.filter((row) => (!plotCode || row.plotCode === plotCode) && (!level || row.level === level) && (!metric || row.metric === metric)),
          pests: pestEvents.filter((row) => (!plotCode || row.plotCode === plotCode) && (!pestType || row.pestType === pestType)),
          rules: ruleList,
        }, traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}

export type { Reading, TelemetryAlert, ReadingPoint };
export type { PestEvent } from "./pest.repository.js";
export type { TelemetryRule } from "./rule.repository.js";
export { breaches, DEFAULT_TELEMETRY_RULES } from "./rule.repository.js";
