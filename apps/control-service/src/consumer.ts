import "reflect-metadata";

import type { DomainEvent, PrescriptionIssuedPayload, ThresholdBreachedPayload } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import {
  buildHandlers,
  EventDispatcher,
  EventLogConsumer,
  IdempotencyGuard,
  InMemoryIdempotencyStore,
  registerHandler,
} from "@agri/mq";
import type { EventLogStore } from "@agri/mq";

import type { ControlCommand, ControlCommandRepository, ControlCommandType } from "./control.repository.js";
import { executionPlanOf } from "./command-spec.js";
import type { IrrigationZone } from "./command-spec.js";

/**
 * 控制指令的事件消费。
 *
 * 越限与处方事件里已经包含「地块 + 处置建议」，控制侧只需要翻译成设备可执行
 * 的水肥指令并入队，因此这里不给指令做二次决策：是否补水、补多少由处方与
 * 阈值确定，控制侧只负责落成立即执行的动作。
 *
 * 只有能直接由水肥设备执行的场景才生成指令；植保作业与其它指标越限仍由
 * 消息中心提醒人工处置，避免自动下发与作业计划冲突。反向的保护同样自动：
 * 墒情高于上限时撤回未领取的灌溉指令（自动停灌），见 stopIrrigation。
 */

/** 处方类型对应的水肥指令类型 */
const COMMAND_BY_PLAN: Record<PrescriptionIssuedPayload["planType"], ControlCommandType | undefined> = {
  irrigation: "IRRIGATION",
  fertilization: "FERTILIZATION",
  pesticide: undefined,
};

/** 处方类型中文名，用于指令缘由 */
const PLAN_LABELS: Record<PrescriptionIssuedPayload["planType"], string> = {
  irrigation: "灌溉",
  fertilization: "施肥",
  pesticide: "植保",
};

/** 自动指令的执行人标识，与人工指令的账号区分 */
const AUTO_OPERATOR = "system:event";

/** 越限补灌定额缺省值（毫米）：D3 口径一固定补灌量，确认范围 10–20 mm/次，缺省取 15，可按土壤质地与作物需水用环境变量调整 */
export const DEFAULT_SUPPLEMENT_IRRIGATION_MM = 15;

/** 自动控制不得把缺失地块映射成 unbound 设备。 */
function requireParcelId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("自动控制事件 parcelId 必须为非空字符串");
  return value.trim();
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 由事件构造自动指令。
 * @param event 领域事件
 * @param command 指令类型与缘由
 * @param parameters 设备执行参数
 * @param deviceId 目标设备标识：自动指令必须落到台账里的真实设备，
 * 平台侧不产生 auto-* 伪设备——伪设备没有领取方，指令会永远停在 QUEUED
 */
function buildCommand(
  event: DomainEvent,
  type: ControlCommandType,
  reason: string,
  parameters: Record<string, unknown>,
  deviceId: string,
): ControlCommand {
  const plotCode = requireParcelId((event.payload as { parcelId?: unknown }).parcelId);
  if (typeof event.eventId !== "string" || !event.eventId.trim()) throw new Error("自动控制事件 eventId 不能为空");
  // 事件消费不走 HTTP 入队，包络必须在这里用同一个 executionPlanOf 现算，
  // 否则现场网关取不到 plan，自动指令一律被判「不知道开多久」而拒执行
  const plan = executionPlanOf(type, parameters);
  return {
    // 同一事件多设备建单时按设备加后缀，保持指令标识唯一
    id: `CTL-${event.eventId}-${deviceId}`,
    // 归属跟着事件信封走：自动指令由哪个租户的事件触发就记在哪个租户名下
    tenantId: event.tenantId,
    deviceId,
    plotCode,
    operatorId: AUTO_OPERATOR,
    type,
    parameters: plan === undefined ? parameters : { ...parameters, plan },
    status: "QUEUED",
    origin: "EVENT",
    sourceEventId: event.eventId,
    reason,
    version: 1,
    createdAt: event.occurredAt,
  };
}

/** 水肥指令类型 → 可执行该动作的设备类型（与 command-spec 的设备推断口径同源） */
const DEVICES_BY_COMMAND: Record<string, readonly string[]> = {
  IRRIGATION: ["IRRIGATION_PUMP", "IRRIGATION_VALVE"],
  FERTILIZATION: ["FERTILIZER_VALVE"],
};

