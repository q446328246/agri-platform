import { randomUUID } from "node:crypto";

import { EventTopic } from "@agri/contracts";
import type { EventTopicValue, TractorSafetyEventPayload } from "@agri/contracts";

import type { TractorJob, TractorJobRepository, TractorJobStage } from "./job.repository.js";
import type { TractorSafetyEventRepository } from "./safety-event.repository.js";

/** 控制侧指令下发入参 */
export interface ControlDispatchInput {
  tenantId: string;
  deviceId: string;
  plotCode: string;
  type: string;
  parameters: Record<string, unknown>;
  operator: string;
  idempotencyKey?: string;
}

export type JobActionLock = <T>(key: string, action: () => Promise<T>) => Promise<T>;

export function createJobActionLock(): JobActionLock {
  const actions = new Map<string, Promise<void>>();
  return async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = actions.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    actions.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (actions.get(key) === current) actions.delete(key);
    }
  };
}

export interface JobExecutorDeps {
  withJobAction?: JobActionLock;
  jobs: TractorJobRepository;
  safetyEvents: TractorSafetyEventRepository;
  /** 向控制服务下发指令，返回指令标识；null 表示被控制侧拒绝 */
  dispatch: (input: ControlDispatchInput) => Promise<{ commandId: string } | null>;
  /** 等待指令收口：DONE 设备确认完成、FAILED 设备回报失败、PAUSED 已暂停、TIMEOUT 超时未收口 */
  waitCommand: (tenantId: string, deviceId: string, commandId: string, timeoutMs: number) => Promise<"DONE" | "FAILED" | "PAUSED" | "TIMEOUT" | "UNAVAILABLE">;
  /** 每个分步下发或续跑前重新过安全门；commandId/commandStatus 用于识别控制侧已建但本地未落关联的孤儿指令 */
  beforeStage?: (job: TractorJob, stage: TractorJobStage) => Promise<{ passed: boolean; commandId?: string; commandStatus?: string }>;
  /** 安全处置前核对控制侧真实状态；QUEUED 指令只能取消，SENT/ACKED 才能暂停 */
  commandOf?: (tenantId: string, commandId: string) => Promise<{ status: string } | null>;
  /** 按幂等键核对控制侧指令，用于下发响应丢失后找回 RESUME */
  commandByIdempotencyKey?: (tenantId: string, idempotencyKey: string) => Promise<{ id: string; status: string } | null>;
  /** 原子取消尚未被网关领取的 QUEUED 指令；与网关领取共用版本 CAS */
  cancelCommand?: (tenantId: string, commandId: string, reason: string) => Promise<boolean>;
  /** 安全处置指令的确认超时（毫秒），缺省 30 秒 */
  safetyCommandTimeoutMs?: number;
  executionLeaseMs?: number;
  publish?: (topic: EventTopicValue, payload: unknown) => Promise<void>;
  onError?: (error: Error, phase: string) => void;
}

export interface JobExecutor {
  /** 从当前分步继续执行作业（排程后启动与暂停恢复共用） */
  run(job: TractorJob, options?: { started?: boolean }): Promise<void>;
  /** 人工处置：暂停或急停，控制侧 DONE 确认后才更新作业 */
  stop(tenantId: string, jobId: string, emergency: boolean): Promise<TractorJob | null>;
  /** 人工恢复：只允许 PAUSED，RESUME 确认后才恢复执行 */
  resume(tenantId: string, jobId: string): Promise<TractorJob>;
}

/** 控制侧拒绝、失败或未及时确认：调用方不得把作业展示成已暂停/恢复/急停。 */
export class TractorCommandError extends Error {
  readonly status: number;
  readonly commandId?: string;

  constructor(message: string, status = 409, commandId?: string) {
    super(message);
    this.name = "TractorCommandError";
    this.status = status;
    if (commandId !== undefined) this.commandId = commandId;
  }
}

