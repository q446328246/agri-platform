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
import { authorizeRequest, toIsoTimestamp } from "@agri/shared";

import { newReadingId } from "./reading.repository.js";
import { InMemoryAlertRepository, InMemoryReadingRepository } from "./reading.repository.js";
import type { AlertRepository, CreateReadingInput, HistoryQuery, Reading, ReadingPoint, ReadingRepository, TelemetryAlert } from "./reading.repository.js";
import { InMemoryPestEventRepository } from "./pest.repository.js";
import type { CreatePestEventInput, GovernPestInput, PestAggregateFilter, PestEventRepository, PestLevel } from "./pest.repository.js";
import { InMemoryGrowthStageRepository } from "./growth.repository.js";
import type { GrowthStageInput, GrowthStageRepository } from "./growth.repository.js";
import { DISASTER_STATUSES, DISASTER_TYPES, InMemoryDisasterRepository } from "./disaster.repository.js";
import type { CreateDisasterInput, DisasterRepository, DisasterSeverity, DisasterStatus, SupplementDisasterInput, DisasterType } from "./disaster.repository.js";
import { breaches, DEFAULT_TELEMETRY_RULES, InMemoryRuleRepository, RULE_SEVERITY } from "./rule.repository.js";
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
  growth?: GrowthStageRepository;
  disasters?: DisasterRepository;
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
  const plotCode = params.get("plotCode") ?? undefined;
  const depth = parseDepth(params.get("depthCm"));
  return {
    ...(deviceId ? { deviceId } : {}),
    ...(metric ? { metric } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(plotCode ? { plotCode } : {}),
    ...(typeof depth === "number" ? { depthCm: depth } : {}),
    limit: Number(params.get("size") ?? 200),
  };
}

/** 土壤分层深度（厘米）：缺省/空串视为非分层指标返回 undefined，非法值返回 null 供调用方拒绝 */
function parseDepth(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth < 0 || depth > 32767) return null;
  return depth;
}