/**
 * 处方明细 → 现场执行分区。
 *
 * 分摊口径（D2 规则 A）：多明细逐明细建分区，分区面积取各自网格台账面积——
 * 明细自带 `areaMu` 时直接使用；明细 `gridCode` 即地块时回落用事件带出的地块台账面积；
 * 网格非地块且不带面积时不猜，显式标成待人工确认，让台账与网关回执都说得清为什么没执行。
 *
 * 包络口径按设备动作推断：
 * - 灌溉处方：灌水定额取明细用量（毫米）；
 * - 施肥处方（水肥一体，D1 同源）：灌水定额取明细 `targetMm`，用量（千克/亩）不参与阀门时长；
 *   缺定额或缺面积都推不出包络，保持拦截不猜。
 */
function prescriptionExecution(
  payload: PrescriptionIssuedPayload,
  items: PrescriptionIssuedPayload["items"],
  plotCode: string,
): { areaMu?: number; zones?: IrrigationZone[]; envelopeBlocked?: string } {
  const areaMu = isNonNegativeNumber(payload.areaMu) && payload.areaMu > 0 ? payload.areaMu : undefined;
  const area = areaMu === undefined ? {} : { areaMu };
  const quotaOf = (item: PrescriptionIssuedPayload["items"][number]): number | undefined =>
    payload.planType === "fertilization" ? item.targetMm : item.dosage;
  const quotaLabel = payload.planType === "fertilization" ? "水肥一体灌水定额" : "灌水定额";
  const zones: IrrigationZone[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const gridCode = item.gridCode?.trim() || plotCode;
    const itemArea = isNonNegativeNumber(item.areaMu) && item.areaMu > 0 ? item.areaMu : undefined;
    const zoneArea = itemArea ?? (gridCode === plotCode ? areaMu : undefined);
    if (zoneArea === undefined) {
      return { ...area, envelopeBlocked: `处方第 ${index + 1} 条明细（网格 ${gridCode}）没有台账面积，无法现算计划水量与阀门开启时长，需人工确认后下发` };
    }
    const quota = quotaOf(item);
    if (typeof quota !== "number" || !(quota > 0 && quota <= 100)) {
      return { ...area, envelopeBlocked: `处方第 ${index + 1} 条明细${quotaLabel} ${quota} 毫米不在可执行范围（0 到 100），需人工确认后下发` };
    }
    zones.push({ zoneCode: gridCode, areaMu: zoneArea, targetMm: quota });
  }
  return { ...area, zones };
}

/** 事件消费处理器：一个方法对应一个主题 */
export class ControlCommandConsumer {
  constructor(
    private readonly commands: ControlCommandRepository,
    private readonly supplementIrrigationMm: number = DEFAULT_SUPPLEMENT_IRRIGATION_MM,
    /**
     * 自动指令目标设备解析：按地块取可执行该动作的真实设备。
     * 缺省回落 auto-* 伪设备（仅供未装配解析器的旧路径，平台部署必须注入，
     * 否则自动指令没有领取方，永远停在 QUEUED 直到超时收口）。
     */
    private readonly resolveDevices?: (plotCode: string, commandType: ControlCommandType) => Promise<Array<{ id: string }>>,
    /** 自动指令跳过建单的原因回调（如地块没有可执行设备），缺省静默 */
    private readonly onSkip?: (reason: string) => void,
  ) {}

  /** 解析目标设备；未注入解析器时维持 auto-* 伪设备旧口径 */
  private async devicesFor(commandType: ControlCommandType, plotCode: string): Promise<Array<{ id: string }>> {
    if (!this.resolveDevices) return [{ id: `auto-${plotCode}` }];
    return this.resolveDevices(plotCode, commandType);
  }

