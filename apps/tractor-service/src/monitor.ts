import { randomUUID } from "node:crypto";

import type { EventTopicValue } from "@agri/contracts";

import type { TractorJob, TractorJobRepository, TractorJobStatus } from "./job.repository.js";
import type { TractorSafetyEventRepository } from "./safety-event.repository.js";
import type { TrajectoryRepository } from "./trajectory.repository.js";
import type { ControlDispatchInput, JobActionLock } from "./executor.js";
import { pendingResumeOf, recordSafetyEvent, TractorCommandError } from "./executor.js";
import { distanceToPolylineM } from "./trajectory.js";

/** 最新 RTK 定位采样：经纬度、水平精度、定位状态与上报时刻 */
export interface RtkSample {
  lng?: number;
  lat?: number;
  hdop?: number;
  hasFix?: boolean;
  recordedAt?: string;
}

export interface TractorMonitorDeps {
  withJobAction?: JobActionLock;
  tenantId: string;
  jobs: TractorJobRepository;
  safetyEvents: TractorSafetyEventRepository;
  /** 取设备最新 RTK 定位，无数据返回 null */
  fetchRtk: (deviceId: string) => Promise<RtkSample | null>;
  /** 围栏判定：true 界内、false 越界、null 表示边界不可用，本轮跳过位置判定 */
  insideGeofence: (plotCode: string, lng: number, lat: number) => Promise<boolean | null>;
  /** 向控制服务下发处置指令（PAUSE/ESTOP） */
  dispatch: (input: ControlDispatchInput) => Promise<{ commandId: string } | null>;
  /** 对账未确认恢复；装配执行器后由其重新读取状态并在作业锁内处置 */
  reconcileSafetyUnknown?: (job: TractorJob) => Promise<unknown>;
  /** 等待处置指令设备侧 DONE 确认；PAUSED 等其他状态均不算处置完成 */
  waitCommand: (tenantId: string, deviceId: string, commandId: string, timeoutMs: number) => Promise<"DONE" | "FAILED" | "PAUSED" | "TIMEOUT" | "UNAVAILABLE">;
  safetyCommandTimeoutMs?: number;
  publish?: (topic: EventTopicValue, payload: unknown) => Promise<void>;
  /** 监测周期（毫秒），缺省 5 秒 */
  intervalMs?: number;
  /** 失联判定：超过该秒数无定位上报视为通信失联，缺省 30 秒 */
  commLossSeconds?: number;
  /** RTK 质量门限（HDOP），缺省 2.0 */
  rtkHdopMax?: number;
  /** 轨迹台账：取作业轨迹做跟随偏离判定；缺省不做该判定 */
  trajectories?: TrajectoryRepository;
  /** 轨迹跟随偏离门限（米），缺省 5：RTK 位置离轨迹折线超过该值即判偏离 */
  trajectoryDeviationMaxM?: number;
  now?: () => Date;
  onError?: (error: Error, phase: string) => void;
}

