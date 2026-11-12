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

/**
 * 控制指令的事件消费。
 *
 * 越限与处方事件里已经包含「地块 + 处置建议」，控制侧只需要翻译成设备可执行
 * 的水肥指令并入队，因此这里不给指令做二次决策：是否补水、补多少由处方与
 * 阈值确定，控制侧只负责落成立即执行的动作。
 *
 * 只有能直接由水肥设备执行的场景才生成指令；植保作业与其它指标越限仍由
 * 消息中心提醒人工处置，避免自动下发与作业计划冲突。
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
 */
function buildCommand(
  event: DomainEvent,
  type: ControlCommandType,
  reason: string,
  parameters: Record<string, unknown>,
): ControlCommand {
  const plotCode = requireParcelId((event.payload as { parcelId?: unknown }).parcelId);
  if (typeof event.eventId !== "string" || !event.eventId.trim()) throw new Error("自动控制事件 eventId 不能为空");
  return {
    id: `CTL-${event.eventId}`,
    deviceId: `auto-${plotCode}`,
    plotCode,
    operatorId: AUTO_OPERATOR,
    type,
    parameters,
    status: "QUEUED",
    origin: "EVENT",
    sourceEventId: event.eventId,
    reason,
    version: 1,
    createdAt: event.occurredAt,
  };
}

/** 事件消费处理器：一个方法对应一个主题 */
export class ControlCommandConsumer {
  constructor(private readonly commands: ControlCommandRepository) {}

  /**
   * 遥测越限：只有土壤含水率低于下限才自动补灌。
   * 其它指标（温度、风速、降雨等）无法由水肥设备处置，交给消息中心提醒。
   */
  @registerHandler(EventTopic.TelemetryThresholdBreached)
  async onThresholdBreached(event: DomainEvent<ThresholdBreachedPayload>): Promise<void> {
    const payload = event.payload;
    if (payload.metric !== "soilMoisture" || payload.direction !== "below") return;
    if (!isNonNegativeNumber(payload.value) || !isNonNegativeNumber(payload.threshold) || payload.value >= payload.threshold) {
      throw new Error("自动补灌越限事件数值非法");
    }
    await this.commands.create(
      buildCommand(event, "IRRIGATION", `土壤含水率 ${payload.value} 低于阈值 ${payload.threshold}，自动补灌`, {
        source: "threshold",
        metric: payload.metric,
        value: payload.value,
        threshold: payload.threshold,
        gridCode: payload.gridCode ?? "",
      }),
    );
  }

  /** 处方生成：灌溉与施肥处方转成对应水肥指令，植保处方不在此下发 */
  @registerHandler(EventTopic.DecisionPrescriptionIssued)
  async onPrescriptionIssued(event: DomainEvent<PrescriptionIssuedPayload>): Promise<void> {
    const payload = event.payload;
    if (payload.planType === "pesticide") return;
    if (payload.planType !== "irrigation" && payload.planType !== "fertilization") throw new Error("未知处方动作类型");
    requireParcelId(payload.parcelId);
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
    await this.commands.create(
      buildCommand(event, type, `${PLAN_LABELS[payload.planType]}处方下发：共 ${items.length} 项明细`, {
        source: "prescription",
        ...(payload.prescriptionId ? { prescriptionId: payload.prescriptionId } : {}),
        seasonId: payload.seasonId,
        planType: payload.planType,
        itemCount: items.length,
        items,
        // 兼容旧的单项参数读取方式，多项必须使用完整 items。
        ...(items.length === 1 ? { materialCode: first.materialCode, dosage: first.dosage } : {}),
      }),
    );
  }
}

/** 消费者装配参数 */
export interface ControlConsumerOptions {
  /** 消费者组，缺省 control-service；多副本共用一组即可共享位点 */
  group?: string;
  pollIntervalMs?: number;
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
  const handler = new ControlCommandConsumer(commands);
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
