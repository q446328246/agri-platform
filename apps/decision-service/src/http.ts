import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import type { PrescriptionIssuedPayload } from "@agri/contracts";
import { OutboxService, InMemoryEventPublisher, InMemoryOutboxStore, publishEvent, setDefaultPublisher } from "@agri/mq";
import type { EventPublisher, OutboxStore } from "@agri/mq";
import { snowflakeId } from "@agri/shared";
import { authorizeRequest, identityHeaders } from "@agri/shared";

import { InMemoryPrescriptionRepository } from "./prescription.repository.js";
import type { CreatePrescriptionInput, PrescriptionQuery, PrescriptionRecord, PrescriptionRepository, PrescriptionStatus } from "./prescription.repository.js";
import { newPrescriptionId } from "./prescription.repository.js";
import { evaluateOutcome, formatCondition, InMemoryOutcomeRepository, newOutcomeId } from "./outcome.repository.js";
import type { OutcomeRepository, PrescriptionOutcome } from "./outcome.repository.js";
import { RuleEngine } from "./rule.engine.js";
import type { RuleEvaluationInput } from "./rule.engine.js";
import { defaultRule, InMemoryRuleRepository, isRuleType, normalizeAction, normalizeCondition } from "./rule.repository.js";
import type { CreateRuleInput, RuleRepository, RuleType, UpdateRuleInput } from "./rule.repository.js";

const API_PREFIX = "/api/v1/decision";

export interface DecisionDependencies {
  rules?: RuleRepository;
  prescriptions?: PrescriptionRepository;
  outcomes?: OutcomeRepository;
  outbox?: OutboxStore;
  /** 事件发布器：接入事件日志时由启动层注入，缺省进程内发布 */
  publisher?: EventPublisher;
  /** 处方生成时向遥测服务补齐最新墒情，缺省直接使用请求体中的数值 */
  fetchSoilMoisture?: (plotCode: string, identity: Record<string, string>) => Promise<number | undefined>;
  /** 处方生成时从天气预报取未来降雨概率，缺省使用请求体或 0 */
  fetchRainProbability?: (plotCode: string | undefined, identity: Record<string, string>) => Promise<number | undefined>;
  tenantId?: string;
}


