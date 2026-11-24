import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiResponse, PageResult } from "@agri/contracts";
import type { Tx } from "@agri/db";
import { authorizeRequest } from "@agri/shared";

import { InMemoryTractorJobRepository, TRACTOR_OPERATION_TYPES, TRACTOR_JOB_STATUSES } from "./job.repository.js";
import type { TractorJob, TractorJobRepository, TractorJobStage, TractorOperationType, TractorStageKind } from "./job.repository.js";
import { InMemoryTractorSafetyEventRepository, TRACTOR_SAFETY_KINDS } from "./safety-event.repository.js";
import type { TractorSafetyEvent, TractorSafetyEventRepository } from "./safety-event.repository.js";
import { InMemoryTrajectoryRepository } from "./trajectory.repository.js";
import type { TrajectoryPoint, TrajectoryRepository } from "./trajectory.repository.js";
import type { TrajectoryDraft } from "./trajectory.js";
import type { JobExecutor } from "./executor.js";
import { TractorCommandError } from "./executor.js";
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
  precheck?: (input: { tenantId: string; plotCode: string; deviceId: string; operator: string; allowCommandId?: string; stageKind?: TractorStageKind }) => Promise<TractorPrecheckResult>;
  /** 作业计划参数（机具编码、超时等） */
  planOptions?: PlanOptions;
  /** 轨迹台账；缺省空内存实现 */
  trajectories?: TrajectoryRepository;
  /** 轨迹规划：直接传点走 MANUAL、传幅宽走 AUTO；缺省不建轨迹 */
  trajectoryPlanner?: (input: { tenantId: string; plotCode: string; implementWidthM?: number; explicitPath?: TrajectoryPoint[] }) => Promise<TrajectoryDraft | null>;
  /** SQL 组合根注入；作业、轨迹与分步在同一事务提交 */
  transaction?: <T>(handler: (tx: Tx) => Promise<T>) => Promise<T>;
  /** 请求未带 x-tenant-id 时的缺省租户 */
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

function requestTenant(req: IncomingMessage, fallback: string): string {
  const value = req.headers["x-tenant-id"];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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

/**
 * 解析直接传入的轨迹点：接受 `trajectory.path`（[经度, 纬度] 序列）或直接是坐标数组。
 * 少于 2 个点不成一条路径，返回 undefined 表示未传（交由幅宽走自动算）。
 */
function parseTrajectoryPath(raw: unknown): TrajectoryPoint[] | undefined {
  if (raw === undefined) return undefined;
  const coordinates = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).path) ? (raw as Record<string, unknown>).path : undefined);
  if (!Array.isArray(coordinates)) throw new Error("trajectory 需为 [经度, 纬度] 数组或含 path 的对象");
  const points: TrajectoryPoint[] = [];
  for (const item of coordinates) {
    if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== "number" || typeof item[1] !== "number") throw new Error("trajectory.path 每个点需包含数值型经度和纬度");
    const lng = item[0];
    const lat = item[1];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("trajectory.path 经纬度必须为有限数值");
    points.push([lng, lat]);
  }
  if (points.length < 2) throw new Error("trajectory.path 至少需要 2 个轨迹点");
  return points;
}

/** 农具幅宽（米）：自动算轨迹时必填，越界直接拒绝，不猜一个幅宽去铺作业带 */
function readImplementWidth(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 50) {
    throw new Error("implementWidthM（农具幅宽，米）需在 0~50 之间");
  }
  return parsed;
}

const TRACTOR_POLICY = { read: "tractor:read", write: "tractor:write" };

