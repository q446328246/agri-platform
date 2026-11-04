import type { DomainEvent, PlotCreatedPayload } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import type { EventDispatcher } from "@agri/mq";
import { buildHandlers, registerHandler } from "@agri/mq";

/**
 * 地块事件消费者。
 *
 * 消费者只关心「一个地块建档事件意味着什么」，反序列化、幂等与重试由分发器
 * 统一承担，因此本类中不出现任何重复消费判断与重试逻辑。
 */
export class PlotEventConsumer {
  private readonly handled: string[] = [];

  /** 已处理事件标识，供断言与排障 */
  get handledEventIds(): string[] {
    return [...this.handled];
  }

  /** 地块建档后：初始化网格与地力档案等工作在此展开 */
  @registerHandler(EventTopic.PlotCreated)
  async onPlotCreated(event: DomainEvent<PlotCreatedPayload>): Promise<void> {
    const { parcelCode, areaMu } = event.payload;
    if (areaMu <= 0) {
      throw new Error(`地块面积非法：${parcelCode}`);
    }
    this.handled.push(event.eventId);
  }

  /**
   * 把本消费者登记的处理方法接入分发器。
   * @param dispatcher 事件分发器
   */
  bind(dispatcher: EventDispatcher): void {
    for (const registration of buildHandlers(this)) {
      dispatcher.subscribe(registration.topic, registration.handler);
    }
  }
}