function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `DECISION-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function trace(req: IncomingMessage): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function page<T>(items: T[], query: URLSearchParams): PageResult<T> {
  const current = Math.max(1, Number(query.get("page") ?? 1) || 1);
  const size = Math.min(200, Math.max(1, Number(query.get("size") ?? 20) || 20));
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), total: items.length, page: current, size, pages: Math.ceil(items.length / size) };
}

function rulePayload(body: Record<string, unknown>): Omit<CreateRuleInput, "id" | "createdAt" | "updatedAt"> {
  const type: RuleType = isRuleType(body.type) ? body.type : "IRRIGATION";
  return {
    name: String(body.name ?? body.ruleName ?? "未命名规则"),
    type,
    expression: String(body.expression ?? ""),
    priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 100,
    condition: normalizeCondition(body.condition),
    action: normalizeAction(body.action ?? body.actions, type),
    enabled: body.enabled !== false,
  };
}

/** 规则命中后的处方动作类型映射，用于接口响应与事件载荷 */
const PLAN_TYPE_BY_RULE: Record<RuleType, "irrigation" | "fertilization" | "pesticide"> = {
  IRRIGATION: "irrigation",
  FERTILIZATION: "fertilization",
  PEST_WARNING: "pesticide",
};

export function createDecisionHttpServer(dependencies?: Partial<DecisionDependencies>): Server {
  const rules = dependencies?.rules ?? new InMemoryRuleRepository([defaultRule(new Date().toISOString())]);
  const prescriptions = dependencies?.prescriptions ?? new InMemoryPrescriptionRepository();
  const outcomes = dependencies?.outcomes ?? new InMemoryOutcomeRepository();
  const tenantId = dependencies?.tenantId ?? "tenant-demo";
  const engine = new RuleEngine(rules);
  const fetchSoilMoisture = dependencies?.fetchSoilMoisture;
  const fetchRainProbability = dependencies?.fetchRainProbability;
  const publisher = dependencies?.publisher ?? new InMemoryEventPublisher();
  const outbox = dependencies?.outbox;
  // 有本地消息表时先落表再由中继投递；无表时直接进程内发布，便于本地联调
  const outboxService = new OutboxService(outbox ?? new InMemoryOutboxStore(), publisher, { tenantId, traceId: "decision", producer: "decision" });
  setDefaultPublisher(publisher);

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "decision" }, traceId); return; }
      const denied = authorizeRequest(req, { read: "decision:read", write: "decision:write" });
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 规则列表：读取最新规则集，支持分页
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/rules`) {
        const all = await rules.list();
        send(res, 200, page(all, url.searchParams), traceId);
        return;
      }

      // 新增规则：写入后立即参与下一次求值（规则热更新）
      if (req.method === "POST" && url.pathname === `${API_PREFIX}/rules`) {
        const body = await json(req);
        const now = new Date().toISOString();
        const input = rulePayload(body);
        if (!input.name.trim()) { send(res, 400, null, traceId, "规则名称不能为空"); return; }
        const rule = await rules.create({ ...input, id: snowflakeId(), createdAt: now, updatedAt: now });
        send(res, 201, rule, traceId);
        return;
      }

      const ruleMatch = url.pathname.match(/^\/api\/v1\/decision\/rules\/([^/]+)$/);
      const ruleId = ruleMatch?.[1] ? decodeURIComponent(ruleMatch[1]) : undefined;
      if (ruleId && req.method === "GET") {
        const rule = await rules.findById(ruleId);
        if (!rule) { send(res, 404, null, traceId, "规则不存在"); return; }
        send(res, 200, rule, traceId);
        return;
      }
      if (ruleId && req.method === "PUT") {
        const body = await json(req);
        const patch: UpdateRuleInput = { updatedAt: new Date().toISOString() };
        if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
        if (isRuleType(body.type)) patch.type = body.type;
        if (body.enabled !== undefined) patch.enabled = body.enabled !== false;
        if (typeof body.expression === "string") patch.expression = body.expression;
        if (body.priority !== undefined && Number.isFinite(Number(body.priority))) patch.priority = Number(body.priority);
        if (body.condition !== undefined && typeof body.condition === "object") patch.condition = normalizeCondition(body.condition);
        if (body.action !== undefined && typeof body.action === "object") patch.action = normalizeAction(body.action, patch.type ?? "IRRIGATION");
        const rule = await rules.update(ruleId, patch);
        if (!rule) { send(res, 404, null, traceId, "规则不存在"); return; }
        send(res, 200, rule, traceId);
        return;
      }
      if (ruleId && req.method === "DELETE") {
        const removed = await rules.remove(ruleId, new Date().toISOString());
        if (!removed) { send(res, 404, null, traceId, "规则不存在"); return; }
        send(res, 200, null, traceId);
        return;
      }

      // 处方历史：按地块与状态查询，展示留痕的输入数据与命中规则
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/prescriptions`) {
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        const query: PrescriptionQuery = {
          ...(plotCode ? { plotCode } : {}),
          ...(status === "RECOMMENDED" || status === "NO_ACTION" ? { status } : {}),
          limit: Number(url.searchParams.get("size") ?? 20),
        };
        const records = await prescriptions.listByPlot(query);
        send(res, 200, page(records, url.searchParams), traceId);
        return;
      }

      // 处方生成：加载最新规则求值，记录输入数据与命中规则，并通过本地消息表发布事件
      if (req.method === "POST" && url.pathname === `${API_PREFIX}/prescriptions`) {
        const body = await json(req);
        const now = new Date().toISOString();
        const plotCode = String(body.plotCode ?? body.parcelCode ?? "").trim();
        const plotName = String(body.plotName ?? "").trim();
        const reportedSoil = Number(body.soilMoisture);
        const reportedRain = Number(body.rainProbability);
        const identity = identityHeaders(req);
        const liveSoil = plotCode ? await fetchSoilMoisture?.(plotCode, identity) : undefined;
        const liveRain = !Number.isFinite(reportedRain) && fetchRainProbability ? await fetchRainProbability(plotCode || undefined, identity) : undefined;
        const soilMoisture = Number.isFinite(reportedSoil) ? reportedSoil : liveSoil ?? 100;
        const rainProbability = Number.isFinite(reportedRain) ? reportedRain : liveRain ?? 0;
        const growthStage = String(body.growthStage ?? "").trim();
        const evaluationInput: RuleEvaluationInput = { plotCode, plotName, growthStage, soilMoisture, rainProbability };
        const { matchedRules, items } = await engine.evaluate(evaluationInput, now);
        const input: CreatePrescriptionInput = {
          id: newPrescriptionId(),
          plotCode,
          plotName,
          status: items.length > 0 ? "RECOMMENDED" : "NO_ACTION",
          soilMoisture,
          rainProbability,
          growthStage,
          inputs: { plotCode, plotName, growthStage, soilMoisture, rainProbability, soilMoistureSource: Number.isFinite(reportedSoil) ? "request" : liveSoil !== undefined ? "telemetry" : "default", rainProbabilitySource: Number.isFinite(reportedRain) ? "request" : liveRain !== undefined ? "weather" : "default", requestedAt: now },
          matchedRules,
          actions: items,
          generatedAt: now,
        };
        const record = await prescriptions.create(undefined, input);
        const planType = matchedRules.length > 0 && isRuleType(matchedRules[0]?.action.type) ? PLAN_TYPE_BY_RULE[matchedRules[0]!.action.type] : "irrigation";
        const payload: PrescriptionIssuedPayload = { parcelId: plotCode, seasonId: "", planType, items };
        if (outbox) {
          // 处方与事件同事务写入本地消息表，事务提交后由中继投递，保证留痕与通知一致
          await outboxService.enqueue(undefined, EventTopic.DecisionPrescriptionIssued, payload, { tenantId, traceId, producer: "decision" });
        } else {
          await publishEvent({ topic: EventTopic.DecisionPrescriptionIssued, payload, tenantId, traceId, producer: "decision", key: plotCode }, publisher);
        }
        send(res, 201, record, traceId);
        return;
      }

      // 效果回流：记录处方执行后的实测效果，可选把阈值建议写回规则
      const outcomeMatch = url.pathname.match(/^\/api\/v1\/decision\/prescriptions\/([^/]+)\/outcome$/);
      const outcomeId = outcomeMatch?.[1] ? decodeURIComponent(outcomeMatch[1]) : undefined;
      if (outcomeId && req.method === "GET") {
        const outcome = await outcomes.findLatest(outcomeId);
        if (!outcome) { send(res, 404, null, traceId, "尚未记录效果评估"); return; }
        send(res, 200, outcome, traceId);
        return;
      }
      if (outcomeId && req.method === "POST") {
        const body = await json(req);
        const after = Number(body.soilMoistureAfter);
        if (!Number.isFinite(after)) { send(res, 400, null, traceId, "soilMoistureAfter 必须是数字"); return; }
        const prescription = await prescriptions.findById(outcomeId);
        if (!prescription) { send(res, 404, null, traceId, "处方不存在"); return; }
        const now = new Date().toISOString();
        const ruleId = prescription.matchedRules[0]?.id;
        const rule = ruleId ? await rules.findById(ruleId) : null;
        const target = Number(body.target);
        const evaluation = evaluateOutcome({
          prescription,
          ...(rule ? { rule } : {}),
          soilMoistureAfter: after,
          ...(Number.isFinite(target) ? { target } : {}),
          evaluatedAt: now,
        });
        // 建议写回规则即完成规则调优：条件与展示表达式同时更新，保持可解释
        let appliedRule = null;
        if (evaluation.suggestion && body.applySuggestion === true && rule) {
          const condition = { ...rule.condition, soilMoistureBelow: evaluation.suggestion.suggestedThreshold };
          appliedRule = await rules.update(evaluation.suggestion.ruleId, { condition, expression: formatCondition(condition), updatedAt: now });
        }
        const outcome: PrescriptionOutcome = {
          id: newOutcomeId(),
          prescriptionId: prescription.id,
          plotCode: prescription.plotCode,
          ...(ruleId ? { ruleId } : {}),
          soilMoistureBefore: evaluation.soilMoistureBefore,
          soilMoistureAfter: after,
          target: evaluation.target,
          delta: evaluation.delta,
          effective: evaluation.effective,
          ...(evaluation.suggestion ? { suggestion: evaluation.suggestion } : {}),
          applied: appliedRule !== null,
          note: String(body.note ?? ""),
          evaluatedAt: now,
        };
        await outcomes.create(outcome);
        send(res, 201, { outcome, rule: appliedRule }, traceId);
        return;
      }

      // 智能问答：结合处方留痕给出可追溯建议
      if (req.method === "POST" && url.pathname === `${API_PREFIX}/ask`) {
        const body = await json(req);
        const question = String(body.question ?? "");
        const history = await prescriptions.listByPlot({ limit: 3 });
        const latest = history[0];
        const matched = latest?.matchedRules.map((rule) => rule.name).join("、") ?? "土壤含水率低于阈值补灌";
        const answer = question.includes("灌溉")
          ? `建议先查看地块土壤含水率与未来三天降雨概率；含水率低于 30% 且无明显降雨时生成补灌处方，最近命中的规则为：${matched}。`
          : `请提供地块、作物生育期或监测指标，我会结合当前规则给出可追溯建议；最近一次评估命中规则：${matched}。`;
        send(res, 200, { answer, sources: matched.split("、").filter(Boolean), confidence: 0.86 }, traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}

/** 处方记录类型转出，便于前端与测试共用 */
export type { PrescriptionRecord };