export function createTractorHttpServer(dependencies?: Partial<TractorHttpDependencies>): Server {
  const jobs = dependencies?.jobs ?? new InMemoryTractorJobRepository();
  const safetyEvents = dependencies?.safetyEvents ?? new InMemoryTractorSafetyEventRepository();
  const executor = dependencies?.executor;
  const precheck = dependencies?.precheck;
  const planOptions = dependencies?.planOptions;
  const trajectories = dependencies?.trajectories ?? new InMemoryTrajectoryRepository();
  const trajectoryPlanner = dependencies?.trajectoryPlanner;
  const transaction = dependencies?.transaction;
  const defaultTenantId = dependencies?.tenantId ?? "tenant-demo";

  return createServer(async (req, res) => {
    const traceId = trace(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const tenantId = requestTenant(req, defaultTenantId);
    try {
      if (req.method === "GET" && url.pathname === "/health") { send(res, 200, { status: "ok", service: "tractor" }, traceId); return; }
      const denied = authorizeRequest(req, TRACTOR_POLICY);
      if (denied) { send(res, denied.status, null, traceId, denied.message); return; }

      // 下发作业：安全预检 → 计划生成 → 单事务落作业/轨迹/分步 → 启动执行
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
        const explicitPath = parseTrajectoryPath(body.trajectory);
        const implementWidthM = readImplementWidth(body.implementWidthM);

        if (precheck) {
          const result = await precheck({ tenantId, plotCode, deviceId, operator });
          if (result.tenantId !== tenantId) { send(res, 403, null, traceId, "安全预检租户与请求租户不一致"); return; }
          if (!result.passed) {
            const failed = result.gates.filter((gate) => !gate.passed);
            await safetyEvents.create(undefined, {
              tenantId,
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

        let stages;
        try {
          stages = buildJobStages(operationType, parameters, planOptions);
        } catch (error) {
          send(res, 400, null, traceId, error instanceof Error ? error.message : "作业参数非法");
          return;
        }
        let plannedTrajectory: TrajectoryDraft | null = null;
        if (trajectoryPlanner) {
          try {
            plannedTrajectory = await trajectoryPlanner({
              tenantId,
              plotCode,
              ...(implementWidthM !== undefined ? { implementWidthM } : {}),
              ...(explicitPath !== undefined ? { explicitPath } : {}),
            });
          } catch (error) {
            send(res, 400, null, traceId, error instanceof Error ? error.message : "作业轨迹规划失败");
            return;
          }
        }
        // 作业参数 durationMin 是指令与超时的唯一权威值；轨迹展示同步该值，AUTO 估算差异仅作提示。
        const durationMin = Number(parameters.durationMin);
        const trajectoryDraft: TrajectoryDraft | null = plannedTrajectory ? {
          ...plannedTrajectory,
          durationMin,
          warnings: plannedTrajectory.source === "AUTO" && plannedTrajectory.durationMin !== durationMin
            ? [...plannedTrajectory.warnings, `轨迹估算 ${plannedTrajectory.durationMin} 分钟，执行按作业参数 ${durationMin} 分钟`]
            : plannedTrajectory.warnings,
        } : null;

        let createdJobId: string | undefined;
        let job: TractorJob;
        try {
          const persist = async (tx: Tx | undefined): Promise<TractorJob> => {
            const created = await jobs.createJob(tx, {
              tenantId, plotCode, deviceId, operationType, parameters, operator,
              reason: text(body.reason) || "人工下发作业",
            });
            createdJobId = created.id;
            if (trajectoryDraft) {
              const trajectory = await trajectories.create(tx, { jobId: created.id, tenantId, plotCode, ...trajectoryDraft });
              const operationStage = stages.find((stage) => stage.stage === "OPERATION");
              if (operationStage) operationStage.parameters = { ...operationStage.parameters, path: trajectory.path };
            }
            for (const stage of stages) {
              await jobs.addStage(tx, {
                tenantId,
                jobId: created.id, stage: stage.stage, commandType: stage.commandType,
                parameters: stage.parameters, timeoutMs: stage.timeoutMs,
              });
            }
            return created;
          };
          job = transaction ? await transaction(persist) : await persist(undefined);
        } catch (error) {
          // 内存降级没有跨仓储事务：把已建作业明确收口为 FAILED，绝不返回成功的 PLANNED 孤儿。
          if (createdJobId && !transaction) {
            await jobs.updateJob(tenantId, createdJobId, { status: "FAILED", reason: "建单失败，作业未完整落库" }, { expectedStatus: "PLANNED" }).catch(() => {});
          }
          throw error;
        }
        if (executor) void executor.run(job);
        send(res, 201, job, traceId);
        return;
      }

      // 作业列表：租户 + 地块/设备/状态筛选
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/jobs`) {
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const deviceId = url.searchParams.get("deviceId") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        if (status !== undefined && !TRACTOR_JOB_STATUSES.includes(status as TractorJob["status"])) {
          send(res, 400, null, traceId, `status 需为 ${TRACTOR_JOB_STATUSES.join("/")} 之一`);
          return;
        }
        const records = await jobs.listJobs({
          tenantId,
          ...(plotCode ? { plotCode } : {}),
          ...(deviceId ? { deviceId } : {}),
          ...(status ? { status: status as TractorJob["status"] } : {}),
          limit: Number(url.searchParams.get("size") ?? 20),
        });
        send(res, 200, page(records, url.searchParams), traceId);
        return;
      }

      // 作业详情：作业 + 分步指令序列 + 轨迹，全部按请求租户读取
      const jobMatch = url.pathname.match(/^\/api\/v1\/tractor\/jobs\/([^/]+)(?:\/(?:stop|resume))?$/);
      const jobId = jobMatch?.[1] ? decodeURIComponent(jobMatch[1]) : undefined;
      if (jobId && req.method === "GET" && url.pathname === `${API_PREFIX}/jobs/${jobId}`) {
        const job = await jobs.findJob(tenantId, jobId);
        if (!job) { send(res, 404, null, traceId, "作业不存在"); return; }
        const stages = await jobs.listStages(tenantId, job.id);
        const trajectory = await trajectories.findByJob(tenantId, job.id);
        send(res, 200, { job, stages, trajectory }, traceId);
        return;
      }

      // 人工处置：暂停或急停；控制侧 DONE 确认前不写作业状态
      if (jobId && req.method === "POST" && url.pathname === `${API_PREFIX}/jobs/${jobId}/stop`) {
        if (!executor) { send(res, 400, null, traceId, "作业执行器未配置"); return; }
        const body = await json(req);
        const job = await executor.stop(tenantId, jobId, body.emergency === true);
        if (!job) { send(res, 404, null, traceId, "作业不存在或不在作业中/暂停态"); return; }
        send(res, 200, job, traceId);
        return;
      }

      // 恢复作业：执行器在 RESUME 前后统一执行安全门，避免 HTTP 与执行器重复预检误判孤儿指令
      if (jobId && req.method === "POST" && url.pathname === `${API_PREFIX}/jobs/${jobId}/resume`) {
        if (!executor || !precheck) { send(res, 400, null, traceId, "执行器或预检未配置"); return; }
        const job = await jobs.findJob(tenantId, jobId);
        if (!job) { send(res, 404, null, traceId, "作业不存在"); return; }
        if (job.status !== "PAUSED") { send(res, 409, null, traceId, "只有 PAUSED 作业可以恢复"); return; }
        const resumed = await executor.resume(tenantId, job.id);
        send(res, 200, resumed, traceId);
        return;
      }

      // 安全事件列表：租户 + 作业/地块/类型筛选
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/safety-events`) {
        const jobId = url.searchParams.get("jobId") ?? undefined;
        const plotCode = url.searchParams.get("plotCode") ?? undefined;
        const kind = url.searchParams.get("kind") ?? undefined;
        if (kind !== undefined && !TRACTOR_SAFETY_KINDS.includes(kind as TractorSafetyEvent["kind"])) {
          send(res, 400, null, traceId, `kind 需为 ${TRACTOR_SAFETY_KINDS.join("/")} 之一`);
          return;
        }
        const events = await safetyEvents.list({
          tenantId,
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
      const detail = process.env.NODE_ENV === "production" ? "请求处理失败" : (error instanceof Error ? error.message : "请求处理失败");
      send(res, error instanceof TractorCommandError ? error.status : 400, null, traceId, detail);
    }
  });
}

export type { TractorJob, TractorJobStage };
