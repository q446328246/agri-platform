import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import type { PrescriptionIssuedPayload } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import { OutboxService, InMemoryEventPublisher, InMemoryOutboxStore, publishEvent, setDefaultPublisher } from "@agri/mq";
import type { EventPublisher, OutboxStore } from "@agri/mq";
import { snowflakeId } from "@agri/shared";
import { authorizeRequest, identityHeaders } from "@agri/shared";

import { InMemoryPrescriptionRepository, SqlPrescriptionRepository } from "./prescription.repository.js";
import type { CreatePrescriptionInput, PrescriptionQuery, PrescriptionRecord, PrescriptionRepository, PrescriptionStatus } from "./prescription.repository.js";
import { newPrescriptionId } from "./prescription.repository.js";
import { InMemoryExecutionRepository } from "./execution.repository.js";
import type { ExecutionQuery, ExecutionRepository } from "./execution.repository.js";
import { evaluateOutcome, formatCondition, InMemoryOutcomeRepository, newOutcomeId } from "./outcome.repository.js";
import type { OutcomeRepository, PrescriptionOutcome } from "./outcome.repository.js";
import { optionalFiniteNumber, RuleEngine } from "./rule.engine.js";
import type { RuleEvaluationInput } from "./rule.engine.js";
import { defaultRule, InMemoryRuleRepository, isRuleType, normalizeAction, normalizeCondition } from "./rule.repository.js";
import type { CreateRuleInput, RuleRepository, RuleType, UpdateRuleInput } from "./rule.repository.js";
import { InMemoryKnowledgeRepository, SqlKnowledgeRepository, DEFAULT_KNOWLEDGE } from "./knowledge.repository.js";
import type { AgronomyKnowledge, KnowledgeCategory, KnowledgeInput, KnowledgeRepository } from "./knowledge.repository.js";
import { KNOWLEDGE_CATEGORIES, newKnowledgeId } from "./knowledge.repository.js";
import { InMemoryPredictionRepository, PREDICTION_LEVELS, PREDICTION_METRICS } from "./prediction.repository.js";
import type { PredictionLevel, PredictionMetric, PredictionRepository } from "./prediction.repository.js";
import type { AiChatClient, AiChatMessage } from "./ai.client.js";

const API_PREFIX = "/api/v1/decision";