/** 解析并校验阈值规则入参 */
function parseRule(body: Record<string, unknown>): { rule?: TelemetryRule; error?: string } {
  const metric = String(body.metric ?? "").trim();
  if (!metric) return { error: "metric 不能为空" };
  const plotCode = String(body.plotCode ?? "").trim();
  const direction = body.direction === "below" ? "below" : body.direction === "above" ? "above" : null;
  if (!direction) return { error: "direction 只能是 above 或 below" };
  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold)) return { error: "threshold 必须是数字" };
  const level: RuleLevel = body.level === "CRITICAL" ? "CRITICAL" : body.level === "INFO" ? "INFO" : "WARNING";
  const message = String(body.message ?? "").trim() || `${metric} 越限告警`;
  return {
    rule: {
      id: String(body.id ?? `rule-${metric}-${plotCode || "global"}-${level}`),
      metric,
      plotCode,
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

/** 生育期节点时间：缺省/空串返回 undefined（不写该节点），非法时间返回 null 供调用方拒绝 */
function parseStageTime(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const iso = toIsoTimestamp(value);
  return iso && !Number.isNaN(new Date(iso).getTime()) ? iso : null;
}

/** 解析并校验生育期档案入参：地块与生育期必填，四个节点时间可选但需合法 */
function parseGrowthStage(body: Record<string, unknown>): { input?: GrowthStageInput; error?: string } {
  const plotCode = String(body.plotCode ?? "").trim();
  if (!plotCode) return { error: "plotCode 不能为空" };
  const stage = String(body.stage ?? "").trim();
  if (!stage) return { error: "stage 不能为空" };
  const plannedStartAt = parseStageTime(body.plannedStartAt);
  const plannedEndAt = parseStageTime(body.plannedEndAt);
  const actualStartAt = parseStageTime(body.actualStartAt);
  const actualEndAt = parseStageTime(body.actualEndAt);
  if (plannedStartAt === null) return { error: "plannedStartAt 不是合法时间" };
  if (plannedEndAt === null) return { error: "plannedEndAt 不是合法时间" };
  if (actualStartAt === null) return { error: "actualStartAt 不是合法时间" };
  if (actualEndAt === null) return { error: "actualEndAt 不是合法时间" };
  return {
    input: {
      plotCode,
      stage,
      note: String(body.note ?? "").trim(),
      ...(plannedStartAt ? { plannedStartAt } : {}),
      ...(plannedEndAt ? { plannedEndAt } : {}),
      ...(actualStartAt ? { actualStartAt } : {}),
      ...(actualEndAt ? { actualEndAt } : {}),
    },
  };
}

/** 解析并校验虫情治理入参：状态只能是向前推进的三档，其余字段按字符串选填 */
function parseGovernance(body: Record<string, unknown>): { input?: GovernPestInput; error?: string } {
  const status = body.status;
  if (status !== "planned" && status !== "dispatched" && status !== "archived") {
    return { error: "status 只能是 planned、dispatched 或 archived" };
  }
  const field = (key: string): string | undefined => (body[key] === undefined || body[key] === null ? undefined : String(body[key]).trim());
  const measure = field("measure");
  const pesticide = field("pesticide");
  const dosage = field("dosage");
  const dispatchNote = field("dispatchNote");
  const governedBy = field("governedBy");
  const taskId = field("taskId");
  return {
    input: {
      status,
      ...(measure !== undefined ? { measure } : {}),
      ...(pesticide !== undefined ? { pesticide } : {}),
      ...(dosage !== undefined ? { dosage } : {}),
      ...(dispatchNote !== undefined ? { dispatchNote } : {}),
      ...(governedBy !== undefined ? { governedBy } : {}),
      ...(taskId ? { taskId } : {}),
    },
  };
}

/** 统计/趋势时间窗：plotCode/pestType 选填，from/to 为 ISO；趋势 days 缺省 14、上限 365 */
function aggregateFilter(params: URLSearchParams): PestAggregateFilter {
  const plotCode = trimmed(params, "plotCode");
  const pestType = trimmed(params, "pestType");
  const from = trimmed(params, "from");
  const to = trimmed(params, "to");
  return {
    ...(plotCode ? { plotCode } : {}),
    ...(pestType ? { pestType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

/** 解析并校验灾情上报入参：灾种/等级白名单，受灾面积非负，发生时间合法 */
function parseDisaster(body: Record<string, unknown>): { input?: CreateDisasterInput; error?: string } {
  const disasterType = String(body.disasterType ?? "").trim();
  if (!DISASTER_TYPES.includes(disasterType as DisasterType)) return { error: `disasterType 只能是 ${DISASTER_TYPES.join("、")}` };
  const severity = Number(body.severity);
  if (severity !== 1 && severity !== 2 && severity !== 3 && severity !== 4) return { error: "severity 只能是 1、2、3、4" };
  const affectedAreaMu = Number(body.affectedAreaMu ?? 0);
  if (!Number.isFinite(affectedAreaMu) || affectedAreaMu < 0) return { error: "affectedAreaMu 必须为非负数" };
  const occurredRaw = body.occurredAt === undefined || body.occurredAt === "" ? new Date().toISOString() : String(body.occurredAt);
  const occurredAt = toIsoTimestamp(occurredRaw);
  if (!occurredAt || Number.isNaN(new Date(occurredAt).getTime())) return { error: "occurredAt 不是合法时间" };
  const imageFileIds = Array.isArray(body.imageFileIds) ? body.imageFileIds.map((item) => String(item)).filter((item) => item !== "") : undefined;
  return {
    input: {
      disasterType: disasterType as DisasterType,
      plotCode: String(body.plotCode ?? "").trim(),
      affectedAreaMu,
      severity: severity as DisasterSeverity,
      occurredAt,
      suggestion: String(body.suggestion ?? "").trim(),
      reportedBy: String(body.reportedBy ?? "").trim(),
      ...(imageFileIds ? { imageFileIds } : {}),
    },
  };
}

/** 解析灾情补充处置入参：状态白名单，面积非负，其余字段按字符串选填 */
function parseDisasterSupplement(body: Record<string, unknown>): { input?: SupplementDisasterInput; error?: string } {
  const input: SupplementDisasterInput = {};
  if (body.status !== undefined && body.status !== null && body.status !== "") {
    const status = String(body.status);
    if (!DISASTER_STATUSES.includes(status as DisasterStatus)) return { error: `status 只能是 ${DISASTER_STATUSES.join("、")}` };
    input.status = status as DisasterStatus;
  }
  if (body.suggestion !== undefined && body.suggestion !== null) input.suggestion = String(body.suggestion).trim();
  if (body.lossAssessment !== undefined && body.lossAssessment !== null) input.lossAssessment = String(body.lossAssessment).trim();
  if (body.handledBy !== undefined && body.handledBy !== null) input.handledBy = String(body.handledBy).trim();
  if (body.affectedAreaMu !== undefined && body.affectedAreaMu !== null && body.affectedAreaMu !== "") {
    const area = Number(body.affectedAreaMu);
    if (!Number.isFinite(area) || area < 0) return { error: "affectedAreaMu 必须为非负数" };
    input.affectedAreaMu = area;
  }
  if (Array.isArray(body.imageFileIds)) input.imageFileIds = body.imageFileIds.map((item) => String(item)).filter((item) => item !== "");
  return { input };
}

export function createTelemetryHttpServer(dependencies?: TelemetryDependencies): Server {
  const readings = dependencies?.readings ?? new InMemoryReadingRepository();
  const alerts = dependencies?.alerts ?? new InMemoryAlertRepository();
  const rules = dependencies?.rules ?? defaultRules();
  const pests = dependencies?.pests ?? new InMemoryPestEventRepository();
  const growth = dependencies?.growth ?? new InMemoryGrowthStageRepository();
  const disasters = dependencies?.disasters ?? new InMemoryDisasterRepository();
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
      // 设备上报与 AI 回调认 DEVICE_CALLBACK_TOKEN 凭证（或用户写权限），其余接口需要遥测读写权限
      const denied = authorizeRequest(req, { read: "telemetry:read", write: "telemetry:write", callbackPaths: ["/api/v1/telemetry/report", "/api/v1/telemetry/pest-events"] });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 最新读数：按设备过滤，每个设备每个指标（含深度分层）只取最近一次；地块/指标/深度为可选后置筛选
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/latest") {
        const deviceId = url.searchParams.get("deviceId") ?? undefined;
        const rows = await readings.latest(deviceId);
        const plotCode = trimmed(url.searchParams, "plotCode");
        const metric = trimmed(url.searchParams, "metric");
        const depth = parseDepth(trimmed(url.searchParams, "depthCm"));
        send(res, 200, rows.filter((row) => (!plotCode || row.plotCode === plotCode) && (!metric || row.metric === metric) && (typeof depth !== "number" || row.depthCm === depth)), traceId);
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
        const depth = parseDepth(body.depthCm);
        if (depth === null) { send(res, 400, null, traceId, "depthCm 必须是 0-32767 的整数（厘米）"); return; }
        const input: CreateReadingInput = {
          deviceId: String(body.deviceId ?? ""),
          plotCode: String(body.plotCode ?? ""),
          metric: String(body.metric ?? ""),
          value: Number(body.value),
          unit: String(body.unit ?? ""),
          recordedAt: String(body.recordedAt ?? new Date().toISOString()),
          ...(typeof depth === "number" ? { depthCm: depth } : {}),
        };
        if (!input.deviceId || !input.metric) { send(res, 400, null, traceId, "deviceId 与 metric 不能为空"); return; }
        const reading = await readings.create(undefined, input);
        // 地块专属分级规则优先，未配置回落全局；命中多级时只按最严重的一级生成一条告警
        const applicable = await rules.findEnabled(reading.metric, reading.plotCode);
        const rule = applicable
          .filter((candidate) => breaches(candidate, reading.value))
          .sort((a, b) => RULE_SEVERITY[b.level] - RULE_SEVERITY[a.level])[0] ?? null;
        let alert: TelemetryAlert | null = null;
        if (rule) {
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

      // 阈值规则：苗情/虫情/灾情共用一套判定口径，改阈值不需要发版；按地块筛选时含全局兜底
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/rules") {
        const plotCode = trimmed(url.searchParams, "plotCode");
        const all = await rules.list();
        send(res, 200, plotCode ? all.filter((rule) => rule.plotCode === plotCode || rule.plotCode === "") : all, traceId);
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
        const plotCode = trimmed(url.searchParams, "plotCode");
        const levelParam = trimmed(url.searchParams, "level");
        const level: RuleLevel | undefined = levelParam === "INFO" || levelParam === "WARNING" || levelParam === "CRITICAL" ? levelParam : undefined;
        if (!(await rules.remove(metric, plotCode, level))) { send(res, 404, null, traceId, "规则不存在"); return; }
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

      // 虫情区域统计：按等级/虫害类型/地块聚合，供虫情页统计表与占比图（开发方案 6.3）
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/pests/stats") {
        send(res, 200, await pests.stats(aggregateFilter(url.searchParams)), traceId);
        return;
      }

      // 虫情趋势：最近 days 天的农场日历日逐日计数，缺省 14 天，供趋势曲线
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/pests/trend") {
        const days = Number(trimmed(url.searchParams, "days") || 14);
        if (!Number.isInteger(days) || days < 1 || days > 365) { send(res, 400, null, traceId, "days 必须是 1-365 的整数"); return; }
        send(res, 200, await pests.trend({ ...aggregateFilter(url.searchParams), days }), traceId);
        return;
      }

      const pestMatch = url.pathname.match(/^\/api\/v1\/telemetry\/pests\/([^/]+)\/handle$/);
      if (pestMatch && req.method === "POST") {
        const id = decodeURIComponent(pestMatch[1] ?? "");
        if (!(await pests.markHandled(id))) { send(res, 404, null, traceId, "虫情记录不存在或已处理"); return; }
        send(res, 200, null, traceId);
        return;
      }

      // 虫情治理：记录药剂方案/措施与派单说明，状态推进；派单生成的植保任务 id 由前端回填
      const governMatch = url.pathname.match(/^\/api\/v1\/telemetry\/pests\/([^/]+)\/govern$/);
      if (governMatch && req.method === "POST") {
        const id = decodeURIComponent(governMatch[1] ?? "");
        const parsed = parseGovernance(await json(req));
        if (!parsed.input) { send(res, 400, null, traceId, parsed.error ?? "治理参数非法"); return; }
        const updated = await pests.govern(id, parsed.input);
        if (!updated) { send(res, 404, null, traceId, "虫情记录不存在"); return; }
        send(res, 200, updated, traceId);
        return;
      }

      // 苗情生育期档案：按地块回看计划节点与实际节点，登记即幂等更新（开发方案 6.2）
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/growth-stages") {
        const plotCode = trimmed(url.searchParams, "plotCode");
        send(res, 200, await growth.list(plotCode || undefined), traceId);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/telemetry/growth-stages") {
        const parsed = parseGrowthStage(await json(req));
        if (!parsed.input) { send(res, 400, null, traceId, parsed.error ?? "生育期参数非法"); return; }
        send(res, 200, await growth.save(parsed.input), traceId);
        return;
      }

      const growthMatch = url.pathname.match(/^\/api\/v1\/telemetry\/growth-stages\/([^/]+)$/);
      if (growthMatch && req.method === "DELETE") {
        const id = decodeURIComponent(growthMatch[1] ?? "");
        if (!(await growth.remove(id))) { send(res, 404, null, traceId, "生育期档案不存在"); return; }
        send(res, 200, null, traceId);
        return;
      }

      // 灾情统计：按地块聚合灾种/等级与未归档受灾面积，供灾情页概览（开发方案 6.4）
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/disasters/stats") {
        const plotCode = trimmed(url.searchParams, "plotCode");
        send(res, 200, await disasters.stats(plotCode ? { plotCode } : {}), traceId);
        return;
      }

      // 灾情档案列表：地块/灾种/状态均为可选筛选
      if (req.method === "GET" && url.pathname === "/api/v1/telemetry/disasters") {
        const plotCode = trimmed(url.searchParams, "plotCode");
        const disasterType = trimmed(url.searchParams, "disasterType");
        const status = trimmed(url.searchParams, "status");
        const limit = Number(url.searchParams.get("size") ?? 100);
        send(res, 200, await disasters.list({ ...(plotCode ? { plotCode } : {}), ...(disasterType ? { disasterType } : {}), ...(status ? { status } : {}), limit }), traceId);
        return;
      }

      // 灾情上报：落库即 REPORTED，影像仅登记文件服务返回的引用
      if (req.method === "POST" && url.pathname === "/api/v1/telemetry/disasters") {
        const parsed = parseDisaster(await json(req));
        if (!parsed.input) { send(res, 400, null, traceId, parsed.error ?? "灾情参数非法"); return; }
        send(res, 201, await disasters.create(undefined, parsed.input), traceId);
        return;
      }

      // 灾情补充处置：推进状态并补录措施/损失评估/处置人，状态倒退拒绝
      const supplementMatch = url.pathname.match(/^\/api\/v1\/telemetry\/disasters\/([^/]+)\/supplement$/);
      if (supplementMatch && req.method === "POST") {
        const id = decodeURIComponent(supplementMatch[1] ?? "");
        const parsed = parseDisasterSupplement(await json(req));
        if (!parsed.input) { send(res, 400, null, traceId, parsed.error ?? "处置参数非法"); return; }
        const updated = await disasters.supplement(id, parsed.input);
        if (!updated) { send(res, 404, null, traceId, "灾情记录不存在或不允许状态回退"); return; }
        send(res, 200, updated, traceId);
        return;
      }

      const disasterMatch = url.pathname.match(/^\/api\/v1\/telemetry\/disasters\/([^/]+)$/);
      if (disasterMatch && req.method === "GET") {
        const record = await disasters.find(decodeURIComponent(disasterMatch[1] ?? ""));
        send(res, record ? 200 : 404, record, traceId, record ? "" : "灾情记录不存在");
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
export type { GrowthStage } from "./growth.repository.js";
export type { DisasterRecord, DisasterStats, DisasterStatus, DisasterType } from "./disaster.repository.js";
export type { TelemetryRule } from "./rule.repository.js";
export { breaches, DEFAULT_TELEMETRY_RULES } from "./rule.repository.js";
