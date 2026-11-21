import type { EventTopicValue } from "@agri/contracts";

import type { TractorJobRepository } from "./job.repository.js";
import type { TractorSafetyEventRepository } from "./safety-event.repository.js";
import type { ControlDispatchInput } from "./executor.js";
import { recordSafetyEvent } from "./executor.js";

/** 最新 RTK 定位采样：经纬度、水平精度、定位状态与上报时刻 */
export interface RtkSample {
  lng?: number;
  lat?: number;
  hdop?: number;
  hasFix?: boolean;
  recordedAt?: string;
}

export interface TractorMonitorDeps {
  jobs: TractorJobRepository;
  safetyEvents: TractorSafetyEventRepository;
  /** 取设备最新 RTK 定位，无数据返回 null */
  fetchRtk: (deviceId: string) => Promise<RtkSample | null>;
  /** 围栏判定：位置是否在地块边界内（含安全余量），true 表示在界内 */
  insideGeofence: (plotCode: string, lng: number, lat: number) => Promise<boolean>;
  /** 向控制服务下发处置指令（PAUSE/ESTOP） */
  dispatch: (input: ControlDispatchInput) => Promise<{ commandId: string } | null>;
  publish?: (topic: EventTopicValue, payload: unknown) => Promise<void>;
  /** 监测周期（毫秒），缺省 5 秒 */
  intervalMs?: number;
  /** 失联判定：超过该秒数无定位上报视为通信失联，缺省 30 秒 */
  commLossSeconds?: number;
  /** RTK 质量门限（HDOP），缺省 2.0 */
  rtkHdopMax?: number;
  now?: () => Date;
  onError?: (error: Error, phase: string) => void;
}

export interface TractorMonitor {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * 作业期安全监测：对每条在途作业轮询 RTK 定位，执行三道在途安全判定——
 * - 通信失联：无定位上报超时 → 急停收口；
 * - RTK 质量劣化：HDOP 超门限 → 暂停（定位不可靠时不做精准作业）；
 * - 电子围栏越界：位置出界 → 首次暂停、再次越界升级为急停。
 * 所有处置都留安全事件并发布，越界处置带触发位置。
 */
export function createTractorMonitor(deps: TractorMonitorDeps): TractorMonitor {
  const intervalMs = deps.intervalMs ?? 5_000;
  const commLossSeconds = deps.commLossSeconds ?? 30;
  const rtkHdopMax = deps.rtkHdopMax ?? 2;
  const now = deps.now ?? ((): Date => new Date());
  const onError = deps.onError ?? ((error: Error, phase: string): void => { console.error("[tractor] 安全监测失败", { phase, message: error.message }); });
  // 越界计数按作业累计：回界内清零，暂停后恢复作业从零重新计数
  const breachCounts = new Map<string, number>();
  // 越界观察集：首次越界暂停的作业继续受监测，暂停后仍越界即升级急停；
  // 人工恢复或处置后作业状态离开 PAUSED，自动移出观察集
  const breachWatch = new Set<string>();
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      const [active, watched] = await Promise.all([
        deps.jobs.listJobs({ status: "RUNNING", limit: 50 }),
        Promise.all([...breachWatch].map((jobId) => deps.jobs.findJob(jobId))),
      ]);
      const jobs = [...active, ...watched.filter((job): job is NonNullable<typeof job> => job !== null && job.status === "PAUSED")];
      for (const job of jobs) {
        try {
          const sample = await deps.fetchRtk(job.deviceId).catch(() => null);
          const recordedMs = sample?.recordedAt ? Date.parse(sample.recordedAt) : NaN;
          if (!sample || !Number.isFinite(recordedMs) || now().getTime() - recordedMs > commLossSeconds * 1000) {
            await deps.dispatch({ deviceId: job.deviceId, plotCode: job.plotCode, type: "ESTOP", parameters: {}, operator: job.operator }).catch(() => null);
            await deps.jobs.updateJob(undefined, job.id, { status: "ESTOPPED", reason: "通信失联急停", finishedAt: now().toISOString() });
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "COMM_LOSS", level: "CRITICAL",
              message: `超过 ${commLossSeconds} 秒无 RTK 定位上报，已急停收口`,
            });
            breachCounts.delete(job.id);
            breachWatch.delete(job.id);
            continue;
          }
          if (sample.hdop !== undefined && sample.hdop > rtkHdopMax) {
            await deps.dispatch({ deviceId: job.deviceId, plotCode: job.plotCode, type: "PAUSE", parameters: {}, operator: job.operator }).catch(() => null);
            await deps.jobs.updateJob(undefined, job.id, { status: "PAUSED", reason: "RTK 质量劣化暂停" });
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "RTK_QUALITY", level: "WARNING",
              message: `RTK HDOP ${sample.hdop} 超过门限 ${rtkHdopMax}，已暂停作业`,
            });
            continue;
          }
          if (sample.lng === undefined || sample.lat === undefined) continue;
          const inside = await deps.insideGeofence(job.plotCode, sample.lng, sample.lat);
          if (inside) {
            breachCounts.delete(job.id);
            breachWatch.delete(job.id);
            continue;
          }
          const count = (breachCounts.get(job.id) ?? 0) + 1;
          breachCounts.set(job.id, count);
          if (count === 1) {
            await deps.dispatch({ deviceId: job.deviceId, plotCode: job.plotCode, type: "PAUSE", parameters: {}, operator: job.operator }).catch(() => null);
            await deps.jobs.updateJob(undefined, job.id, { status: "PAUSED", reason: "电子围栏越界暂停" });
            breachWatch.add(job.id);
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "GEOFENCE_BREACH", level: "WARNING",
              message: `作业位置越过地块边界（余量内判定为出界），已暂停作业`,
              lng: sample.lng, lat: sample.lat,
            });
          } else {
            await deps.dispatch({ deviceId: job.deviceId, plotCode: job.plotCode, type: "ESTOP", parameters: {}, operator: job.operator }).catch(() => null);
            await deps.jobs.updateJob(undefined, job.id, { status: "ESTOPPED", reason: "越界升级急停", finishedAt: now().toISOString() });
            await recordSafetyEvent(deps, {
              tenantId: job.tenantId, jobId: job.id, plotCode: job.plotCode, deviceId: job.deviceId,
              kind: "GEOFENCE_BREACH", level: "CRITICAL",
              message: `暂停后仍持续越界（第 ${count} 次），已升级为急停收口`,
              lng: sample.lng, lat: sample.lat,
            });
            breachCounts.delete(job.id);
            breachWatch.delete(job.id);
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