/** 记录安全事件并发布（事件落库 + 事件日志双通道，发布失败不影响留痕） */
export async function recordSafetyEvent(
  deps: { safetyEvents: TractorSafetyEventRepository; publish?: (topic: EventTopicValue, payload: unknown) => Promise<void> },
  input: { tenantId: string; jobId?: string; plotCode: string; deviceId: string; kind: TractorSafetyEventPayload["kind"]; level: "WARNING" | "CRITICAL"; message: string; lng?: number; lat?: number },
): Promise<void> {
  await deps.safetyEvents.create(undefined, {
    tenantId: input.tenantId,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    plotCode: input.plotCode,
    deviceId: input.deviceId,
    kind: input.kind,
    level: input.level,
    message: input.message,
    ...(input.lng !== undefined ? { lng: input.lng } : {}),
    ...(input.lat !== undefined ? { lat: input.lat } : {}),
  });
  if (!deps.publish) return;
  const payload: TractorSafetyEventPayload = {
    parcelId: input.plotCode,
    deviceId: input.deviceId,
    kind: input.kind,
    level: input.level,
    message: input.message,
    ...(input.lng !== undefined ? { lng: input.lng } : {}),
    ...(input.lat !== undefined ? { lat: input.lat } : {}),
    occurredAt: new Date().toISOString(),
  };
  await deps.publish(EventTopic.TractorSafetyEvent, payload).catch(() => {});
}

function stageTimeoutMs(detail: string): number {
  try {
    const parsed = JSON.parse(detail) as { timeoutMs?: number };
    return typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : 600_000;
  } catch {
    return 600_000;
  }
}

export function tractorStageIdempotencyKey(jobId: string, stageId: string): string {
  return `tractor:${jobId}:stage:${stageId}`;
}

interface PendingResume {
  idempotencyKey: string;
  targetCommandId: string;
  requestedAt: string;
}

export function pendingResumeOf(job: TractorJob): PendingResume | null {
  const value = job.parameters.pendingResume;
  if (!value || typeof value !== "object") return null;
  const pending = value as Record<string, unknown>;
  return typeof pending.idempotencyKey === "string" && pending.idempotencyKey !== ""
    && typeof pending.targetCommandId === "string" && pending.targetCommandId !== ""
    && typeof pending.requestedAt === "string"
    ? { idempotencyKey: pending.idempotencyKey, targetCommandId: pending.targetCommandId, requestedAt: pending.requestedAt }
    : null;
}

function parametersWithoutPendingResume(job: TractorJob): Record<string, unknown> {
  const parameters = { ...job.parameters };
  delete parameters.pendingResume;
  return parameters;
}

async function clearPendingResume(deps: JobExecutorDeps, job: TractorJob): Promise<TractorJob> {
  const updated = await deps.jobs.updateJob(job.tenantId, job.id, {
    parameters: parametersWithoutPendingResume(job),
  }, { expectedStatus: "PAUSED", expectedRevision: job.revision });
  if (!updated) throw new TractorCommandError("等待控制确认期间作业状态已变化，请刷新后重试");
  return updated;
}

export async function recoveryCommand(
  stage: TractorJobStage,
  findByIdempotencyKey: (key: string) => Promise<{ id: string; status: string } | null>,
): Promise<{ id: string; status: string } | undefined> {
  if (stage.status === "SENT" && stage.commandId) return { id: stage.commandId, status: "UNKNOWN" };
  const command = await findByIdempotencyKey(tractorStageIdempotencyKey(stage.jobId, stage.id));
  return command ? { id: command.id, status: command.status } : undefined;
}

async function activeCommandId(jobs: TractorJobRepository, job: TractorJob): Promise<string | null> {
  const stages = await jobs.listStages(job.tenantId, job.id);
  return stages.find((stage) => stage.status === "SENT" && stage.commandId)?.commandId ?? null;
}

async function confirmSafetyCommand(
  deps: JobExecutorDeps,
  job: TractorJob,
  type: "PAUSE" | "RESUME" | "ESTOP",
  targetCommandId: string | null,
  idempotencyKey = `tractor:${job.id}:safety:${type}:${randomUUID()}`,
): Promise<string> {
  const dispatched = await deps.dispatch({
    tenantId: job.tenantId,
    deviceId: job.deviceId,
    plotCode: job.plotCode,
    type,
    parameters: targetCommandId === null ? {} : { targetCommandId },
    operator: job.operator,
    idempotencyKey,
  }).catch(() => {
    throw new TractorCommandError(`${type} 指令下发结果未知，作业状态未变更`, 503);
  });
  if (!dispatched) throw new TractorCommandError(`${type} 指令下发被控制侧拒绝，作业状态未变更`);
  const result = await deps.waitCommand(job.tenantId, job.deviceId, dispatched.commandId, deps.safetyCommandTimeoutMs ?? 30_000)
    .catch(() => {
      throw new TractorCommandError(`${type} 指令确认结果未知，作业状态未变更`, 503, dispatched.commandId);
    });
  if (result !== "DONE") {
    const detail = result === "TIMEOUT" ? "确认超时" : result === "UNAVAILABLE" ? "确认服务不可用" : "执行失败";
    throw new TractorCommandError(`${type} 指令${detail}，作业状态未变更`, 409, dispatched.commandId);
  }
  return dispatched.commandId;
}

