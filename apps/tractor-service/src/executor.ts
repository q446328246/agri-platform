import { EventTopic } from "@agri/contracts";
import type { EventTopicValue, TractorSafetyEventPayload } from "@agri/contracts";

import type { TractorJob, TractorJobRepository } from "./job.repository.js";
import type { TractorSafetyEventRepository } from "./safety-event.repository.js";

/** 控制侧指令下发入参 */
export interface ControlDispatchInput {
  deviceId: string;
  plotCode: string;
  type: string;
  parameters: Record<string, unknown>;
  operator: string;
}

export interface JobExecutorDeps {
  jobs: TractorJobRepository;
  safetyEvents: TractorSafetyEventRepository;
  /** 向控制服务下发指令，返回指令标识；null 表示被控制侧拒绝 */
  dispatch: (input: ControlDispatchInput) => Promise<{ commandId: string } | null>;
  /** 等待指令收口：DONE 设备确认完成、FAILED 设备回报失败、TIMEOUT 超时未收口 */
  waitCommand: (deviceId: string, commandId: string, timeoutMs: number) => Promise<"DONE" | "FAILED" | "TIMEOUT">;
  publish?: (topic: EventTopicValue, payload: unknown) => Promise<void>;
  onError?: (error: Error, phase: string) => void;
}

export interface JobExecutor {
  /** 从当前分步继续执行作业（排程后启动与暂停恢复共用） */
  run(job: TractorJob): Promise<void>;
  /** 人工处置：暂停或急停 */
  stop(jobId: string, emergency: boolean): Promise<TractorJob | null>;
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

/**
 * 作业执行器：把分步计划逐条下发给控制服务，等待每步收口再推进下一步。
 * 任一步下发被拒或收口失败即收口作业为 FAILED 并留痕，绝不带着半步状态继续。
 */
export function createJobExecutor(deps: JobExecutorDeps): JobExecutor {
  const onError = deps.onError ?? ((error: Error, phase: string): void => { console.error("[tractor] 作业执行失败", { phase, message: error.message }); });

  const run = async (job: TractorJob): Promise<void> => {
    try {
      if (job.status !== "PLANNED" && job.status !== "PAUSED") return;
      const started = await deps.jobs.updateJob(undefined, job.id, { status: "RUNNING", startedAt: new Date().toISOString(), reason: "" });
      if (!started) return;
      const stages = await deps.jobs.listStages(job.id);
      let completed = job.currentStage;
      for (let index = job.currentStage; index < stages.length; index += 1) {
        const stage = stages[index]!;
        if (stage.status === "DONE") { completed = index + 1; continue; }
        const dispatched = await deps.dispatch({
          deviceId: job.deviceId,
          plotCode: job.plotCode,
          type: stage.commandType,
          parameters: stage.stage === "OPERATION" ? { ...job.parameters } : {},
          operator: job.operator,
        });
        if (!dispatched) {
          await deps.jobs.updateStage(undefined, stage.id, { status: "FAILED", detail: "指令下发被控制侧拒绝" });
          await deps.jobs.updateJob(undefined, job.id, { status: "FAILED", finishedAt: new Date().toISOString(), reason: `分步 ${stage.stage} 下发被拒` });
          return;
        }
        await deps.jobs.updateStage(undefined, stage.id, { status: "SENT", commandId: dispatched.commandId });
        const result = await deps.waitCommand(job.deviceId, dispatched.commandId, stageTimeoutMs(stage.detail));
        if (result === "DONE") {
          await deps.jobs.updateStage(undefined, stage.id, { status: "DONE", detail: `指令 ${dispatched.commandId} 收口完成` });
          completed = index + 1;
        } else {
          await deps.jobs.updateStage(undefined, stage.id, { status: "FAILED", detail: `指令 ${dispatched.commandId} ${result === "TIMEOUT" ? "等待收口超时" : "设备回报失败"}` });
          await deps.jobs.updateJob(undefined, job.id, { status: "FAILED", finishedAt: new Date().toISOString(), reason: `分步 ${stage.stage} ${result === "TIMEOUT" ? "收口超时" : "执行失败"}` });
          return;
        }
      }
      await deps.jobs.updateJob(undefined, job.id, { status: "COMPLETED", currentStage: completed, finishedAt: new Date().toISOString(), reason: "全部分步完成" });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)), `run:${job.id}`);
      await deps.jobs.updateJob(undefined, job.id, { status: "FAILED", finishedAt: new Date().toISOString(), reason: "作业执行异常" }).catch(() => {});
    }
  };

  const stop = async (jobId: string, emergency: boolean): Promise<TractorJob | null> => {
    const job = await deps.jobs.findJob(jobId);
    if (!job || (job.status !== "RUNNING" && job.status !== "PAUSED")) return null;
    const commandType = emergency ? "ESTOP" : "PAUSE";
    const dispatched = await deps.dispatch({
      deviceId: job.deviceId,
      plotCode: job.plotCode,
      type: commandType,
      parameters: {},
      operator: job.operator,
    }).catch(() => null);
    const updated = await deps.jobs.updateJob(undefined, job.id, {
      status: emergency ? "ESTOPPED" : "PAUSED",
      reason: emergency ? "人工急停" : "人工暂停",
    });
    if (emergency) {
      await recordSafetyEvent(deps, {
        tenantId: job.tenantId,
        jobId: job.id,
        plotCode: job.plotCode,
        deviceId: job.deviceId,
        kind: "ESTOP",
        level: "CRITICAL",
        message: `人工急停：${dispatched ? `指令已下发（${dispatched.commandId}）` : "指令下发失败，需现场处置"}`,
      });
    }
    return updated;
  };

  return { run, stop };
}
