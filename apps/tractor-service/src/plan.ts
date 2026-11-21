import type { TractorOperationType, TractorStageKind } from "./job.repository.js";

/**
 * 拖拉机作业计划算法（B2）。
 *
 * 一次作业拆成三条分步指令，复用控制服务的指令生命周期逐条下发：
 * 换具（TOOL_SWITCH）→ 作业（SEEDING/TILLAGE/WEEDING）→ 返航（RETURN_HOME）。
 * 每步的参数包络只由已确认口径现算：作业步带面积与作业时长，控制侧据此包络执行。
 */

export interface JobStagePlan {
  stage: TractorStageKind;
  /** 控制侧指令类型 */
  commandType: string;
  parameters: Record<string, unknown>;
  /** 等待该步收口的超时（毫秒） */
  timeoutMs: number;
}

export interface PlanOptions {
  /** 作业类型 → 机具编码。机具编码是设备协议约定，按现场设备资料经环境变量调整 */
  toolCodes?: Record<string, string>;
  /** 非作业步缺省超时（毫秒），缺省 10 分钟 */
  defaultTimeoutMs?: number;
  /** 作业步超时缓冲（毫秒），缺省 60 秒 */
  operationBufferMs?: number;
}

const DEFAULT_TOOL_CODES: Record<TractorOperationType, string> = {
  SEEDING: "SEEDER",
  TILLAGE: "PLOW",
  WEEDING: "WEEDER",
};

/**
 * 生成作业分步计划。
 * 作业参数必须带正的面积（亩）与作业时长（分钟），缺一即拒绝排程——
 * 包络靠现算，不接受缺参排程后现场猜。
 */
export function buildJobStages(
  operationType: TractorOperationType,
  parameters: Record<string, unknown>,
  options: PlanOptions = {},
): JobStagePlan[] {
  const areaMu = Number(parameters.areaMu);
  const durationMin = Number(parameters.durationMin);
  if (!Number.isFinite(areaMu) || areaMu <= 0) throw new Error("作业参数 areaMu 需为正数（亩）");
  if (!Number.isFinite(durationMin) || durationMin <= 0) throw new Error("作业参数 durationMin 需为正数（分钟）");

  const toolCodes = { ...DEFAULT_TOOL_CODES, ...(options.toolCodes ?? {}) };
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
  const operationTimeoutMs = durationMin * 60_000 + (options.operationBufferMs ?? 60_000);

  return [
    {
      stage: "TOOL_SWITCH",
      commandType: "TOOL_SWITCH",
      parameters: { toolCode: toolCodes[operationType] ?? operationType },
      timeoutMs: defaultTimeoutMs,
    },
    {
      stage: "OPERATION",
      commandType: operationType,
      parameters: { areaMu, durationMin },
      timeoutMs: operationTimeoutMs,
    },
    {
      stage: "RETURN_HOME",
      commandType: "RETURN_HOME",
      parameters: {},
      timeoutMs: defaultTimeoutMs,
    },
  ];
}
