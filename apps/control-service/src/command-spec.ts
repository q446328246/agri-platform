/**
 * 控制指令参数规范。
 *
 * 控制指令的 parameters 是自由 JSONB，历史上前端传什么就存什么，既无法校验也难复盘。
 * 这里为水肥场景定义最小可校验结构：
 * - 变量灌溉：按分区给出目标灌水定额，换算用水量与阀门时序，并生成累计供水曲线；
 * - 水肥配比：氮磷钾配比（kg/亩）与搅拌参数（时长、转速）。
 * 非水肥类指令保持原有自由参数，不在这里收口，避免影响播种/除草既有调用方。
 */

/** 分区灌溉参数 */
export interface IrrigationZone {
  /** 分区编码，缺省按顺序编号 */
  zoneCode?: string;
  /** 分区面积，单位：亩 */
  areaMu: number;
  /** 目标灌水定额，单位：毫米 */
  targetMm: number;
}

/** 搅拌参数 */
export interface StirSpec {
  /** 搅拌时长，单位：分钟 */
  durationMin: number;
  /** 搅拌转速，单位：转/分 */
  rpm: number;
}

/** 水肥配比，单位：千克/亩 */
export interface FertilizerRecipe {
  nitrogen: number;
  phosphorus: number;
  potassium: number;
}

/** 变量灌溉曲线入参 */
export interface IrrigationPlanInput {
  plotCode?: string;
  zones: IrrigationZone[];
  /** 单区供水流量，单位：立方米/小时，缺省 20 */
  flowM3h?: number;
  recipe?: FertilizerRecipe;
  stir?: StirSpec;
}

/** 曲线采样点：第几分钟、瞬时流量、累计用水量 */
export interface IrrigationCurvePoint {
  minute: number;
  flowM3h: number;
  cumulativeM3: number;
}

/** 分区调度结果 */
export interface IrrigationZonePlan extends Required<IrrigationZone> {
  waterVolume: number;
  durationMin: number;
  startMin: number;
  endMin: number;
}

/** 变量灌溉方案 */
export interface IrrigationPlan {
  plotCode: string;
  flowM3h: number;
  totalAreaMu: number;
  totalWaterVolume: number;
  totalDurationMin: number;
  zones: IrrigationZonePlan[];
  curve: IrrigationCurvePoint[];
  recipe?: FertilizerRecipe & { totalKg: number };
  stir?: StirSpec;
  warnings: string[];
}

/** 亩转平方米：1 亩 ≈ 666.67 平方米，1 毫米水深 = 1 升/平方米 */
const SQUARE_METERS_PER_MU = 666.67;
const DEFAULT_FLOW_M3H = 20;

/** 亩面积下的用水量，单位立方米 */
export function waterVolumeOf(areaMu: number, targetMm: number): number {
  return Number(((areaMu * SQUARE_METERS_PER_MU * targetMm) / 1000).toFixed(2));
}

/** 现场执行包络：网关只需要「开多久、开到多少」这两个数 */
export interface ExecutionPlan {
  totalDurationMin: number;
  totalWaterVolume: number;
}

/**
 * 从指令参数现算现场执行包络，供入队时写进 `parameters.plan`。
 *
 * 「阀门该开多久」在平台里只由分区面积与灌水定额推出（见 `buildIrrigationPlan`），
 * 现场网关不重算一遍，否则亩转平方米、默认流量这两个常数就有两份口径。
 * 非水肥指令、以及处方自动指令（参数里没有分区）算不出包络，返回 undefined 让调用方不写这个字段。
 */
export function executionPlanOf(type: string, parameters: Record<string, unknown>): ExecutionPlan | undefined {
  if (type !== "IRRIGATION" && type !== "FERTILIZATION") return undefined;
  const zones = parameters.zones;
  if (!Array.isArray(zones) || zones.length === 0) return undefined;
  const flowM3h = Number(parameters.flowM3h);
  try {
    const plan = buildIrrigationPlan({
      zones: zones as IrrigationPlanInput["zones"],
      ...(Number.isFinite(flowM3h) && flowM3h > 0 ? { flowM3h } : {}),
    });
    return { totalDurationMin: plan.totalDurationMin, totalWaterVolume: plan.totalWaterVolume };
  } catch {
    return undefined;
  }
}

