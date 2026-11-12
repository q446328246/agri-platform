import { EventTopic } from "@agri/contracts";
import type { FertilizationFinishedPayload, IrrigationFinishedPayload } from "@agri/contracts";

import { buildIrrigationPlan } from "./command-spec.js";
import type { FertilizerRecipe, IrrigationPlan, IrrigationPlanInput } from "./command-spec.js";
import type { ControlCommand, ControlCommandType } from "./control.repository.js";

/**
 * DONE 回执 → 作业完成事件。
 *
 * 「这块地灌了多少水、施了多少肥、作业多久」是决策与档案侧想知道的事实，但平台不替设备测量：
 * 数值只有两条正路——设备在回执里实测上报，或按指令参数现算方案总量。
 * 两条路都走不通（例如阈值自动指令只带网格信息、没有分区）就留空并说清来源，
 * 宁缺不造：把估算值当实测值推出去，下游的用水用肥统计就全歪了。
 *
 * 只有水肥机能计量的灌溉与施肥结单发事件。播种、除草、急停的参数里没有可核对的作业量，
 * 发一条「完成了但不知道做了什么」的事件只会让档案多一条空记录。
 */

/** 结单事件：主题与载荷按指令类型二选一 */
export type FinishedEvent =
  | { topic: typeof EventTopic.ControlIrrigationFinished; payload: IrrigationFinishedPayload }
  | { topic: typeof EventTopic.ControlFertilizationFinished; payload: FertilizationFinishedPayload };

/** 会结单发事件的指令类型 → 主题，新增可计量类型时在这里登记 */
const FINISHED_TOPIC_BY_TYPE: Partial<Record<ControlCommandType, FinishedEvent["topic"]>> = {
  IRRIGATION: EventTopic.ControlIrrigationFinished,
  FERTILIZATION: EventTopic.ControlFertilizationFinished,
};

/** 回执里可采纳的非负数值；非法或缺省返回 undefined */
function reportedNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 指令参数里的水肥配比；缺失或形状不对时按无配方处理 */
function recipeOf(command: ControlCommand): FertilizerRecipe | undefined {
  const recipe = command.parameters.recipe;
  if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe)) return undefined;
  return recipe as FertilizerRecipe;
}

/**
 * 按指令参数现算灌溉方案。
 * 分区缺失或历史脏参数（面积非法、配比越界）会让方案算不出来，
 * 此时返回 undefined 让调用方留空，而不是把结单接口带崩或编一个数。
 */
function planOf(command: ControlCommand, recipe?: FertilizerRecipe): IrrigationPlan | undefined {
  const zones = command.parameters.zones;
  if (!Array.isArray(zones) || zones.length === 0) return undefined;
  const flowM3h = reportedNumber(command.parameters.flowM3h);
  try {
    return buildIrrigationPlan({
      zones: zones as IrrigationPlanInput["zones"],
      ...(flowM3h === undefined ? {} : { flowM3h }),
      ...(recipe === undefined ? {} : { recipe }),
    });
  } catch {
    return undefined;
  }
}

/** 用水量（立方米）：设备实测优先，其次按分区参数现算方案总量；都无从得出时缺省 */
export function resolveWaterVolume(
  command: ControlCommand,
  result?: Record<string, unknown>,
): { waterVolume: number; waterVolumeSource: "DEVICE" | "PLAN" } | undefined {
  const reported = reportedNumber(result?.waterVolumeM3);
  if (reported !== undefined) return { waterVolume: reported, waterVolumeSource: "DEVICE" };
  const plan = planOf(command);
  return plan === undefined ? undefined : { waterVolume: plan.totalWaterVolume, waterVolumeSource: "PLAN" };
}

/**
 * 施肥量（千克，氮磷钾合计）：设备实测优先，其次按分区面积 × 配比现算配方总量。
 * 处方自动指令的参数里没有分区与配比，算不出来就留空——
 * 配方项的 dosage 是「亩均用量」，不知道作业面积就乘不出总投肥量。
 */
export function resolveFertilizerKg(
  command: ControlCommand,
  result?: Record<string, unknown>,
): { fertilizerKg: number; fertilizerSource: "DEVICE" | "PLAN" } | undefined {
  const reported = reportedNumber(result?.fertilizerKg);
  if (reported !== undefined) return { fertilizerKg: reported, fertilizerSource: "DEVICE" };
  const plan = planOf(command, recipeOf(command));
  const totalKg = plan?.recipe?.totalKg;
  return totalKg === undefined ? undefined : { fertilizerKg: totalKg, fertilizerSource: "PLAN" };
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

/** 组装结单事件载荷；指令类型不参与结单回流时返回 undefined */
export function buildFinishedEvent(
  command: ControlCommand,
  finishedAt: string,
  result?: Record<string, unknown>,
): FinishedEvent | undefined {
  const topic = FINISHED_TOPIC_BY_TYPE[command.type];
  if (!topic) return undefined;
  const base = {
    commandId: command.id,
    parcelId: command.plotCode,
    deviceId: command.deviceId,
    ...resolveDurationMin(command, finishedAt, result),
    finishedAt,
  };
  return topic === EventTopic.ControlIrrigationFinished
    ? { topic, payload: { ...base, ...(resolveWaterVolume(command, result) ?? {}) } }
    : { topic, payload: { ...base, ...(resolveFertilizerKg(command, result) ?? {}) } };
}
