import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import { authorizeRequest } from "@agri/shared";

import { InMemoryTractorJobRepository, TRACTOR_OPERATION_TYPES, TRACTOR_JOB_STATUSES } from "./job.repository.js";
import type { TractorJob, TractorJobRepository, TractorJobStage, TractorOperationType } from "./job.repository.js";
import { InMemoryTractorSafetyEventRepository, TRACTOR_SAFETY_KINDS } from "./safety-event.repository.js";
import type { TractorSafetyEvent, TractorSafetyEventRepository } from "./safety-event.repository.js";
import type { JobExecutor } from "./executor.js";
import { buildJobStages } from "./plan.js";
import type { PlanOptions } from "./plan.js";
import type { SafetyGateResult } from "./safety.js";

const API_PREFIX = "/api/v1/tractor";

/** 作业前预检数据源：由组合根注入，从设备/地块/控制/遥测服务实时取数 */
export interface TractorPrecheckResult {
  passed: boolean;
  gates: SafetyGateResult[];
  tenantId: string;
}

export interface TractorHttpDependencies {
  jobs?: TractorJobRepository;
  safetyEvents?: TractorSafetyEventRepository;
  executor?: JobExecutor;
  /** 作业前安全预检；缺省直接放行（仅供内存测试） */
  precheck?: (input: { plotCode: string; deviceId: string; operator: string }) => Promise<TractorPrecheckResult>;
  /** 作业计划参数（机具编码、超时等） */
  planOptions?: PlanOptions;
  tenantId?: string;
}

