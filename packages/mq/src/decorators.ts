import type { EventTopicValue } from "@agri/contracts";

import type { EventHandler } from "./types.js";

/**
 * 订阅声明装饰器。
 *
 * 装饰器只登记「某方法处理某主题」这一事实，不负责启动消费；
 * 真正的订阅与编排由事件分发器完成，从而让消费入口集中可控，
 * 便于统一加入幂等、重试与死信处理。
 */

/** 处理器登记元数据键 */
export const HANDLER_METADATA = "agri:mq:handlers";

/** 单条处理器登记项 */
export interface HandlerRegistration {
  /** 处理的方法名 */
  methodName: string;
  topic: EventTopicValue;
  /** 覆盖消费者组，缺省沿用模块配置 */
  groupId?: string;
}

/** 注册事件处理器 */
export function registerHandler(topic: EventTopicValue, options: { groupId?: string } = {}): MethodDecorator {
  return (target, propertyKey) => {
    const methodName = String(propertyKey);
    const list: HandlerRegistration[] =
      (Reflect.getMetadata(HANDLER_METADATA, target.constructor) as HandlerRegistration[] | undefined) ?? [];
    list.push(options.groupId === undefined ? { methodName, topic } : { methodName, topic, groupId: options.groupId });
    Reflect.defineMetadata(HANDLER_METADATA, list, target.constructor);
  };
}

/** 读取某个类上登记的处理器 */
export function getHandlerRegistrations(target: object): HandlerRegistration[] {
  const ctor = typeof target === "function" ? target : target.constructor;
  return (Reflect.getMetadata(HANDLER_METADATA, ctor) as HandlerRegistration[] | undefined) ?? [];
}

/**
 * 把已登记的处理方法组装为处理器函数。
 * @param instance 消费者实例
 * @returns 主题到处理器的映射
 */
export function buildHandlers(instance: object): Array<{ topic: EventTopicValue; handler: EventHandler<unknown> }> {
  const key = (methodName: string) => methodName as keyof typeof instance;
  return getHandlerRegistrations(instance).map((registration) => ({
    topic: registration.topic,
    handler: async (event) => {
      const method = instance[key(registration.methodName)] as unknown;
      if (typeof method !== "function") {
        throw new Error(`订阅方法不存在：${registration.methodName}`);
      }
      await (method as (event: unknown) => Promise<void>).call(instance, event);
    },
  }));
}
