import "reflect-metadata";

import type { DomainEvent, IrrigationFinishedPayload, PrescriptionIssuedPayload } from "@agri/contracts";
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

import type { TraceRecord, TraceRepository } from "./repository.js";
import { IRRIGATION_EVENT, PRESCRIPTION_EVENT } from "./repository.js";

/**
 * 生产档案的事件消费。
 *
 * 处方一旦生成就属于生产过程的一部分，需要进入追溯档案，供后续查询
 * 「哪块地在什么时间按什么建议作业」。档案只做追加记录，不修改处方本身，
 * 因此处理器里不调用决策服务。
 *
 * 灌溉结单同样入账：处方只是「建议」，DONE 回执带回来的用水量与时长才是「实际做了什么」。
 * 两条档案事件分开保留，溯源链条才能既看到建议也看到执行。
 */

/** 处方类型中文名，用于档案详情 */
const PLAN_LABELS: Record<PrescriptionIssuedPayload["planType"], string> = {
  irrigation: "灌溉",
  fertilization: "施肥",
  pesticide: "植保",
};

/** 事件消费处理器：一个方法对应一个主题 */
export class TraceEventConsumer {
  constructor(private readonly records: TraceRepository) {}

  /** 处方生成：写入地块生产档案，追溯码按来源事件固定，重放不会重复建档 */
  @registerHandler(EventTopic.DecisionPrescriptionIssued)
  async onPrescriptionIssued(event: DomainEvent<PrescriptionIssuedPayload>): Promise<void> {
    const payload = event.payload;
    const plan = PLAN_LABELS[payload.planType];
    const first = payload.items[0];
    const detail = first
      ? `${plan}处方，共 ${payload.items.length} 项建议；首项 ${first.materialCode} 用量 ${first.dosage}，时间窗 ${first.windowStart} 至 ${first.windowEnd}`
      : `${plan}处方，本次评估未产生需要执行的作业建议`;
    const record: TraceRecord = {
      id: `TRACE-${event.eventId}`,
      traceCode: `TR-PRES-${event.eventId}`,
      batchCode: "",
      plotCode: payload.parcelId,
      event: PRESCRIPTION_EVENT,
      detail,
      operator: `event:${event.producer}`,
      createdAt: event.occurredAt,
    };
    await this.records.create(record);
  }

  /**
   * 灌溉执行完成：把 DONE 回执带回来的实际用水量为地块补一条作业档案。
   * 追溯码按指令固定，同一指令的重复投递只会命中同一条记录。
   */
  @registerHandler(EventTopic.ControlIrrigationFinished)
  async onIrrigationFinished(event: DomainEvent<IrrigationFinishedPayload>): Promise<void> {
    const payload = event.payload;
    const water =
      payload.waterVolume === undefined
        ? "用水量未上报"
        : `用水 ${payload.waterVolume} 立方米${payload.waterVolumeSource === "DEVICE" ? "（设备实测）" : "（按分区方案推算）"}`;
    const duration = `历时 ${payload.durationMin} 分钟${payload.durationSource === "DEVICE" ? "（设备实测）" : "（按回执时间推算）"}`;
    const record: TraceRecord = {
      id: `TRACE-${event.eventId}`,
      traceCode: `TR-IRR-${payload.commandId}`,
      batchCode: "",
      plotCode: payload.parcelId,
      event: IRRIGATION_EVENT,
      detail: `灌溉指令 ${payload.commandId} 执行到位（设备 ${payload.deviceId}）：${water}，${duration}`,
      operator: `event:${event.producer}`,
      createdAt: payload.finishedAt || event.occurredAt,
    };
    await this.records.create(record);
  }
}

/** 消费者装配参数 */
export interface TraceConsumerOptions {
  /** 消费者组，缺省 trace-service；多副本共用一组即可共享位点 */
  group?: string;
  pollIntervalMs?: number;
  /** 处理失败回调，缺省静默由下一轮重试 */
  onError?: (topic: string, eventId: string, error: Error, attempt: number) => void;
}

/**
 * 组装生产档案的消费者：登记处理器、绑定分发器、构造日志消费者。
 * @param records 档案仓储
 * @param store 事件日志存储
 * @param options 消费者配置
 */
export function createTraceEventConsumer(
  records: TraceRepository,
  store: EventLogStore,
  options: TraceConsumerOptions = {},
): { handler: TraceEventConsumer; dispatcher: EventDispatcher; consumer: EventLogConsumer } {
  const dispatcher = new EventDispatcher({
    idempotency: new IdempotencyGuard(new InMemoryIdempotencyStore(), { prefix: "trace-service:idem:" }),
    retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500, deadLetterAfterMaxAttempts: false },
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const handler = new TraceEventConsumer(records);
  const registrations = buildHandlers(handler);
  for (const registration of registrations) {
    dispatcher.subscribe(registration.topic, registration.handler);
  }
  const consumer = new EventLogConsumer({
    group: options.group ?? "trace-service",
    store,
    dispatcher,
    topics: registrations.map((registration) => registration.topic),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  return { handler, dispatcher, consumer };
}