async function confirmCommandStopped(
  deps: JobExecutorDeps,
  job: TractorJob,
  commandId: string,
): Promise<"PAUSED" | "DONE" | "FAILED" | "CANCELLED"> {
  if (!deps.commandOf) {
    await confirmSafetyCommand(deps, job, "PAUSE", commandId);
    return "PAUSED";
  }
  let command = await deps.commandOf(job.tenantId, commandId);
  if (command?.status === "QUEUED") {
    if (!deps.cancelCommand) throw new TractorCommandError("排队指令无法取消，作业状态未变更");
    await deps.cancelCommand(job.tenantId, commandId, `分步安全预检失败或收口超时，取消排队指令`);
    command = await deps.commandOf(job.tenantId, commandId);
  }
  if (command?.status === "DONE" || command?.status === "FAILED" || command?.status === "CANCELLED") return command.status;
  if (command?.status === "PAUSED") return "PAUSED";
  if (command?.status === "SENT" || command?.status === "ACKED") {
    await confirmSafetyCommand(deps, job, "PAUSE", commandId);
    return "PAUSED";
  }
  throw new TractorCommandError("无法确认控制侧指令状态，作业状态未变更");
}

/**
 * 作业执行器：把分步计划逐条下发给控制服务，等待每步收口再推进下一步。
 * 作业与分步状态均用 CAS 推进；等待期间发生的急停/暂停不会被迟到的完成或超时覆盖。
 */
export async function recoverUnfinishedJobs(
  deps: {
    tenantId: string;
    jobs: TractorJobRepository;
    executor: JobExecutor;
    onError?: (error: Error, jobId: string) => void;
  },
): Promise<void> {
  const recoverable: TractorJob[] = [];
  for (const status of ["PLANNED", "RUNNING", "PAUSED", "SAFETY_UNKNOWN"] as const) {
    const size = 200;
    for (let offset = 0; ; offset += size) {
      const records = await deps.jobs.listJobs({ tenantId: deps.tenantId, status, limit: size, offset });
      recoverable.push(...records.filter((job) => status !== "PAUSED" || pendingResumeOf(job) !== null));
      if (records.length < size) break;
    }
  }
  const byDevice = new Map<string, TractorJob[]>();
  for (const job of recoverable) {
    const queue = byDevice.get(job.deviceId) ?? [];
    queue.push(job);
    byDevice.set(job.deviceId, queue);
  }
  const queues = [...byDevice.values()];
  let nextQueue = 0;
  const worker = async (): Promise<void> => {
    while (nextQueue < queues.length) {
      const queue = queues[nextQueue++]!;
      for (const job of queue) {
        try {
          if (job.status === "PAUSED" || job.status === "SAFETY_UNKNOWN") await deps.executor.resume(job.tenantId, job.id);
          else await deps.executor.run(job, job.status === "RUNNING" ? { started: true } : undefined);
        } catch (error) {
          deps.onError?.(error instanceof Error ? error : new Error(String(error)), job.id);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queues.length) }, () => worker()));
}