  /**
   * 遥测越限：土壤含水率低于下限自动补灌，高于上限自动停灌。
   * 其它指标（温度、风速、降雨等）无法由水肥设备处置，交给消息中心提醒。
   */
  @registerHandler(EventTopic.TelemetryThresholdBreached)
  async onThresholdBreached(event: DomainEvent<ThresholdBreachedPayload>): Promise<void> {
    const payload = event.payload;
    if (payload.metric !== "soilMoisture") return;
    if (payload.direction === "above") {
      await this.stopIrrigation(event, payload);
      return;
    }
    if (payload.direction !== "below") return;
    if (!isNonNegativeNumber(payload.value) || !isNonNegativeNumber(payload.threshold) || payload.value >= payload.threshold) {
      throw new Error("自动补灌越限事件数值非法");
    }
    // 补灌定额走确认口径（D3 口径一：固定补灌量）；事件带出地块台账面积时直接生成执行包络，
    // 面积缺测不猜，保持 envelopeBlocked 交人工确认。
    const quotaMm = this.supplementIrrigationMm;
    const areaMu = isNonNegativeNumber(payload.areaMu) && payload.areaMu > 0 ? payload.areaMu : undefined;
    const zones = areaMu === undefined
      ? undefined
      : [{ zoneCode: payload.gridCode?.trim() || payload.parcelId.trim(), areaMu, targetMm: quotaMm }];
    const parameters: Record<string, unknown> = {
      source: "threshold",
      metric: payload.metric,
      value: payload.value,
      threshold: payload.threshold,
      quotaMm,
      gridCode: payload.gridCode ?? "",
      ...(areaMu === undefined ? {} : { areaMu }),
      ...(zones === undefined
        ? { envelopeBlocked: "越限补灌未带出地块台账面积，无法现算计划水量与阀门开启时长，需人工确认后下发" }
        : { zones }),
    };
    const reason = `土壤含水率 ${payload.value} 低于阈值 ${payload.threshold}，自动补灌`;
    const devices = await this.devicesFor("IRRIGATION", payload.parcelId.trim());
    if (devices.length === 0) {
      this.onSkip?.(`地块 ${payload.parcelId} 没有可执行补灌的水肥设备，自动补灌指令不建单`);
      return;
    }
    // 逐设备建单：每台水肥设备各领一条，包络参数一致，设备标识各不相同
    for (const device of devices) {
      await this.commands.create(buildCommand(event, "IRRIGATION", reason, parameters, device.id));
    }
  }

  /**
   * 墒情高于上限：自动停灌。
   *
   * 只撤回尚未被现场网关领取的 QUEUED 灌溉指令（CANCELLED 终态，缘由落在回执说明）；
   * 已领取（SENT/ACKED）的指令平台无法远程关阀，越限事件本身已由消息中心生成告警，
   * 由人工确认后走急停，不在这里假装「已停」。上限阈值来自遥测规则配置，没有配
   * above 规则的地块不会触发停灌——宁可不联动，也不拿一个猜的上限去撤指令。
   */
  private async stopIrrigation(event: DomainEvent<ThresholdBreachedPayload>, payload: ThresholdBreachedPayload): Promise<void> {
    if (!isNonNegativeNumber(payload.value) || !isNonNegativeNumber(payload.threshold) || payload.value <= payload.threshold) {
      throw new Error("自动停灌越限事件数值非法");
    }
    const plotCode = requireParcelId(payload.parcelId);
    const reason = `土壤含水率 ${payload.value} 高于上限 ${payload.threshold}，自动停灌`;
    const queued = await this.commands.page(event.tenantId, { plotCode, type: "IRRIGATION", status: "QUEUED", page: 1, size: 200 });
    for (const command of queued.items) {
      // 版本不匹配说明网关恰好领走了这条指令：撤不回就不撤，交给在途告警与急停处置
      await this.commands.transition(event.tenantId, {
        id: command.id,
        status: "CANCELLED",
        at: event.occurredAt,
        version: command.version,
        message: reason,
        result: { source: "threshold", metric: payload.metric, value: payload.value, threshold: payload.threshold, sourceEventId: event.eventId },
      });
    }
  }

