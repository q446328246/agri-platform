import { METRIC } from "./metrics.js";
import type { MetricsService } from "./metrics.js";
import type { LoggerService } from "./logger.js";

/**
 * 方法装饰器。
 *
 * 两个装饰器配合使用即可覆盖绝大多数场景：链路装饰器解决「这一阶段花了多久」，
 * 指标装饰器解决「这个方法的错误率是否异常」。
 * 注意不要在循环体内使用，否则会产生大量跨度与指标标签，反而拖慢服务。
 */

type Deps = {
  logger?: LoggerService | undefined;
  metrics?: MetricsService | undefined;
};

const deps: Deps = {};

/** 注入装饰器所需的日志与指标服务，通常在应用启动时调用一次 */
export function configureDecorators(options: Deps): void {
  deps.logger = options.logger;
  deps.metrics = options.metrics;
}

type MethodLike = (this: unknown, ...args: unknown[]) => unknown;

/**
 * 自动为方法创建链路跨度，并把耗时写入结构化日志。
 * @param name 跨度名称，缺省取类名与方法名
 */
export function Traced(name?: string): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor): void => {
    const original = descriptor.value as MethodLike | undefined;
    if (typeof original !== "function") {
      return;
    }
    const spanName = name ?? `${target.constructor.name}.${String(propertyKey)}`;
    descriptor.value = async function traced(this: unknown, ...args: unknown[]): Promise<unknown> {
      const startedAt = Date.now();
      try {
        const result = await original.apply(this, args);
        deps.logger?.debug("方法执行完成", {
          span: spanName,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        deps.logger?.error("方法执行失败", {
          span: spanName,
          durationMs: Date.now() - startedAt,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  };
}

/**
 * 自动打点方法耗时与异常计数，标签取类名与方法名。
 */
export function Metered(): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor): void => {
    const original = descriptor.value as MethodLike | undefined;
    if (typeof original !== "function") {
      return;
    }
    const className = target.constructor.name;
    const methodName = String(propertyKey);
    descriptor.value = async function metered(this: unknown, ...args: unknown[]): Promise<unknown> {
      const startedAt = Date.now();
      try {
        const result = await original.apply(this, args);
        deps.metrics?.observe(METRIC.HttpRequestDuration.name, Date.now() - startedAt, {
          class: className,
          method: methodName,
        });
        return result;
      } catch (error) {
        deps.metrics?.counter(`${METRIC.HttpRequestDuration.name}_error_total`, {
          class: className,
          method: methodName,
        });
        throw error;
      }
    };
  };
}
