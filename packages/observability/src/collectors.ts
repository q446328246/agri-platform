import { monitorEventLoopDelay } from "node:perf_hooks";

import type { LoggerService } from "./logger.js";
import { METRIC } from "./metrics.js";
import type { MetricsService } from "./metrics.js";

/**
 * 运行期采集器。
 *
 * 三个关键指标的判读方式：
 * - 事件循环延迟持续高于阈值，说明存在阻塞主线程的同步计算，应从影像处理、
 *   批量核算一类任务入手排查；
 * - 活动句柄数只增不减，说明存在未释放的连接或定时器；
 * - 死信累计数非零，说明有事件反复处理失败，需要人工介入而非调整告警阈值。
 */

/** 事件循环延迟采集器 */
export class EventLoopLagCollector {
  private histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;

  private timer: NodeJS.Timeout | undefined;

  private readonly metrics: MetricsService | undefined;

  private readonly logger: LoggerService | undefined;

  private readonly thresholdMs: number;

  private lagMs = 0;

  constructor(options: { metrics?: MetricsService; logger?: LoggerService; thresholdMs?: number } = {}) {
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.thresholdMs = options.thresholdMs ?? 100;
  }

  /** 启动采集，按间隔输出延迟样本 */
  start(intervalMs = 1000): void {
    if (this.timer) {
      return;
    }
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();
    this.timer = setInterval(() => {
      const mean = this.histogram ? this.histogram.mean / 1e6 : 0;
      this.lagMs = mean;
      this.metrics?.gauge(METRIC.EventLoopLag.name, mean);
      if (mean > this.thresholdMs) {
        this.logger?.warn("事件循环延迟超过阈值，疑似存在阻塞主线程的同步计算", {
          lagMs: Number(mean.toFixed(2)),
          thresholdMs: this.thresholdMs,
        });
      }
    }, intervalMs);
    // 采集本身不应阻碍进程退出
    this.timer.unref();
  }

  /** 停止采集 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.histogram?.disable();
  }

  /** 最近一次采集到的延迟（毫秒） */
  lastLagMs(): number {
    return this.lagMs;
  }
}

/** 活动句柄与连接采集器 */
export class HandleCollector {
  private timer: NodeJS.Timeout | undefined;

  private readonly metrics: MetricsService | undefined;

  private readonly poolUsage: () => number;

  private handles = 0;

  constructor(options: { metrics?: MetricsService; poolUsage?: () => number } = {}) {
    this.metrics = options.metrics;
    this.poolUsage = options.poolUsage ?? ((): number => 0);
  }

  /** 启动采集 */
  start(intervalMs = 5000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.sample();
    }, intervalMs);
    this.timer.unref();
  }

  /** 手动采样一次，便于测试与一次性巡检 */
  sample(): { handles: number; poolInUse: number } {
    // process.getActiveResourcesInfo 返回当前活跃的资源类型列表，长度即句柄数
    const handles = process.getActiveResourcesInfo().length;
    const poolInUse = this.poolUsage();
    this.handles = handles;
    this.metrics?.gauge(METRIC.ActiveHandles.name, handles);
    this.metrics?.gauge(METRIC.DbPoolInUse.name, poolInUse);
    return { handles, poolInUse };
  }

  /** 停止采集 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 最近一次采集到的活动句柄数 */
  lastHandleCount(): number {
    return this.handles;
  }
}