/** 校验水肥相关参数，返回错误明细；空数组表示通过 */
export function validateIrrigationParameters(parameters: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (parameters.zones !== undefined) {
    if (!Array.isArray(parameters.zones)) {
      errors.push("zones 必须是数组");
    } else if (parameters.zones.length === 0) {
      errors.push("zones 不能为空");
    } else {
      parameters.zones.forEach((zone, index) => {
        const item = zone as Record<string, unknown>;
        const areaMu = Number(item.areaMu);
        const targetMm = Number(item.targetMm);
        if (!(areaMu > 0)) errors.push(`第 ${index + 1} 个分区 areaMu 必须大于 0`);
        if (!(targetMm > 0 && targetMm <= 100)) errors.push(`第 ${index + 1} 个分区 targetMm 需在 0 到 100 之间`);
      });
    }
  }
  const flow = parameters.flowM3h;
  if (flow !== undefined && !(Number(flow) > 0 && Number(flow) <= 500)) errors.push("flowM3h 需在 0 到 500 之间");
  const recipe = parameters.recipe as Record<string, unknown> | undefined;
  if (recipe !== undefined) {
    if (typeof recipe !== "object" || recipe === null) {
      errors.push("recipe 必须是对象");
    } else {
      const values = ["nitrogen", "phosphorus", "potassium"].map((key) => Number(recipe[key]));
      if (values.some((value) => !Number.isFinite(value) || value < 0)) errors.push("配比氮磷钾必须是非负数");
      else if (values.reduce((sum, value) => sum + value, 0) <= 0) errors.push("配比氮磷钾不能全为 0");
    }
  }
  const stir = parameters.stir as Record<string, unknown> | undefined;
  if (stir !== undefined) {
    if (typeof stir !== "object" || stir === null) {
      errors.push("stir 必须是对象");
    } else {
      const durationMin = Number(stir.durationMin);
      const rpm = Number(stir.rpm);
      if (!(durationMin >= 1 && durationMin <= 120)) errors.push("搅拌时长需在 1 到 120 分钟之间");
      if (!(rpm >= 0 && rpm <= 300)) errors.push("搅拌转速需在 0 到 300 转/分之间");
    }
  }
  return errors;
}

/** 校验指令参数：仅水肥类指令进入细分校验 */
export function validateCommandParameters(type: string, parameters: Record<string, unknown>): string[] {
  if (type === "IRRIGATION" || type === "FERTILIZATION") return validateIrrigationParameters(parameters);
  return [];
}

/**
 * 生成变量灌溉方案。
 *
 * 分区按顺序轮流开启：单区用水量 = 面积 × 定额，时长 = 用水量 / 流量，
 * 曲线按 5 分钟采样，用于前端画「累计供水」折线并核对总量。
 */
export function buildIrrigationPlan(input: IrrigationPlanInput): IrrigationPlan {
  const errors = validateIrrigationParameters({ zones: input.zones, ...(input.flowM3h !== undefined ? { flowM3h: input.flowM3h } : {}), ...(input.recipe ? { recipe: input.recipe } : {}), ...(input.stir ? { stir: input.stir } : {}) });
  if (errors.length > 0) throw new Error(errors.join("；"));

  const flowM3h = input.flowM3h && input.flowM3h > 0 ? input.flowM3h : DEFAULT_FLOW_M3H;
  const warnings: string[] = [];
  let cursorMin = 0;
  const zones: IrrigationZonePlan[] = input.zones.map((zone, index) => {
    const areaMu = Number(zone.areaMu);
    const targetMm = Number(zone.targetMm);
    const waterVolume = waterVolumeOf(areaMu, targetMm);
    const durationMin = Number(((waterVolume / flowM3h) * 60).toFixed(1));
    const plan: IrrigationZonePlan = {
      zoneCode: zone.zoneCode?.trim() || `ZONE-${String(index + 1).padStart(2, "0")}`,
      areaMu,
      targetMm,
      waterVolume,
      durationMin,
      startMin: Number(cursorMin.toFixed(1)),
      endMin: Number((cursorMin + durationMin).toFixed(1)),
    };
    cursorMin += durationMin;
    return plan;
  });

  const totalWaterVolume = Number(zones.reduce((sum, zone) => sum + zone.waterVolume, 0).toFixed(2));
  const totalDurationMin = Number(cursorMin.toFixed(1));
  if (totalDurationMin > 240) warnings.push("总时长超过 4 小时，建议分次灌溉以避免深层渗漏");

  const curve: IrrigationCurvePoint[] = [];
  for (let minute = 0; minute <= totalDurationMin; minute += 5) {
    const active = zones.find((zone) => minute >= zone.startMin && minute < zone.endMin);
    const cumulative = Number(Math.min(totalWaterVolume, (flowM3h * minute) / 60).toFixed(2));
    curve.push({ minute, flowM3h: active ? flowM3h : 0, cumulativeM3: cumulative });
  }

  const plan: IrrigationPlan = { plotCode: input.plotCode ?? "", flowM3h, totalAreaMu: Number(zones.reduce((sum, zone) => sum + zone.areaMu, 0).toFixed(2)), totalWaterVolume, totalDurationMin, zones, curve, warnings };
  if (input.recipe) {
    const totalAreaMu = plan.totalAreaMu;
    plan.recipe = {
      ...input.recipe,
      totalKg: Number(((input.recipe.nitrogen + input.recipe.phosphorus + input.recipe.potassium) * totalAreaMu).toFixed(2)),
    };
  }
  if (input.stir) plan.stir = input.stir;
  return plan;
}
