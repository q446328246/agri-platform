import "reflect-metadata";

import type { DomainEvent, FertilizationFinishedPayload, IrrigationFinishedPayload } from "@agri/contracts";
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

import type { ExecutionRepository, PrescriptionExecution, PrescriptionPlanType } from "./execution.repository.js";
import { newExecutionId } from "./execution.repository.js";
import type { PrescriptionRepository } from "./prescription.repository.js";

/**
 * 处方执行回流的事件消费。
 *
 * 决策侧发布处方后，链条本该继续往下走：处方 → 控制指令 → DONE 回执 → 实际用水用肥。
 * 在接入结单事件之前，处方留痕停在「建议发出去了」，效果评估（decision_prescription_outcomes）
 * 只能由调用方手工喂参数，规则调优缺一份客观的执行事实。
 *
 * 这里只登记「可核对的执行事实」：用量与时长直接取自结单事件，来源标记一并留档。
 * 人工下发的指令没有处方标识，没有处方可回流——跳过，不硬凑一条指向不存在处方的记录。
 *
 * 不做的事：不代替人工触发效果评估。评估需要作业后的实测含水率，那要等遥测给出新读数，
 * 由调用方判定何时评估，回流表只负责把执行事实备齐。
 */

/** 结单事件的公共字段，灌溉与施肥载荷都带 */
type FinishedPayload = IrrigationFinishedPayload & FertilizationFinishedPayload;

/** 带来源处方标识的载荷：校验通过后的回流依据 */
type ExecutableFinished = FinishedPayload & { prescriptionId: string };

/**
 * 校验结单载荷并取出来源处方标识。
 * 返回 undefined 表示这条指令与处方无关（人工下发），本次事件无需回流；
 * 字段本身非法则抛错交由分发器重试，不把脏数据写进留痕。
 */
function acceptFinishedPayload(payload: FinishedPayload): ExecutableFinished | undefined {
  if (typeof payload.commandId !== "string" || !payload.commandId.trim()) throw new Error("结单事件缺少指令标识");
  if (typeof payload.deviceId !== "string") throw new Error("结单事件设备标识非法");
  if (typeof payload.durationMin !== "number" || !Number.isFinite(payload.durationMin) || payload.durationMin < 0) {
    throw new Error("结单事件作业时长非法");
  }
  if (payload.durationSource !== "DEVICE" && payload.durationSource !== "RUNTIME") throw new Error("结单事件时长来源非法");
  if (!Number.isFinite(Date.parse(payload.finishedAt))) throw new Error("结单事件完成时间非法");
  for (const key of ["waterVolume", "fertilizerKg"] as const) {
    const value = payload[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`结单事件 ${key} 非法`);
  }
  const prescriptionId = payload.prescriptionId;
  return typeof prescriptionId === "string" && prescriptionId.trim() ? { ...payload, prescriptionId: prescriptionId.trim() } : undefined;
}

/** 事件消费处理器：一个方法对应一个主题 */
export class DecisionEventConsumer {
  constructor(
    private readonly executions: ExecutionRepository,
    private readonly prescriptions: PrescriptionRepository,
  ) {}

  /** 灌溉执行完成：把实际用水量回流到来源处方 */
  @registerHandler(EventTopic.ControlIrrigationFinished)
  async onIrrigationFinished(event: DomainEvent<IrrigationFinishedPayload>): Promise<void> {
    await this.record(event, "irrigation");
  }

  /** 施肥执行完成：把实际投肥量回流到来源处方 */
  @registerHandler(EventTopic.ControlFertilizationFinished)
  async onFertilizationFinished(event: DomainEvent<FertilizationFinishedPayload>): Promise<void> {
    await this.record(event, "fertilization");
  }

  /**
   * 回流一条执行记录。
   * 地块编码以处方留痕为准——处方才是决策侧的账本，指令参数可能被人工改动；
   * 处方标识有但处方查不到属于数据不一致，抛错让运维看见，不静默丢弃。
   */
  private async record(event: DomainEvent<FinishedPayload>, planType: PrescriptionPlanType): Promise<void> {
    const payload = acceptFinishedPayload(event.payload);
    if (!payload) return;
    const prescription = await this.prescriptions.findById(payload.prescriptionId);
    if (!prescription) {
      throw new Error(`处方 ${payload.prescriptionId} 不存在，无法回流指令 ${payload.commandId} 的执行结果`);
    }
    const execution: PrescriptionExecution = {
      id: newExecutionId(),
      prescriptionId: payload.prescriptionId,
      commandId: payload.commandId.trim(),
      plotCode: prescription.plotCode || payload.parcelId,
      planType,
      deviceId: payload.deviceId,
      durationMin: payload.durationMin,
      durationSource: payload.durationSource,
      finishedAt: payload.finishedAt,
      eventId: event.eventId,
      recordedAt: event.occurredAt,
    };
    // 用量与来源成对写入：只有一半说明载荷被截断，宁可两样都不记。
    if (payload.waterVolume !== undefined && payload.waterVolumeSource !== undefined) {
      execution.waterVolume = payload.waterVolume;
      execution.waterVolumeSource = payload.waterVolumeSource;
    }
    if (payload.fertilizerKg !== undefined && payload.fertilizerSource !== undefined) {
      execution.fertilizerKg = payload.fertilizerKg;
      execution.fertilizerSource = payload.fertilizerSource;
    }
    await this.executions.record(execution);
  }
}

/** 消费者装配参数 */
export interface DecisionConsumerOptions {
  /** 消费者组，缺省 decision-service；多副本共用一组即可共享位点 */
  group?: string;
  pollIntervalMs?: number;
  /** 处理失败回调，缺省静默由下一轮重试 */
  onError?: (topic: string, eventId: string, error: Error, attempt: number) => void;
}

/**
 * 组装决策服务的消费者：登记处理器、绑定分发器、构造日志消费者。
 * @param executions 执行回流仓储
 * @param prescriptions 处方留痕仓储
 * @param store 事件日志存储
 * @param options 消费者配置
 */
export function createDecisionEventConsumer(
  executions: ExecutionRepository,
  prescriptions: PrescriptionRepository,
  store: EventLogStore,
  options: DecisionConsumerOptions = {},
): { handler: DecisionEventConsumer; dispatcher: EventDispatcher; consumer: EventLogConsumer } {
  const dispatcher = new EventDispatcher({
    idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore(), { prefix: "decision-service:idem:" }),
    retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500, deadLetterAfterMaxAttempts: false },
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const handler = new DecisionEventConsumer(executions, prescriptions);
  const registrations = buildHandlers(handler);
  for (const registration of registrations) {
    dispatcher.subscribe(registration.topic, registration.handler);
  }
  const consumer = new EventLogConsumer({
    group: options.group ?? "decision-service",
    store,
    dispatcher,
    // 订阅主题由处理器注册结果派生，新增回流主题时不必再改一遍订阅清单
    topics: registrations.map((registration) => registration.topic),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  return { handler, dispatcher, consumer };
}