function send<T>(res: ServerResponse, status: number, data: T | null, traceId: string, message = ""): void {
  const body: ApiResponse<T> = { code: status >= 400 ? `TRACTOR-${status}` : "OK", message, data, traceId, timestamp: Date.now() };
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

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const TRACTOR_POLICY = { read: "tractor:read", write: "tractor:write" };

export function createTractorHttpServer(dependencies?: Partial<TractorHttpDependencies>): Server {
  const jobs = dependencies?.jobs ?? new InMemoryTractorJobRepository();
  const safetyEvents = dependencies?.safetyEvents ?? new InMemoryTractorSafetyEventRepository();
  const executor = dependencies?.executor;
  const precheck = dependencies?.precheck;
  const planOptions = dependencies?.planOptions;
  const tenantId = dependencies?.tenantId ?? "tenant-demo";

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "tractor" }, traceId); return; }
      const denied = authorizeRequest(req, TRACTOR_POLICY);
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 下发作业：安全预检 → 计划生成 → 落作业与分步 → 启动执行
      if (req.method === "POST" && url.pathname === `${API_PREFIX}/jobs`) {
        const body = await json(req);
        const plotCode = text(body.plotCode);
        const deviceId = text(body.deviceId);
        const operationType = text(body.operationType) as TractorOperationType;
        const operator = text(req.headers["x-user-id"]);
        if (!plotCode) { send(res, 400, null, traceId, "plotCode 不能为空"); return; }
        if (!deviceId) { send(res, 400, null, traceId, "deviceId 不能为空"); return; }
        if (!TRACTOR_OPERATION_TYPES.includes(operationType)) { send(res, 400, null, traceId, `operationType 需为 ${TRACTOR_OPERATION_TYPES.join("/")} 之一`); return; }
        const parameters = body.parameters && typeof body.parameters === "object" ? (body.parameters as Record<string, unknown>) : {};

        // 安全验证：预检不过不排程，留安全事件并回给调用方
        if (precheck) {
          const result = await precheck({ plotCode, deviceId, operator });
          if (!result.passed) {
            const failed = result.gates.filter((gate) => !gate.passed);
            await safetyEvents.create(undefined, {
              tenantId: result.tenantId,
              plotCode,
              deviceId,
              kind: "PRECHECK_FAIL",
              level: "WARNING",
              message: `作业前预检未通过：${failed.map((gate) => gate.message).join("；")}`,
            });
            send(res, 409, null, traceId, `作业前安全预检未通过：${failed.map((gate) => gate.message).join("；")}`);
            return;
          }
        }

        // 计划算法：分步指令序列，参数不满足包络口径直接拒绝
        let stages;
        try {
          stages = buildJobStages(operationType, parameters, planOptions);
        } catch (error) {
          send(res, 400, null, traceId, error instanceof Error ? error.message : "作业参数非法");
          return;
        }
        const job = await jobs.createJob(undefined, {
          tenantId, plotCode, deviceId, operationType, parameters, operator,
          reason: text(body.reason) || "人工下发作业",
        });
        for (const stage of stages) {
          await jobs.addStage(undefined, { jobId: job.id, stage: stage.stage, commandType: stage.commandType, timeoutMs: stage.timeoutMs });
        }
        // 执行在后台推进，接口立即返回排程结果
        if (executor) void executor.run(job);
        send(res, 201, job, traceId);
        return;
      }

      // 作业列表：按地块/设备/状态筛选
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/jobs`) {
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const deviceId = url.searchParams.get("deviceId") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        if (status !== undefined && !TRACTOR_JOB_STATUSES.includes(status as TractorJob["status"])) {
          send(res, 400, null, traceId, `status 需为 ${TRACTOR_JOB_STATUSES.join("/")} 之一`);
          return;
        }
        const records = await jobs.listJobs({
          ...(plotCode ? { plotCode } : {}),
          ...(deviceId ? { deviceId } : {}),
          ...(status ? { status: status as TractorJob["status"] } : {}),
          limit: Number(url.searchParams.get("size") ?? 20),
        });
        send(res, 200, page(records, url.searchParams), traceId);
        return;
      }

      // 作业详情：作业 + 分步指令序列（stop/resume 子路径共用同一作业标识提取）
      const jobMatch = url.pathname.match(/^\/api\/v1\/tractor\/jobs\/([^/]+)(?:\/(?:stop|resume))?$/);
      const jobId = jobMatch?.[1] ? decodeURIComponent(jobMatch[1]) : undefined;
      if (jobId && req.method === "GET" && url.pathname === `${API_PREFIX}/jobs/${jobId}`) {
        const job = await jobs.findJob(jobId);
        if (!job) { send(res, 404, null, traceId, "作业不存在"); return; }
        const stages = await jobs.listStages(job.id);
        send(res, 200, { job, stages }, traceId);
        return;
      }

      // 人工处置：暂停或急停（急停为安全事件）
      if (jobId && req.method === "POST" && url.pathname === `${API_PREFIX}/jobs/${jobId}/stop`) {
        if (!executor) { send(res, 400, null, traceId, "作业执行器未配置"); return; }
        const body = await json(req);
        const job = await executor.stop(jobId, body.emergency === true);
        if (!job) { send(res, 404, null, traceId, "作业不存在或不在作业中/暂停态"); return; }
        send(res, 200, job, traceId);
        return;
      }

      // 恢复作业：重新安全预检，通过后从断点续跑
      if (jobId && req.method === "POST" && url.pathname === `${API_PREFIX}/jobs/${jobId}/resume`) {
        if (!executor || !precheck) { send(res, 400, null, traceId, "执行器或预检未配置"); return; }
        const job = await jobs.findJob(jobId);
        if (!job) { send(res, 404, null, traceId, "作业不存在"); return; }
        const result = await precheck({ plotCode: job.plotCode, deviceId: job.deviceId, operator: job.operator });
        if (!result.passed) {
          const failed = result.gates.filter((gate) => !gate.passed);
          await safetyEvents.create(undefined, {
            tenantId: result.tenantId,
            jobId: job.id,
            plotCode: job.plotCode,
            deviceId: job.deviceId,
            kind: "PRECHECK_FAIL",
            level: "WARNING",
            message: `恢复作业预检未通过：${failed.map((gate) => gate.message).join("；")}`,
          });
          send(res, 409, null, traceId, `恢复作业预检未通过：${failed.map((gate) => gate.message).join("；")}`);
          return;
        }
        void executor.run(job);
        send(res, 200, job, traceId);
        return;
      }

      // 安全事件列表：按作业/地块/类型筛选
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/safety-events`) {
        const jobId = url.searchParams.get("jobId") ?? undefined;
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const kind = url.searchParams.get("kind") ?? undefined;
        if (kind !== undefined && !TRACTOR_SAFETY_KINDS.includes(kind as TractorSafetyEvent["kind"])) {
          send(res, 400, null, traceId, `kind 需为 ${TRACTOR_SAFETY_KINDS.join("/")} 之一`);
          return;
        }
        const events = await safetyEvents.list({
          ...(jobId ? { jobId } : {}),
          ...(plotCode ? { plotCode } : {}),
          ...(kind ? { kind: kind as TractorSafetyEvent["kind"] } : {}),
          limit: Number(url.searchParams.get("size") ?? 20),
        });
        send(res, 200, page(events, url.searchParams), traceId);
        return;
      }

      send(res, 404, null, traceId, "接口不存在");
    } catch (error) {
      // 等保错误处理：生产环境不泄露内部细节
      const detail = process.env.NODE_ENV === "production" ? "请求处理失败" : (error instanceof Error ? error.message : "请求处理失败");
      send(res, 400, null, traceId, detail);
    }
  });
}

export type { TractorJob, TractorJobStage };