  /** 处方生成：灌溉与施肥处方转成对应水肥指令，植保处方不在此下发 */
  @registerHandler(EventTopic.DecisionPrescriptionIssued)
  async onPrescriptionIssued(event: DomainEvent<PrescriptionIssuedPayload>): Promise<void> {
    const payload = event.payload;
    if (payload.planType === "pesticide") return;
    if (payload.planType !== "irrigation" && payload.planType !== "fertilization") throw new Error("未知处方动作类型");
    const plotCode = requireParcelId(payload.parcelId);
    if (!Array.isArray(payload.items)) throw new Error("处方 items 必须为数组");
    if (payload.items.length === 0) return;
    // 必须先校验全部明细，再创建一条完整指令；不可过滤非法项后部分执行。
    const items = payload.items.map((item) => {
      if (!item || !isNonNegativeNumber(item.dosage)) throw new Error("处方用量必须为非负有限数字");
      if (typeof item.materialCode !== "string" || !item.materialCode.trim()) throw new Error("处方投入品编码不能为空");
      if (item.gridCode !== undefined && (typeof item.gridCode !== "string" || !item.gridCode.trim())) throw new Error("处方网格编码非法");
      if (typeof item.windowStart !== "string" || typeof item.windowEnd !== "string"
        || !Number.isFinite(Date.parse(item.windowStart)) || !Number.isFinite(Date.parse(item.windowEnd))
        || Date.parse(item.windowEnd) < Date.parse(item.windowStart)) throw new Error("处方时间窗非法");
      return { ...item };
    });
    const type = COMMAND_BY_PLAN[payload.planType]!;
    const first = items[0]!;
    const execution = prescriptionExecution(payload, items, plotCode);
    const devices = await this.devicesFor(type, plotCode);
    if (devices.length === 0) {
      this.onSkip?.(`地块 ${plotCode} 没有可执行${PLAN_LABELS[payload.planType]}的水肥设备，处方指令不建单`);
      return;
    }
    const parameters: Record<string, unknown> = {
      source: "prescription",
      ...(payload.prescriptionId ? { prescriptionId: payload.prescriptionId } : {}),
      seasonId: payload.seasonId,
      planType: payload.planType,
      itemCount: items.length,
      items,
      ...(execution.areaMu === undefined ? {} : { areaMu: execution.areaMu }),
      ...(execution.zones === undefined ? {} : { zones: execution.zones }),
      ...(execution.envelopeBlocked === undefined ? {} : { envelopeBlocked: execution.envelopeBlocked }),
      // 兼容旧的单项参数读取方式，多项必须使用完整 items。
      ...(items.length === 1 ? { materialCode: first.materialCode, dosage: first.dosage } : {}),
    };
    // 逐设备建单：同一处方在多台水肥设备上各执行一份
    for (const device of devices) {
      await this.commands.create(
        buildCommand(event, type, `${PLAN_LABELS[payload.planType]}处方下发：共 ${items.length} 项明细`, parameters, device.id),
      );
    }
  }
}

/** 消费者装配参数 */
export interface ControlConsumerOptions {
  /** 消费者组，缺省 control-service；多副本共用一组即可共享位点 */
  group?: string;
  pollIntervalMs?: number;
  /** 越限补灌定额（毫米）：D3 口径一固定补灌量，缺省 DEFAULT_SUPPLEMENT_IRRIGATION_MM，按土壤质地与作物需水调整 */
  supplementIrrigationMm?: number;
  /**
   * 自动指令目标设备解析：按地块取可执行该动作的真实水肥设备。
   * 平台部署必须注入；缺省回落 auto-* 伪设备（无领取方，仅保留旧路径兼容）。
   */
  resolveDevices?: (plotCode: string, commandType: ControlCommandType) => Promise<Array<{ id: string }>>;
  /** 自动指令跳过建单的原因回调（如地块没有可执行设备），缺省静默 */
  onSkip?: (reason: string) => void;
  /** 处理失败回调，缺省静默由下一轮重试 */
  onError?: (topic: string, eventId: string, error: Error, attempt: number) => void;
}

/**
 * 组装控制指令的消费者：登记处理器、绑定分发器、构造日志消费者。
 * @param commands 指令仓储
 * @param store 事件日志存储
 * @param options 消费者配置
 */
export function createControlEventConsumer(
  commands: ControlCommandRepository,
  store: EventLogStore,
  options: ControlConsumerOptions = {},
): { handler: ControlCommandConsumer; dispatcher: EventDispatcher; consumer: EventLogConsumer } {
  const dispatcher = new EventDispatcher({
    idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore(), { prefix: "control-service:idem:" }),
    retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500, deadLetterAfterMaxAttempts: false },
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const handler = new ControlCommandConsumer(
    commands,
    options.supplementIrrigationMm ?? DEFAULT_SUPPLEMENT_IRRIGATION_MM,
    options.resolveDevices,
    options.onSkip,
  );
  const registrations = buildHandlers(handler);
  for (const registration of registrations) {
    dispatcher.subscribe(registration.topic, registration.handler);
  }
  const consumer = new EventLogConsumer({
    group: options.group ?? "control-service",
    store,
    dispatcher,
    topics: registrations.map((registration) => registration.topic),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  return { handler, dispatcher, consumer };
}
