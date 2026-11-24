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

export interface JobExecutorDeps {
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

  constructor(message: string, status = 409) {
    super(message);
    this.name = "TractorCommandError";
    this.status = status;
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
): Promise<string> {
  const dispatched = await deps.dispatch({
    tenantId: job.tenantId,
    deviceId: job.deviceId,
    plotCode: job.plotCode,
    type,
    parameters: targetCommandId === null ? {} : { targetCommandId },
    operator: job.operator,
    idempotencyKey: `tractor:${job.id}:safety:${type}:${randomUUID()}`,
  }).catch(() => null);
  if (!dispatched) throw new TractorCommandError(`${type} 指令下发被控制侧拒绝，作业状态未变更`);
  const result = await deps.waitCommand(job.tenantId, job.deviceId, dispatched.commandId, deps.safetyCommandTimeoutMs ?? 30_000);
  if (result !== "DONE") {
    const detail = result === "TIMEOUT" ? "确认超时" : result === "UNAVAILABLE" ? "确认服务不可用" : "执行失败";
    throw new TractorCommandError(`${type} 指令${detail}，作业状态未变更`);
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
  for (const status of ["PLANNED", "RUNNING"] as const) {
    const size = 200;
    for (let offset = 0; ; offset += size) {
      const records = await deps.jobs.listJobs({ tenantId: deps.tenantId, status, limit: size, offset });
      recoverable.push(...records);
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
          await deps.executor.run(job, job.status === "RUNNING" ? { started: true } : undefined);
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
      const stages = await deps.jobs.listStages(job.tenantId, job.id);
      let completed = job.currentStage;
      const completeStage = async (index: number, stage: TractorJobStage, commandId: string, detail: string): Promise<boolean> => {
        const done = await deps.jobs.updateStage(job.tenantId, stage.id, {
          status: "DONE", commandId, detail,
        }, { expectedStatus: ["PENDING", "SENT"], owner });
        if (!done) return false;
        completed = index + 1;
        const advanced = await deps.jobs.updateJob(job.tenantId, job.id, { currentStage: completed }, { expectedStatus: "RUNNING", owner });
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
        }, { expectedStatus: "RUNNING", owner });
      };
      for (let index = job.currentStage; index < stages.length; index += 1) {
        if (!ownsLease) return;
        const stage = stages[index]!;
        if (stage.status === "DONE") { completed = index + 1; continue; }
        const current = await deps.jobs.findJob(job.tenantId, job.id);
        if (!current || current.status !== "RUNNING") {
          if (ownsLease) {
            await deps.jobs.updateStage(job.tenantId, stage.id, {
              detail: `分步 ${stage.stage} 下发前作业状态为 ${current?.status ?? "作业已不存在"}，本步不再下发`,
            }, { owner });
          }
          return;
        }
        const guard = deps.beforeStage ? await deps.beforeStage(job, stage) : { passed: true };
        const recoveredCommandId = guard.commandId;
        if (recoveredCommandId && guard.commandStatus === "DONE") {
          if (!await completeStage(index, stage, recoveredCommandId, `指令 ${recoveredCommandId} 已由控制侧确认完成`)) return;
          continue;
        }
        if (recoveredCommandId && (guard.commandStatus === "FAILED" || guard.commandStatus === "CANCELLED")) {
          if (!ownsLease) return;
          await failStage(stage, recoveredCommandId, `指令 ${recoveredCommandId} 已由控制侧收口为 ${guard.commandStatus}`, `分步 ${stage.stage} 控制侧${guard.commandStatus === "CANCELLED" ? "已取消" : "执行失败"}`);
          return;
        }
        if (!guard.passed) {
          if (!ownsLease) return;
          const targetCommandId = stage.commandId ?? recoveredCommandId;
          const outcome = targetCommandId ? await confirmCommandStopped(deps, job, targetCommandId) : undefined;
          if (outcome === "DONE") {
            if (!await completeStage(index, stage, targetCommandId!, `指令 ${targetCommandId} 已由控制侧确认完成`)) return;
            continue;
          }
          if (outcome === "FAILED" || outcome === "CANCELLED") {
            await failStage(stage, targetCommandId, `安全预检未通过，控制侧指令已收口为 ${outcome}`, `分步 ${stage.stage} 安全预检未通过，${outcome === "CANCELLED" ? "排队指令已取消" : "控制侧执行失败"}`);
            return;
          }
          if (stage.status === "PENDING" && targetCommandId) {
            const linked = await deps.jobs.updateStage(job.tenantId, stage.id, {
              status: "SENT", commandId: targetCommandId,
            }, { expectedStatus: "PENDING", owner });
            if (!linked) return;
          }
          await deps.jobs.updateStage(job.tenantId, stage.id, {
            detail: `分步 ${stage.stage} 下发前安全预检未通过，本步不再下发`,
          }, { owner });
          await deps.jobs.updateJob(job.tenantId, job.id, {
            status: "PAUSED", reason: `分步 ${stage.stage} 安全预检未通过`,
          }, { expectedStatus: "RUNNING", owner });
          return;
        }
        let commandId = stage.commandId;
        if (stage.status === "SENT" && commandId) {
          // 断点续跑复用原指令，不重复下发；控制侧 RESUME 已把目标从 PAUSED 改回 ACKED。
        } else {
          if (stage.status !== "PENDING") {
            if (!ownsLease) return;
            await deps.jobs.updateJob(job.tenantId, job.id, { status: "FAILED", finishedAt: new Date().toISOString(), reason: `分步 ${stage.stage} 状态不可执行` }, { expectedStatus: "RUNNING", owner });
            return;
          }
          if (recoveredCommandId) {
            commandId = recoveredCommandId;
            const sent = await deps.jobs.updateStage(job.tenantId, stage.id, { status: "SENT", commandId }, { expectedStatus: "PENDING", owner });
            if (!sent) return;
          } else {
            const dispatched = await deps.dispatch({
              tenantId: job.tenantId,
              deviceId: job.deviceId,
              plotCode: job.plotCode,
              type: stage.commandType,
              parameters: stage.parameters,
              operator: job.operator,
              idempotencyKey: tractorStageIdempotencyKey(job.id, stage.id),
            });
            if (!ownsLease) return;
            if (!dispatched) {
              await deps.jobs.updateStage(job.tenantId, stage.id, { status: "FAILED", detail: "指令下发被控制侧拒绝" }, { expectedStatus: "PENDING", owner });
              await deps.jobs.updateJob(job.tenantId, job.id, { status: "FAILED", finishedAt: new Date().toISOString(), reason: `分步 ${stage.stage} 下发被拒` }, { expectedStatus: "RUNNING", owner });
              return;
            }
            commandId = dispatched.commandId;
            const sent = await deps.jobs.updateStage(job.tenantId, stage.id, { status: "SENT", commandId }, { expectedStatus: "PENDING", owner });
            if (!sent) return;
          }
        }
        const result = await deps.waitCommand(job.tenantId, job.deviceId, commandId, stageTimeoutMs(stage.detail));
        if (!ownsLease) return;
        if (result === "PAUSED") {
          await deps.jobs.updateStage(job.tenantId, stage.id, {
            detail: `指令 ${commandId} 已由设备确认暂停`,
          }, { expectedStatus: "SENT", owner });
          await deps.jobs.updateJob(job.tenantId, job.id, {
            status: "PAUSED", reason: `分步 ${stage.stage} 已由设备暂停`,
          }, { expectedStatus: "RUNNING", owner });
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
        }, { expectedStatus: "RUNNING", owner });
      }
      if (ownsLease) {
        await deps.jobs.updateJob(job.tenantId, job.id, { status: "COMPLETED", currentStage: completed, finishedAt: new Date().toISOString(), reason: "全部分步完成" }, { expectedStatus: "RUNNING", owner });
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)), `run:${job.id}`);
    } finally {
      clearInterval(heartbeat);
      await deps.jobs.releaseJobClaim(job.tenantId, job.id, owner).catch(() => {});
    }
  };

  const actions = new Map<string, Promise<void>>();
  const withJobAction = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
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

  const stop = async (tenantId: string, jobId: string, emergency: boolean): Promise<TractorJob | null> => withJobAction(`${tenantId}:${jobId}`, async () => {
    const job = await deps.jobs.findJob(tenantId, jobId);
    if (!job || (job.status !== "RUNNING" && job.status !== "PAUSED")) return null;
    const commandType = emergency ? "ESTOP" : "PAUSE";
    const targetCommandId = emergency ? null : await activeCommandId(deps.jobs, job);
    if (!emergency && !targetCommandId) throw new TractorCommandError("当前没有可暂停的在途分步指令");
    const commandId = await confirmSafetyCommand(deps, job, commandType, targetCommandId);
    const updated = await deps.jobs.updateJob(tenantId, jobId, {
      status: emergency ? "ESTOPPED" : "PAUSED",
      reason: emergency ? "人工急停" : "人工暂停",
    }, { expectedStatus: job.status });
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
    if (job.status !== "PAUSED") throw new TractorCommandError("只有 PAUSED 作业可以恢复");
    const stages = await deps.jobs.listStages(tenantId, job.id);
    const stage = stages[job.currentStage];
    if (!stage) throw new TractorCommandError("当前没有可恢复的分步");
    if (stage.status === "FAILED" || stage.status === "SKIPPED") throw new TractorCommandError("当前分步不可恢复");
    const start = async (currentStage = job.currentStage): Promise<TractorJob> => {
      const updated = await deps.jobs.updateJob(tenantId, job.id, { status: "RUNNING", currentStage, reason: "" }, { expectedStatus: "PAUSED" });
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
      }, { expectedStatus: "PAUSED" });
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
      await confirmSafetyCommand(deps, job, "RESUME", targetCommandId);
    }
    return start();
  });

  return { run, stop, resume };
}
