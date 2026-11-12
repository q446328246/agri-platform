import type { IrrigationFinishedPayload } from "@agri/contracts";

import { buildIrrigationPlan } from "./command-spec.js";
import type { IrrigationPlanInput } from "./command-spec.js";
import type { ControlCommand } from "./control.repository.js";

/**
 * DONE 回执 → `control.irrigation.finished` 载荷。
 *
 * 「这块地灌了多少水、灌了多久」是决策与档案侧想知道的事实，但平台不替设备测量：
 * 数值只有两条正路——设备在回执里实测上报，或按指令的分区参数现算方案总量。
 * 两条路都走不通（例如阈值自动指令只带网格信息、没有分区）就留空并说清来源，
 * 宁缺不造：把估算值当实测值推出去，下游的用水统计就全歪了。
 */

/** 回执里可采纳的非负数值；非法或缺省返回 undefined */
function reportedNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 用水量（立方米）：设备实测优先，其次按分区参数现算方案总量；都无从得出时缺省 */
export function resolveWaterVolume(
  command: ControlCommand,
  result?: Record<string, unknown>,
): { waterVolume: number; waterVolumeSource: "DEVICE" | "PLAN" } | undefined {
  const reported = reportedNumber(result?.waterVolumeM3);
  if (reported !== undefined) return { waterVolume: reported, waterVolumeSource: "DEVICE" };

  const zones = command.parameters.zones;
  if (!Array.isArray(zones) || zones.length === 0) return undefined;
  const flowM3h = reportedNumber(command.parameters.flowM3h);
  try {
    return {
      waterVolume: buildIrrigationPlan({ zones: zones as IrrigationPlanInput["zones"], ...(flowM3h === undefined ? {} : { flowM3h }) })
        .totalWaterVolume,
      waterVolumeSource: "PLAN",
    };
  } catch {
    // 历史脏参数（分区缺面积或定额越界）不该把结单接口带崩，也不该编一个用水量
    return undefined;
  }
}

/**
 * 作业时长（分钟）：设备实测优先，否则由时间戳现算。
 * 起点取 `ackedAt ?? sentAt ?? createdAt`——与超时口径同一个「最后一次状态推进时间」，
 * 没有下发时刻的历史行只能退到入队时间，此时时长是上界，来源标记为 RUNTIME。
 */
export function resolveDurationMin(
  command: ControlCommand,
  finishedAt: string,
  result?: Record<string, unknown>,
): { durationMin: number; durationSource: "DEVICE" | "RUNTIME" } {
  const reported = reportedNumber(result?.durationMin);
  if (reported !== undefined) return { durationMin: reported, durationSource: "DEVICE" };
  const startMs = Date.parse(command.ackedAt ?? command.sentAt ?? command.createdAt);
  const endMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { durationMin: 0, durationSource: "RUNTIME" };
  return { durationMin: Math.max(0, Math.round((endMs - startMs) / 60_000)), durationSource: "RUNTIME" };
}

/** 组装灌溉完成事件载荷 */
export function buildIrrigationFinished(
  command: ControlCommand,
  finishedAt: string,
  result?: Record<string, unknown>,
): IrrigationFinishedPayload {
  const water = resolveWaterVolume(command, result);
  return {
    commandId: command.id,
    parcelId: command.plotCode,
    deviceId: command.deviceId,
    ...(water === undefined ? {} : water),
    ...resolveDurationMin(command, finishedAt, result),
    finishedAt,
  };
}