export function createJobExecutor(deps: JobExecutorDeps): JobExecutor {
  const onError = deps.onError ?? ((error: Error, phase: string): void => { console.error("[tractor] 作业执行失败", { phase, message: error.message }); });
  const withJobAction = deps.withJobAction ?? createJobActionLock();

  const run = async (job: TractorJob, options?: { started?: boolean }): Promise<void> => {
    const owner = randomUUID();
    const leaseMs = deps.executionLeaseMs ?? 20_000;
    const expectedStatus = options?.started ? "RUNNING" : ["PLANNED", "PAUSED"] as const;
    const claimed = await deps.jobs.claimJob(job.tenantId, job.id, owner, leaseMs, expectedStatus);
    if (!claimed) return;
    job = claimed;
    let ownsLease = true;
    const heartbeat = setInterval(() => {
      void deps.jobs.renewJobClaim(job.tenantId, job.id, owner, leaseMs).then((renewed) => {
        if (!renewed && ownsLease) {
          ownsLease = false;
          onError(new Error("作业执行租约已丢失，停止后续下发"), `lease:${job.id}`);
        }
      }).catch((error: unknown) => {
        ownsLease = false;
        onError(error instanceof Error ? error : new Error(String(error)), `lease:${job.id}`);
      });
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    try {
      if (options?.started) {
        const current = await deps.jobs.findJob(job.tenantId, job.id);
        if (!current || current.status !== "RUNNING") return;
        job = current;
      } else {
        const started = await deps.jobs.updateJob(job.tenantId, job.id, { status: "RUNNING", startedAt: job.startedAt ?? new Date().toISOString(), reason: "" }, { expectedStatus: ["PLANNED", "PAUSED"], owner });
        if (!started) return;
        job = started;
      }
      const runRevision = job.runRevision;
      const stages = await deps.jobs.listStages(job.tenantId, job.id);
      let completed = job.currentStage;
      const completeStage = async (index: number, stage: TractorJobStage, commandId: string, detail: string): Promise<boolean> => {
        const done = await deps.jobs.updateStage(job.tenantId, stage.id, {
          status: "DONE", commandId, detail,
        }, { expectedStatus: ["PENDING", "SENT"], owner });
        if (!done) return false;
        completed = index + 1;
        const advanced = await deps.jobs.updateJob(job.tenantId, job.id, { currentStage: completed }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
        if (!advanced) return false;
        job = advanced;
        return true;
      };
      const failStage = async (stage: TractorJobStage, commandId: string | undefined, detail: string, reason: string): Promise<void> => {
        await deps.jobs.updateStage(job.tenantId, stage.id, {
          status: "FAILED", ...(commandId ? { commandId } : {}), detail,
        }, { expectedStatus: ["PENDING", "SENT"], owner });
        await deps.jobs.updateJob(job.tenantId, job.id, {
          status: "FAILED", finishedAt: new Date().toISOString(), reason,
        }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
      };
      for (let index = job.currentStage; index < stages.length; index += 1) {
        if (!ownsLease) return;
        const stage = stages[index]!;
        if (stage.status === "DONE") { completed = index + 1; continue; }
        const prepared = await withJobAction(`${job.tenantId}:${job.id}`, async (): Promise<
          | { kind: "READY"; commandId: string }
          | { kind: "DONE"; commandId: string }
          | { kind: "STOP" }
        > => {
          const current = await deps.jobs.findJob(job.tenantId, job.id);
          if (!current || current.status !== "RUNNING") {
            if (ownsLease) {
              await deps.jobs.updateStage(job.tenantId, stage.id, {
                detail: `分步 ${stage.stage} 下发前作业状态为 ${current?.status ?? "作业已不存在"}，本步不再下发`,
              }, { owner });
            }
            return { kind: "STOP" };
          }
          const guard = deps.beforeStage ? await deps.beforeStage(current, stage) : { passed: true };
          const latest = await deps.jobs.findJob(job.tenantId, job.id);
          if (!latest || latest.status !== "RUNNING" || latest.runRevision !== current.runRevision || latest.revision !== current.revision) {
            if (ownsLease) {
              await deps.jobs.updateStage(job.tenantId, stage.id, {
                detail: `分步 ${stage.stage} 预检后作业状态或版本已变化，本步不再下发`,
              }, { owner });
            }
            return { kind: "STOP" };
          }
          job = latest;
          const recoveredCommandId = guard.commandId;
          if (recoveredCommandId && guard.commandStatus === "DONE") {
            return { kind: "DONE", commandId: recoveredCommandId };
          }
          if (recoveredCommandId && (guard.commandStatus === "FAILED" || guard.commandStatus === "CANCELLED")) {
            if (!ownsLease) return { kind: "STOP" };
            await failStage(stage, recoveredCommandId, `指令 ${recoveredCommandId} 已由控制侧收口为 ${guard.commandStatus}`, `分步 ${stage.stage} 控制侧${guard.commandStatus === "CANCELLED" ? "已取消" : "执行失败"}`);
            return { kind: "STOP" };
          }
          if (!guard.passed) {
            if (!ownsLease) return { kind: "STOP" };
            const targetCommandId = stage.commandId ?? recoveredCommandId;
            const outcome = targetCommandId ? await confirmCommandStopped(deps, job, targetCommandId) : undefined;
            if (outcome === "DONE") return { kind: "DONE", commandId: targetCommandId! };
            if (outcome === "FAILED" || outcome === "CANCELLED") {
              await failStage(stage, targetCommandId, `安全预检未通过，控制侧指令已收口为 ${outcome}`, `分步 ${stage.stage} 安全预检未通过，${outcome === "CANCELLED" ? "排队指令已取消" : "控制侧执行失败"}`);
              return { kind: "STOP" };
            }
            if (stage.status === "PENDING" && targetCommandId) {
              const linked = await deps.jobs.updateStage(job.tenantId, stage.id, {
                status: "SENT", commandId: targetCommandId,
              }, { expectedStatus: "PENDING", owner });
              if (!linked) return { kind: "STOP" };
            }
            await deps.jobs.updateStage(job.tenantId, stage.id, {
              detail: `分步 ${stage.stage} 下发前安全预检未通过，本步不再下发`,
            }, { owner });
            await deps.jobs.updateJob(job.tenantId, job.id, {
              status: "PAUSED", reason: `分步 ${stage.stage} 安全预检未通过`,
            }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
            return { kind: "STOP" };
          }
          let commandId = stage.commandId;
          if (stage.status === "SENT" && commandId) {
            return { kind: "READY", commandId };
          }
          if (stage.status !== "PENDING") {
            if (!ownsLease) return { kind: "STOP" };
            await deps.jobs.updateJob(job.tenantId, job.id, { status: "FAILED", finishedAt: new Date().toISOString(), reason: `分步 ${stage.stage} 状态不可执行` }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
            return { kind: "STOP" };
          }
          if (recoveredCommandId) {
            commandId = recoveredCommandId;
            const sent = await deps.jobs.updateStage(job.tenantId, stage.id, { status: "SENT", commandId }, { expectedStatus: "PENDING", owner });
            if (!sent) return { kind: "STOP" };
          } else {
            if (!ownsLease) return { kind: "STOP" };
            const dispatched = await deps.dispatch({
              tenantId: job.tenantId,
              deviceId: job.deviceId,
              plotCode: job.plotCode,
              type: stage.commandType,
              parameters: stage.parameters,
              operator: job.operator,
              idempotencyKey: tractorStageIdempotencyKey(job.id, stage.id),
            });
            if (!ownsLease) return { kind: "STOP" };
            if (!dispatched) {
              await deps.jobs.updateStage(job.tenantId, stage.id, { status: "FAILED", detail: "指令下发被控制侧拒绝" }, { expectedStatus: "PENDING", owner });
              await deps.jobs.updateJob(job.tenantId, job.id, { status: "FAILED", finishedAt: new Date().toISOString(), reason: `分步 ${stage.stage} 下发被拒` }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
              return { kind: "STOP" };
            }
            commandId = dispatched.commandId;
            const sent = await deps.jobs.updateStage(job.tenantId, stage.id, { status: "SENT", commandId }, { expectedStatus: "PENDING", owner });
            if (!sent) return { kind: "STOP" };
          }
          return { kind: "READY", commandId };
        });
        if (prepared.kind === "STOP") return;
        if (prepared.kind === "DONE") {
          if (!await completeStage(index, stage, prepared.commandId, `指令 ${prepared.commandId} 已由控制侧确认完成`)) return;
          continue;
        }
        const commandId = prepared.commandId;
        const result = await deps.waitCommand(job.tenantId, job.deviceId, commandId, stageTimeoutMs(stage.detail));
        if (!ownsLease) return;
        if (result === "PAUSED") {
          await deps.jobs.updateStage(job.tenantId, stage.id, {
            detail: `指令 ${commandId} 已由设备确认暂停`,
          }, { expectedStatus: "SENT", owner });
          await deps.jobs.updateJob(job.tenantId, job.id, {
            status: "PAUSED", reason: `分步 ${stage.stage} 已由设备暂停`,
          }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
          return;
        }
        if (result === "UNAVAILABLE") {
          await deps.jobs.updateStage(job.tenantId, stage.id, { detail: `指令 ${commandId} 确认服务暂不可用，等待恢复扫描续跑` }, { expectedStatus: "SENT", owner });
          return;
        }
        if (result === "DONE") {
          if (!await completeStage(index, stage, commandId, `指令 ${commandId} 收口完成`)) return;
          continue;
        }
        if (result === "FAILED") {
          if (!ownsLease) return;
          await failStage(stage, commandId, `指令 ${commandId} 设备回报失败`, `分步 ${stage.stage} 执行失败`);
          return;
        }
        const stopped = await confirmCommandStopped(deps, job, commandId);
        if (!ownsLease) return;
        if (stopped === "DONE") {
          if (!await completeStage(index, stage, commandId, `指令 ${commandId} 在超时核对时已确认完成`)) return;
          continue;
        }
        if (stopped === "FAILED" || stopped === "CANCELLED") {
          await failStage(stage, commandId, `指令 ${commandId} 等待超时，控制侧已收口为 ${stopped}`, `分步 ${stage.stage} ${stopped === "CANCELLED" ? "排队指令已取消" : "执行失败"}`);
          return;
        }
        await deps.jobs.updateStage(job.tenantId, stage.id, {
          detail: `指令 ${commandId} 等待收口超时，已确认暂停，可安全恢复`,
        }, { expectedStatus: "SENT", owner });
        await deps.jobs.updateJob(job.tenantId, job.id, {
          status: "PAUSED", reason: `分步 ${stage.stage} 收口超时，已确认暂停`,
        }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
      }
      if (ownsLease) {
        await deps.jobs.updateJob(job.tenantId, job.id, { status: "COMPLETED", currentStage: completed, finishedAt: new Date().toISOString(), reason: "全部分步完成" }, { expectedStatus: "RUNNING", expectedRunRevision: runRevision, owner });
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)), `run:${job.id}`);
    } finally {
      clearInterval(heartbeat);
      await deps.jobs.releaseJobClaim(job.tenantId, job.id, owner).catch(() => {});
    }
  };

  const stop = async (tenantId: string, jobId: string, emergency: boolean): Promise<TractorJob | null> => withJobAction(`${tenantId}:${jobId}`, async () => {
    const job = await deps.jobs.findJob(tenantId, jobId);
    if (!job || (job.status !== "RUNNING" && job.status !== "PAUSED" && !(emergency && job.status === "SAFETY_UNKNOWN"))) return null;
    const commandType = emergency ? "ESTOP" : "PAUSE";
    const targetCommandId = emergency ? null : await activeCommandId(deps.jobs, job);
    if (!emergency && !targetCommandId) throw new TractorCommandError("当前没有可暂停的在途分步指令");
    const commandId = await confirmSafetyCommand(deps, job, commandType, targetCommandId);
    const updated = await deps.jobs.updateJob(tenantId, jobId, {
      status: emergency && job.status === "SAFETY_UNKNOWN" ? "SAFETY_UNKNOWN" : emergency ? "ESTOPPED" : "PAUSED",
      reason: emergency && job.status === "SAFETY_UNKNOWN"
        ? "人工急停已确认，仍需人工核实未知 RESUME 是否已取消"
        : emergency ? "人工急停" : "人工暂停",
    }, { expectedStatus: job.status, expectedRunRevision: job.runRevision });
    if (!updated) throw new TractorCommandError("等待控制确认期间作业状态已变化，请刷新后重试");
    if (emergency) {
      await recordSafetyEvent(deps, {
        tenantId: job.tenantId,
        jobId: job.id,
        plotCode: job.plotCode,
        deviceId: job.deviceId,
        kind: "ESTOP",
        level: "CRITICAL",
        message: `人工急停已确认（指令 ${commandId}）`,
      });
    }
    return updated;
  });

  const resume = async (tenantId: string, jobId: string): Promise<TractorJob> => withJobAction(`${tenantId}:${jobId}`, async () => {
    const job = await deps.jobs.findJob(tenantId, jobId);
    if (!job) throw new TractorCommandError("作业不存在", 404);
    const pendingResume = pendingResumeOf(job);
    if (job.status !== "PAUSED" && job.status !== "SAFETY_UNKNOWN") {
      throw new TractorCommandError("只有 PAUSED 或 SAFETY_UNKNOWN 作业可以恢复");
    }
    const unknownResume = async (resumeCommandId?: string, resumeKey?: string, sourceJob: TractorJob = job): Promise<never> => {
      let unknownJob = sourceJob;
      if (job.status === "PAUSED") {
        const unknown = await deps.jobs.updateJob(tenantId, job.id, {
          status: "SAFETY_UNKNOWN",
          reason: "RESUME 指令结果未知，等待急停确认",
        }, { expectedStatus: "PAUSED", expectedRevision: sourceJob.revision });
        if (!unknown) throw new TractorCommandError("等待控制确认期间作业状态已变化，请刷新后重试");
        unknownJob = unknown;
      }
      await recordSafetyEvent(deps, {
        tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
        kind: "ESTOP", level: "CRITICAL",
        message: job.status === "SAFETY_UNKNOWN" ? "RESUME 指令仍未确认完成，持续对账并尝试急停" : "RESUME 指令未确认完成，设备可能仍在运行，作业转入 SAFETY_UNKNOWN 并尝试急停",
      });
      let commandId = resumeCommandId;
      const findResume = async (): Promise<void> => {
        if (!commandId && resumeKey && deps.commandByIdempotencyKey) {
          commandId = (await deps.commandByIdempotencyKey(tenantId, resumeKey).catch(() => null))?.id;
        }
      };
      const inspectAndCancel = async (): Promise<string | undefined> => {
        await findResume();
        if (!commandId || !deps.commandOf) return undefined;
        const before = await deps.commandOf(tenantId, commandId).catch(() => null);
        if (before?.status !== "QUEUED") return before?.status;
        if (!deps.cancelCommand) return "QUEUED";
        await deps.cancelCommand(tenantId, commandId, "RESUME 确认结果未知，撤销排队恢复并急停").catch(() => false);
        return (await deps.commandOf(tenantId, commandId).catch(() => null))?.status;
      };
      await inspectAndCancel();
      try {
        await confirmSafetyCommand(deps, job, "ESTOP", null);
      } catch {
        throw new TractorCommandError("恢复结果未知且急停尚未确认，作业保持 SAFETY_UNKNOWN，请人工核实设备");
      }
      const resumeStatus = await inspectAndCancel();
      const nonDispatchable = resumeStatus !== undefined && ["ACKED", "PAUSED", "DONE", "FAILED", "CANCELLED"].includes(resumeStatus);
      if (!nonDispatchable) {
        throw new TractorCommandError("恢复结果未知且 RESUME 尚未证实不可再下发，作业保持 SAFETY_UNKNOWN，请人工核实设备", 503, commandId);
      }
      const stopped = await deps.jobs.updateJob(tenantId, job.id, {
        status: "ESTOPPED",
        reason: "恢复结果未知，RESUME 已不可再下发且急停已确认",
        finishedAt: new Date().toISOString(),
        parameters: parametersWithoutPendingResume(unknownJob),
      }, { expectedStatus: "SAFETY_UNKNOWN", expectedRevision: unknownJob.revision });
      if (!stopped) throw new TractorCommandError("急停确认期间作业状态已变化，请刷新后重试");
      throw new TractorCommandError("恢复结果未知，RESUME 已不可再下发，急停确认后将作业收口为 ESTOPPED");
    };
    if (pendingResume || job.status === "SAFETY_UNKNOWN") {
      return unknownResume(undefined, pendingResume?.idempotencyKey);
    }
    const stages = await deps.jobs.listStages(tenantId, job.id);
    const stage = stages[job.currentStage];
    if (!stage) throw new TractorCommandError("当前没有可恢复的分步");
    if (stage.status === "FAILED" || stage.status === "SKIPPED") throw new TractorCommandError("当前分步不可恢复");
    let resumable = job;
    const start = async (currentStage = job.currentStage): Promise<TractorJob> => {
      const updated = await deps.jobs.updateJob(tenantId, job.id, {
        status: "RUNNING", currentStage, reason: "", parameters: parametersWithoutPendingResume(resumable),
      }, { expectedStatus: "PAUSED", expectedRevision: resumable.revision });
      if (!updated) throw new TractorCommandError("等待控制确认期间作业状态已变化，请刷新后重试");
      void run(updated, { started: true });
      return updated;
    };
    const failRecovered = async (commandId: string, status: "FAILED" | "CANCELLED"): Promise<never> => {
      await deps.jobs.updateStage(tenantId, stage.id, {
        status: "FAILED", commandId, detail: `控制侧指令已收口为 ${status}`,
      }, { expectedStatus: ["PENDING", "SENT"] });
      const failed = await deps.jobs.updateJob(tenantId, job.id, {
        status: "FAILED", finishedAt: new Date().toISOString(),
        reason: `分步 ${stage.stage} 控制侧${status === "CANCELLED" ? "已取消" : "执行失败"}`,
      }, { expectedStatus: "PAUSED", expectedRevision: resumable.revision });
      if (!failed) throw new TractorCommandError("等待控制确认期间作业状态已变化，请刷新后重试");
      throw new TractorCommandError(`当前分步控制侧${status === "CANCELLED" ? "已取消" : "执行失败"}，作业已收口为 FAILED`);
    };
    const completeRecovered = async (commandId: string): Promise<TractorJob> => {
      const done = await deps.jobs.updateStage(tenantId, stage.id, {
        status: "DONE", commandId, detail: `指令 ${commandId} 已由控制侧确认完成`,
      }, { expectedStatus: ["PENDING", "SENT"] });
      if (!done) throw new TractorCommandError("等待控制确认期间分步状态已变化，请刷新后重试");
      return start(job.currentStage + 1);
    };
    if (stage.status === "DONE") return start();
    const guard = deps.beforeStage ? await deps.beforeStage(job, stage) : { passed: true };
    const targetCommandId = stage.commandId ?? guard.commandId;
    let commandStatus = guard.commandStatus ?? (stage.status === "SENT" && targetCommandId ? "UNKNOWN" : undefined);
    if (stage.status === "SENT" && targetCommandId && deps.commandOf) {
      const command = await deps.commandOf(tenantId, targetCommandId);
      if (!command) throw new TractorCommandError("无法确认控制侧指令状态，作业保持暂停");
      commandStatus = command.status;
    }
    if (targetCommandId && commandStatus === "DONE") return completeRecovered(targetCommandId);
    if (targetCommandId && (commandStatus === "FAILED" || commandStatus === "CANCELLED")) return failRecovered(targetCommandId, commandStatus);
    if (!guard.passed) {
      if (targetCommandId) {
        const outcome = await confirmCommandStopped(deps, job, targetCommandId);
        if (outcome === "DONE") return completeRecovered(targetCommandId);
        if (outcome === "FAILED" || outcome === "CANCELLED") return failRecovered(targetCommandId, outcome);
      }
      throw new TractorCommandError("恢复作业安全预检未通过，作业保持暂停");
    }
    if (stage.status === "SENT" && !targetCommandId) throw new TractorCommandError("当前没有可恢复的已暂停分步指令");
    if (targetCommandId && (commandStatus === "SENT" || commandStatus === "ACKED")) {
      const outcome = await confirmCommandStopped(deps, job, targetCommandId);
      if (outcome === "DONE") return completeRecovered(targetCommandId);
      if (outcome === "FAILED" || outcome === "CANCELLED") return failRecovered(targetCommandId, outcome);
    }
    if (targetCommandId && (commandStatus === "PAUSED" || (stage.status === "SENT" && commandStatus === "UNKNOWN"))) {
      const resumeKey = `tractor:${job.id}:safety:RESUME:${randomUUID()}`;
      const intent = await deps.jobs.updateJob(tenantId, job.id, {
        parameters: {
          ...job.parameters,
          pendingResume: { idempotencyKey: resumeKey, targetCommandId, requestedAt: new Date().toISOString() },
        },
      }, { expectedStatus: "PAUSED", expectedRevision: job.revision });
      if (!intent) throw new TractorCommandError("恢复意图持久化前作业状态已变化，请刷新后重试");
      resumable = intent;
      try {
        await confirmSafetyCommand(deps, job, "RESUME", targetCommandId, resumeKey);
      } catch (error) {
        if (error instanceof TractorCommandError && error.commandId === undefined && error.status < 500) {
          await clearPendingResume(deps, intent);
          throw error;
        }
        return unknownResume(error instanceof TractorCommandError ? error.commandId : undefined, resumeKey, intent);
      }
    }
    return start();
  });

  return { run, stop, resume };
}