export interface TractorMonitor {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * 作业期安全监测：对每条在途作业轮询 RTK 定位，执行四道在途安全判定——
 * - 通信失联：无定位上报超时 → 急停收口；
 * - RTK 质量劣化：无有效定位或 HDOP 超门限 → 暂停；
 * - 电子围栏越界：位置出界 → 首次暂停、再次越界升级为急停；
 * - 轨迹跟随偏离：带轨迹的作业在界内但离轨迹折线过远 → 首次暂停、持续偏离升级急停。
 * 所有安全指令必须经控制侧 DONE 确认并 CAS 成功后才写安全状态与成功事件。
 */
export function createTractorMonitor(deps: TractorMonitorDeps): TractorMonitor {
  const intervalMs = deps.intervalMs ?? 5_000;
  const commLossSeconds = deps.commLossSeconds ?? 30;
  const rtkHdopMax = deps.rtkHdopMax ?? 2;
  const now = deps.now ?? ((): Date => new Date());
  const onError = deps.onError ?? ((error: Error, phase: string): void => { console.error("[tractor] 安全监测失败", { phase, message: error.message }); });
  const breachCounts = new Map<string, number>();
  const breachWatch = new Set<string>();
  const deviationCounts = new Map<string, number>();
  const deviationWatch = new Set<string>();
  const safetyAttempts = new Map<string, { attempt: number; rejected: boolean }>();
  const safetyRunId = randomUUID();
  const trajectoryDeviationMaxM = deps.trajectoryDeviationMaxM ?? 5;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const confirmAndUpdate = async (
    job: TractorJob,
    type: "PAUSE" | "ESTOP",
    expectedStatus: TractorJobStatus,
    patch: { status: "PAUSED" | "ESTOPPED" | "SAFETY_UNKNOWN"; reason: string; finishedAt?: string },
    stillCurrent?: (job: TractorJob) => boolean,
  ): Promise<string> => {
    const confirm = async (): Promise<string> => {
      const current = await deps.jobs.findJob(deps.tenantId, job.id);
      if (!current || current.status !== job.status || (stillCurrent && !stillCurrent(current))) {
        throw new TractorCommandError("作业状态在安全处置前已变化，本次监测不再下发");
      }
      job = current;
      const expectedRunRevision = current.runRevision;
      let targetCommandId: string | null = null;
      if (type === "PAUSE") {
        const stages = await deps.jobs.listStages(deps.tenantId, job.id);
        targetCommandId = stages.find((stage) => stage.status === "SENT" && stage.commandId)?.commandId ?? null;
        if (!targetCommandId) throw new TractorCommandError("当前没有可暂停的在途分步指令");
      }
      const attemptKey = `${job.id}:${type}:${targetCommandId ?? "device"}`;
      const attempt = safetyAttempts.get(attemptKey) ?? { attempt: 0, rejected: false };
      const dispatched = await deps.dispatch({
        tenantId: deps.tenantId,
        deviceId: job.deviceId,
        plotCode: job.plotCode,
        type,
        parameters: targetCommandId === null ? {} : { targetCommandId },
        operator: job.operator,
        idempotencyKey: `tractor:${job.id}:monitor:${type}:${targetCommandId ?? "device"}:${safetyRunId}:${attempt.attempt}`,
      }).catch(() => {
        safetyAttempts.set(attemptKey, { attempt: attempt.attempt, rejected: false });
        throw new TractorCommandError(`${type} 指令下发结果未知，保留同一幂等键等待重试`, 503);
      });
      if (!dispatched) {
        safetyAttempts.set(attemptKey, attempt.rejected
          ? { attempt: attempt.attempt + 1, rejected: false }
          : { attempt: attempt.attempt, rejected: true });
        throw new TractorCommandError(`${type} 指令下发被控制侧拒绝，作业状态未变更`);
      }
      const result = await deps.waitCommand(deps.tenantId, job.deviceId, dispatched.commandId, deps.safetyCommandTimeoutMs ?? 30_000);
      if (result === "DONE") safetyAttempts.set(attemptKey, { attempt: attempt.attempt + 1, rejected: false });
      else if (result === "FAILED") safetyAttempts.set(attemptKey, { attempt: attempt.attempt + 1, rejected: false });
      else safetyAttempts.set(attemptKey, { attempt: attempt.attempt, rejected: false });
      if (result !== "DONE") {
        const detail = result === "TIMEOUT" ? "确认超时" : result === "UNAVAILABLE" ? "确认服务不可用" : "执行失败";
        throw new TractorCommandError(`${type} 指令${detail}，作业状态未变更`);
      }
      const updated = await deps.jobs.updateJob(deps.tenantId, job.id, patch, { expectedStatus, expectedRunRevision });
      if (!updated) throw new TractorCommandError("等待控制确认期间作业状态已变化，本次监测不再改写");
      return dispatched.commandId;
    };
    return deps.withJobAction
      ? deps.withJobAction(`${deps.tenantId}:${job.id}`, confirm)
      : confirm();
  };

  const tick = async (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const active: TractorJob[] = [];
      const size = 200;
      for (const status of ["RUNNING", "SAFETY_UNKNOWN"] as const) {
        for (let offset = 0; ; offset += size) {
          const records = await deps.jobs.listJobs({ tenantId: deps.tenantId, status, limit: size, offset });
          active.push(...records);
          if (records.length < size) break;
        }
      }
      const watched = await Promise.all([...breachWatch].map((jobId) => deps.jobs.findJob(deps.tenantId, jobId)));
      const deviated = await Promise.all([...deviationWatch].map((jobId) => deps.jobs.findJob(deps.tenantId, jobId)));
      const resuming: TractorJob[] = [];
      const pausedSize = 200;
      for (let offset = 0; ; offset += pausedSize) {
        const records = await deps.jobs.listJobs({ tenantId: deps.tenantId, status: "PAUSED", limit: pausedSize, offset });
        resuming.push(...records.filter((job) => pendingResumeOf(job) !== null));
        if (records.length < pausedSize) break;
      }
      // 去重：同一作业可能同时在越界与偏离观察集，避免同一 tick 内重复处置。
      const seen = new Set<string>();
      const jobs = [
        ...active,
        ...watched.filter((job): job is NonNullable<typeof job> => job !== null && job.status === "PAUSED"),
        ...deviated.filter((job): job is NonNullable<typeof job> => job !== null && job.status === "PAUSED"),
        ...resuming,
      ].filter((job) => (seen.has(job.id) ? false : (seen.add(job.id), true)));
      for (const job of jobs) {
        try {
          const hasPendingResume = pendingResumeOf(job) !== null;
          if ((hasPendingResume || job.status === "SAFETY_UNKNOWN") && deps.reconcileSafetyUnknown) {
            try {
              await deps.reconcileSafetyUnknown(job);
            } catch (error) {
              if (!(error instanceof TractorCommandError)) throw error;
            }
            continue;
          }
          if (hasPendingResume) {
            await confirmAndUpdate(job, "ESTOP", job.status, {
              status: "SAFETY_UNKNOWN",
              reason: "存在未确认的恢复意图，已急停并保持 SAFETY_UNKNOWN 等待对账",
            }, (current) => pendingResumeOf(current) !== null);
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "ESTOP", level: "CRITICAL",
              message: "发现未确认的 RESUME 持久化意图，已再次急停，作业保持 SAFETY_UNKNOWN 等待人工核实",
            });
            continue;
          }
          if (job.status === "SAFETY_UNKNOWN") {
            await confirmAndUpdate(job, "ESTOP", "SAFETY_UNKNOWN", {
              status: "SAFETY_UNKNOWN",
              reason: "恢复结果未知，急停已再次确认，仍需人工核实 RESUME 是否已取消",
            });
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "ESTOP", level: "CRITICAL",
              message: "恢复指令结果未知，已再次确认急停，作业保持 SAFETY_UNKNOWN 等待人工核实",
            });
            continue;
          }
          const sample = await deps.fetchRtk(job.deviceId).catch(() => null);
          const recordedMs = sample?.recordedAt ? Date.parse(sample.recordedAt) : NaN;
          if (!sample || !Number.isFinite(recordedMs) || now().getTime() - recordedMs > commLossSeconds * 1000) {
            await confirmAndUpdate(job, "ESTOP", job.status, { status: "ESTOPPED", reason: "通信失联急停", finishedAt: now().toISOString() });
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "COMM_LOSS", level: "CRITICAL",
              message: `超过 ${commLossSeconds} 秒无 RTK 定位上报，已急停收口`,
            });
            breachCounts.delete(job.id);
            breachWatch.delete(job.id);
            continue;
          }
          if (sample.hasFix !== true || sample.hdop === undefined || !Number.isFinite(sample.hdop) || sample.hdop > rtkHdopMax) {
            if (job.status === "RUNNING") {
              await confirmAndUpdate(job, "PAUSE", "RUNNING", { status: "PAUSED", reason: "RTK 质量劣化暂停" });
              await recordSafetyEvent(deps, {
                tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
                kind: "RTK_QUALITY", level: "WARNING",
                message: `RTK 定位无效或 HDOP ${sample.hdop ?? "缺测"} 超过门限 ${rtkHdopMax}，已暂停作业`,
              });
            }
            continue;
          }
          if (sample.lng === undefined || sample.lat === undefined || !Number.isFinite(sample.lng) || !Number.isFinite(sample.lat)) continue;
          const stages = await deps.jobs.listStages(deps.tenantId, job.id);
          if (stages[job.currentStage]?.stage !== "OPERATION") continue;
          const inside = await deps.insideGeofence(job.plotCode, sample.lng, sample.lat);
          if (inside === null && breachWatch.has(job.id)) {
            await confirmAndUpdate(job, "ESTOP", job.status, { status: "ESTOPPED", reason: "越界暂停后围栏判定不可用，升级急停", finishedAt: now().toISOString() });
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "GEOFENCE_BREACH", level: "CRITICAL",
              message: "越界暂停后围栏判定不可用，无法确认设备已回到安全区域，已升级为急停收口",
              lng: sample.lng, lat: sample.lat,
            });
            breachCounts.delete(job.id);
            breachWatch.delete(job.id);
            continue;
          }
          if (inside !== false) {
            if (inside === true) {
              breachCounts.delete(job.id);
              breachWatch.delete(job.id);
            }
            if (deps.trajectories) {
              const trajectory = await deps.trajectories.findByJob(deps.tenantId, job.id).catch(() => null);
              if (trajectory && trajectory.path.length >= 2) {
                const deviationM = distanceToPolylineM({ lng: sample.lng, lat: sample.lat }, trajectory.path);
                if (deviationM <= trajectoryDeviationMaxM) {
                  deviationCounts.delete(job.id);
                  deviationWatch.delete(job.id);
                  continue;
                }
                const count = (deviationCounts.get(job.id) ?? 0) + 1;
                if (job.status === "PAUSED" || count > 1) {
                  await confirmAndUpdate(job, "ESTOP", job.status, { status: "ESTOPPED", reason: "轨迹偏离升级急停", finishedAt: now().toISOString() });
                  await recordSafetyEvent(deps, {
                    tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
                    kind: "TRAJECTORY_DEVIATION", level: "CRITICAL",
                    message: `暂停后仍持续偏离轨迹（第 ${count} 次，偏离 ${deviationM.toFixed(1)} 米），已升级为急停收口`,
                    lng: sample.lng, lat: sample.lat,
                  });
                  deviationCounts.delete(job.id);
                  deviationWatch.delete(job.id);
                } else {
                  await confirmAndUpdate(job, "PAUSE", "RUNNING", { status: "PAUSED", reason: "轨迹跟随偏离暂停" });
                  deviationCounts.set(job.id, count);
                  deviationWatch.add(job.id);
                  await recordSafetyEvent(deps, {
                    tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
                    kind: "TRAJECTORY_DEVIATION", level: "WARNING",
                    message: `RTK 位置偏离轨迹 ${deviationM.toFixed(1)} 米（门限 ${trajectoryDeviationMaxM} 米），已暂停作业`,
                    lng: sample.lng, lat: sample.lat,
                  });
                }
                continue;
              }
            }
            continue;
          }
          const count = (breachCounts.get(job.id) ?? 0) + 1;
          if (job.status === "PAUSED" || count > 1) {
            await confirmAndUpdate(job, "ESTOP", job.status, { status: "ESTOPPED", reason: "越界升级急停", finishedAt: now().toISOString() });
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "GEOFENCE_BREACH", level: "CRITICAL",
              message: `暂停后仍持续越界（第 ${count} 次），已升级为急停收口`,
              lng: sample.lng, lat: sample.lat,
            });
            breachCounts.delete(job.id);
            breachWatch.delete(job.id);
          } else {
            await confirmAndUpdate(job, "PAUSE", "RUNNING", { status: "PAUSED", reason: "电子围栏越界暂停" });
            breachCounts.set(job.id, count);
            breachWatch.add(job.id);
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "GEOFENCE_BREACH", level: "WARNING",
              message: `作业位置越过地块边界（余量内判定为出界），已暂停作业`,
              lng: sample.lng, lat: sample.lat,
            });
          }
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)), `tick:${job.id}`);
        }
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };

  return {
    tick,
    start(): void {
      timer = setInterval(() => { void tick(); }, intervalMs);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