export interface DecisionDependencies {
  rules?: RuleRepository;
  prescriptions?: PrescriptionRepository;
  outcomes?: OutcomeRepository;
  /** 处方执行回流：由消费结单事件写入，接口只做查询 */
  executions?: ExecutionRepository;
  outbox?: OutboxStore;
  /** SQL 留痕与消息表的事务边界；内存测试路径不提供原子性保证。 */
  withTransaction?: PrismaClientLike["$transaction"];
  /** 事件发布器：接入事件日志时由启动层注入，缺省进程内发布 */
  publisher?: EventPublisher;
  /** 处方生成时向遥测服务补齐最新墒情，缺省直接使用请求体中的数值 */
  fetchSoilMoisture?: (plotCode: string, identity: Record<string, string>) => Promise<number | undefined>;
  /** 处方生成时从天气预报取未来降雨概率，缺测时依赖降雨的规则不命中。 */
  fetchRainProbability?: (plotCode: string | undefined, identity: Record<string, string>) => Promise<number | undefined>;
  /**
   * 处方生成时从地块台账取面积（亩），供控制侧现算执行包络。
   * 只认地块服务的权威值，不接受请求体自报——面积直接决定阀门开多久，不能让调用方填。
   */
  fetchPlotArea?: (plotCode: string, identity: Record<string, string>) => Promise<number | undefined>;
  /** 农艺知识库（C4）：问答检索与知识条目维护；缺省内存实现 */
  knowledge?: KnowledgeRepository;
  /** AI 问答通道（C4 增强）：配置后 /ask 走检索增强生成，未配置或调用失败降级规则式回答 */
  ai?: AiChatClient;
  /** 预测台账（C3）：查询预测留痕，缺省内存实现 */
  predictions?: PredictionRepository;
  /** 预测扫描器（C3）：人工触发立即执行一轮，缺省不提供 */
  predictionSweeper?: { runOnce(): Promise<void> };
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

/** 解析农艺知识条目入参：分类白名单、必填字段、关键词非空 */
function parseKnowledgeInput(body: Record<string, unknown>): { input?: KnowledgeInput; error?: string } {
  const category = String(body.category ?? "");
  if (!KNOWLEDGE_CATEGORIES.includes(category as KnowledgeCategory)) {
    return { error: `category 需为 ${KNOWLEDGE_CATEGORIES.join("/")} 之一` };
  }
  const title = String(body.title ?? "").trim();
  if (!title) return { error: "title 不能为空" };
  const keywords = String(body.keywords ?? "").trim();
  if (!keywords) return { error: "keywords 不能为空（逗号分隔检索关键词）" };
  const content = String(body.content ?? "").trim();
  if (!content) return { error: "content 不能为空" };
  const input: KnowledgeInput = { category: category as KnowledgeCategory, title, keywords, content };
  const source = String(body.source ?? "").trim();
  if (source) input.source = source;
  if (body.enabled !== undefined) input.enabled = body.enabled === true || body.enabled === "true";
  const sort = Number(body.sort);
  if (Number.isFinite(sort)) input.sort = Math.max(0, Math.round(sort));
  return { input };
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

/** RAG 提示词：只允许基于检索到的知识条目与规则上下文作答，引用标注条目标题 */
function buildAskMessages(question: string, hits: AgronomyKnowledge[], matched: string): AiChatMessage[] {
  const knowledgeText = hits.length > 0
    ? hits.map((hit) => `【${hit.title}】${hit.content}${hit.source ? `（依据：${hit.source}）` : ""}`).join("\n")
    : "（无直接命中的农艺知识条目）";
  return [
    {
      role: "system",
      content: "你是无人农场 AI 平台的农艺助手。只依据提供的农艺知识条目与规则上下文用中文回答；引用知识时以【标题】标注条目；不得编造未提供的数值或口径；知识不足时说明还需要哪些信息。回答简洁、可执行。",
    },
    {
      role: "user",
      content: `农艺知识条目：\n${knowledgeText}\n\n当前地块最近命中规则：${matched || "无"}\n\n用户问题：${question}`,
    },
  ];
}

export function createDecisionHttpServer(dependencies?: Partial<DecisionDependencies>): Server {
  const rules = dependencies?.rules ?? new InMemoryRuleRepository([defaultRule(new Date().toISOString())]);
  const prescriptions = dependencies?.prescriptions ?? new InMemoryPrescriptionRepository();
  const outcomes = dependencies?.outcomes ?? new InMemoryOutcomeRepository();
  const executions = dependencies?.executions ?? new InMemoryExecutionRepository();
  const tenantId = dependencies?.tenantId ?? "tenant-demo";
  const knowledge = dependencies?.knowledge
    ?? new InMemoryKnowledgeRepository(DEFAULT_KNOWLEDGE.map((entry) => ({ ...entry, tenantId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })));
  const ai = dependencies?.ai;
  const predictions = dependencies?.predictions ?? new InMemoryPredictionRepository();
  const predictionSweeper = dependencies?.predictionSweeper;
  const engine = new RuleEngine(rules);
  const fetchSoilMoisture = dependencies?.fetchSoilMoisture;
  const fetchRainProbability = dependencies?.fetchRainProbability;
  const fetchPlotArea = dependencies?.fetchPlotArea;
  const publisher = dependencies?.publisher ?? new InMemoryEventPublisher();
  const outbox = dependencies?.outbox;
  const withTransaction = dependencies?.withTransaction;
  if (outbox && !(outbox instanceof InMemoryOutboxStore) && !withTransaction) {
    throw new Error("持久化 outbox 必须配置 withTransaction");
  }
  if (prescriptions instanceof SqlPrescriptionRepository && (!outbox || !withTransaction)) {
    throw new Error("SQL 处方仓储必须同时配置 outbox 与 withTransaction");
  }
  // 未注入事务的内存路径仅供测试，不保证留痕与发布原子性。
  const outboxService = outbox ? new OutboxService(outbox, publisher, { tenantId, traceId: "decision", producer: "decision" }) : undefined;
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
        const reportedSoil = optionalFiniteNumber(body.soilMoisture);
        const reportedRain = optionalFiniteNumber(body.rainProbability);
        const identity = identityHeaders(req);
        const liveSoil = reportedSoil === undefined && plotCode && fetchSoilMoisture
          ? optionalFiniteNumber(await fetchSoilMoisture(plotCode, identity).catch(() => undefined)) : undefined;
        const liveRain = reportedRain === undefined && fetchRainProbability
          ? optionalFiniteNumber(await fetchRainProbability(plotCode || undefined, identity).catch(() => undefined)) : undefined;
        const soilMoisture = reportedSoil ?? liveSoil;
        const rainProbability = reportedRain ?? liveRain;
        // 面积只从地块台账取，不接受请求体自报：它会被控制侧换算成阀门开启时长与计划水量
        const liveArea = plotCode && fetchPlotArea
          ? optionalFiniteNumber(await fetchPlotArea(plotCode, identity).catch(() => undefined)) : undefined;
        const areaMu = liveArea !== undefined && liveArea > 0 ? liveArea : undefined;
        const measurements = {
          ...(soilMoisture !== undefined ? { soilMoisture } : {}),
          ...(rainProbability !== undefined ? { rainProbability } : {}),
        };
        const growthStage = String(body.growthStage ?? "").trim();
        const evaluationInput: RuleEvaluationInput = { plotCode, plotName, growthStage, ...measurements };
        const { matchedRules, items } = await engine.evaluate(evaluationInput, now);
        const input: CreatePrescriptionInput = {
          id: newPrescriptionId(),
          plotCode,
          plotName,
          status: items.length > 0 ? "RECOMMENDED" : "NO_ACTION",
          ...measurements,
          growthStage,
          inputs: { plotCode, plotName, growthStage, ...measurements, soilMoistureSource: reportedSoil !== undefined ? "request" : liveSoil !== undefined ? "telemetry" : "missing", rainProbabilitySource: reportedRain !== undefined ? "request" : liveRain !== undefined ? "weather" : "missing", areaMuSource: areaMu !== undefined ? "plot" : "missing", ...(areaMu !== undefined ? { areaMu } : {}), requestedAt: now },
          matchedRules,
          actions: items,
          generatedAt: now,
        };
        const groups = new Map<PrescriptionIssuedPayload["planType"], PrescriptionIssuedPayload>();
        // 引擎保证 matchedRules 与 items 一一对应；按动作而非首条规则归类。
        matchedRules.forEach((rule, index) => {
          const item = items[index];
          if (!item || !isRuleType(rule.action.type)) throw new Error("处方动作与规则不一致");
          const planType = PLAN_TYPE_BY_RULE[rule.action.type];
          const payload: PrescriptionIssuedPayload = groups.get(planType) ?? { prescriptionId: input.id, parcelId: plotCode, seasonId: "", planType, ...(areaMu !== undefined ? { areaMu } : {}), items: [] };
          // 明细自带其网格的台账面积（D2 规则 A）：引擎明细 gridCode 即地块，面积取地块台账值；
          // 控制侧据此逐明细建分区，不再依赖整处方的单一 areaMu 猜分摊。
          payload.items.push(areaMu === undefined ? item : { ...item, areaMu });
          groups.set(planType, payload);
        });
        const save = async (tx: Tx | undefined): Promise<PrescriptionRecord> => {
          const record = await prescriptions.create(tx, input);
          // NO_ACTION 的分组为空，只留痕；所有非空分组与处方共用同一事务。
          if (outboxService) {
            for (const payload of groups.values()) {
              await outboxService.enqueue(tx, EventTopic.DecisionPrescriptionIssued, payload, { tenantId, traceId, producer: "decision" });
            }
          }
          return record;
        };
        const record = withTransaction ? await withTransaction(save) : await save(undefined);
        if (!outboxService) {
          // 仅供内存测试：直接发布不具有数据库事务保证。
          for (const payload of groups.values()) {
            await publishEvent({ topic: EventTopic.DecisionPrescriptionIssued, payload, tenantId, traceId, producer: "decision", key: plotCode }, publisher);
          }
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

      // 执行回流查询：处方下发后实际用了多少水肥、作业多久
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/executions`) {
        const prescriptionId = url.searchParams.get("prescriptionId") ?? undefined;
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const query: ExecutionQuery = {
          ...(prescriptionId ? { prescriptionId } : {}),
          ...(plotCode ? { plotCode } : {}),
          // 取满分页窗口上限再交给 page()，避免只拉一屏却报出全量总数
          limit: 200,
        };
        send(res, 200, page(await executions.list(query), url.searchParams), traceId);
        return;
      }

      // 智能问答（C4）：检索农艺知识库后交给 AI 生成回答（RAG），未配置 AI 或调用失败
      // 降级为知识库拼接/规则式回答；回答始终附当前地块最近命中的规则，保证建议可追溯
      if (req.method === "POST" && url.pathname === `${API_PREFIX}/ask`) {
        const body = await json(req);
        const question = String(body.question ?? "").trim();
        if (!question) { send(res, 400, null, traceId, "问题不能为空"); return; }
        const history = await prescriptions.listByPlot({ limit: 3 });
        const latest = history[0];
        const matched = latest?.matchedRules.map((rule) => rule.name).join("、") ?? "土壤含水率低于阈值补灌";
        const hits = await knowledge.search(tenantId, question);
        const sources = hits.length > 0 ? hits.map((hit) => hit.title) : matched.split("、").filter(Boolean);
        const confidence = hits.length > 0 ? 0.9 : 0.86;
        if (ai) {
          try {
            const answer = await ai.chat(buildAskMessages(question, hits, matched));
            send(res, 200, { answer, sources, confidence, mode: "ai" }, traceId);
            return;
          } catch {
            // AI 不可用不中断问答，落回下方规则式回答
          }
        }
        if (hits.length > 0) {
          const answer = hits.map((hit) => `【${hit.title}】${hit.content}`).join("\n");
          const ruleRef = matched ? `\n当前地块最近命中规则：${matched}。` : "";
          send(res, 200, { answer: answer + ruleRef, sources, confidence, mode: "rule" }, traceId);
          return;
        }
        const answer = question.includes("灌溉")
          ? `建议先查看地块土壤含水率与未来三天降雨概率；含水率低于 30% 且无明显降雨时生成补灌处方，最近命中的规则为：${matched}。`
          : `请提供地块、作物生育期或监测指标，我会结合当前规则给出可追溯建议；最近一次评估命中规则：${matched}。`;
        send(res, 200, { answer, sources, confidence, mode: "rule" }, traceId);
        return;
      }

      // 农艺知识库管理（C4）：列表读取走全局决策读权限，写入需决策知识库维护权限
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/knowledge`) {
        send(res, 200, page(await knowledge.list(tenantId), url.searchParams), traceId);
        return;
      }

      if (req.method === "POST" && url.pathname === `${API_PREFIX}/knowledge`) {
        const knowledgeDenied = authorizeRequest(req, { read: "decision:read", write: "decision:knowledge" });
        if (knowledgeDenied) { send(res, knowledgeDenied.status, null, traceId, knowledgeDenied.message); return; }
        const body = await json(req);
        const input = parseKnowledgeInput(body);
        if (input.error) { send(res, 400, null, traceId, input.error); return; }
        const saved = await knowledge.save(tenantId, newKnowledgeId(), input.input!);
        send(res, 201, saved, traceId);
        return;
      }

      if (req.method === "PUT" && url.pathname.startsWith(`${API_PREFIX}/knowledge/`)) {
        const knowledgeDenied = authorizeRequest(req, { read: "decision:read", write: "decision:knowledge" });
        if (knowledgeDenied) { send(res, knowledgeDenied.status, null, traceId, knowledgeDenied.message); return; }
        const id = url.pathname.slice(`${API_PREFIX}/knowledge/`.length).trim();
        if (!id) { send(res, 400, null, traceId, "知识条目标识不能为空"); return; }
        const body = await json(req);
        const input = parseKnowledgeInput(body);
        if (input.error) { send(res, 400, null, traceId, input.error); return; }
        const saved = await knowledge.save(tenantId, id, input.input!);
        send(res, 200, saved, traceId);
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith(`${API_PREFIX}/knowledge/`)) {
        const knowledgeDenied = authorizeRequest(req, { read: "decision:read", write: "decision:knowledge" });
        if (knowledgeDenied) { send(res, knowledgeDenied.status, null, traceId, knowledgeDenied.message); return; }
        const id = url.pathname.slice(`${API_PREFIX}/knowledge/`.length).trim();
        if (!id) { send(res, 400, null, traceId, "知识条目标识不能为空"); return; }
        if (!(await knowledge.remove(tenantId, id))) { send(res, 404, null, traceId, "知识条目不存在"); return; }
        send(res, 200, { removed: id }, traceId);
        return;
      }

      // 预测台账（C3）：按地块/指标/等级查询预测留痕
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/predictions`) {
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const metric = url.searchParams.get("metric") ?? undefined;
        const level = url.searchParams.get("level") ?? undefined;
        if (metric !== undefined && !PREDICTION_METRICS.includes(metric as PredictionMetric)) {
          send(res, 400, null, traceId, `metric 需为 ${PREDICTION_METRICS.join("/")} 之一`);
          return;
        }
        if (level !== undefined && !PREDICTION_LEVELS.includes(level as PredictionLevel)) {
          send(res, 400, null, traceId, `level 需为 ${PREDICTION_LEVELS.join("/")} 之一`);
          return;
        }
        const records = await predictions.list({
          ...(plotCode ? { plotCode } : {}),
          ...(metric ? { metric: metric as PredictionMetric } : {}),
          ...(level ? { level: level as PredictionLevel } : {}),
          limit: Number(url.searchParams.get("size") ?? 20),
        });
        send(res, 200, page(records, url.searchParams), traceId);
        return;
      }

      // 人工触发：立即执行一轮全量预测，与定时扫描同一入口
      if (req.method === "POST" && url.pathname === `${API_PREFIX}/predictions/run`) {
        if (!predictionSweeper) { send(res, 400, null, traceId, "预测扫描器未配置"); return; }
        await predictionSweeper.runOnce();
        send(res, 200, { status: "ok" }, traceId);
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
