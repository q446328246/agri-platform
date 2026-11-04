/**
 * 指标采集。
 *
 * 指标按 Node.js 运行模型选取：不看线程池，重点采集事件循环延迟、
 * 活动句柄数与连接池使用率——这三项正是 Node.js 服务最典型的三类劣化信号。
 */

/** 指标定义：名称与单位 */
export interface MetricDefinition {
  name: string;
  unit: string;
}

/** 平台标准指标 */
export const METRIC = {
  HttpRequestDuration: { name: "http_request_duration_ms", unit: "ms" },
  EventLoopLag: { name: "event_loop_lag_ms", unit: "ms" },
  ActiveHandles: { name: "active_handles", unit: "count" },
  DbPoolInUse: { name: "db_pool_in_use", unit: "count" },
  MqConsumeDuration: { name: "mq_consume_duration_ms", unit: "ms" },
  MqDeadLetter: { name: "mq_dead_letter_total", unit: "count" },
  DeviceTelemetry: { name: "device_telemetry_total", unit: "count" },
} as const;

export type MetricName = (typeof METRIC)[keyof typeof METRIC]["name"];

/** 指标样本 */
export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  /** 当前值型指标的最新取值时间 */
  updatedAt: string;
}

/** 把标签对象转为稳定字符串键，使同标签组合聚拢到同一时间序列 */
function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${labels[key] ?? ""}`).join(",");
}

/** 指标服务：计数器、直方图观测与当前值型指标 */
export class MetricsService {
  private readonly counters = new Map<string, MetricSample>();

  private readonly gauges = new Map<string, MetricSample>();

  private readonly observations = new Map<string, number[]>();

  /** 计数器：只增不减，用于累计量 */
  counter(name: string, labels: Record<string, string> = {}, delta = 1): void {
    const key = `${name}|${labelKey(labels)}`;
    const existing = this.counters.get(key);
    this.counters.set(key, {
      name,
      labels,
      value: (existing?.value ?? 0) + delta,
      updatedAt: new Date().toISOString(),
    });
  }

  /** 观测单次耗时，写入直方图 */
  observe(name: string, valueMs: number, labels: Record<string, string> = {}): void {
    const key = `${name}|${labelKey(labels)}`;
    const bucket = this.observations.get(key) ?? [];
    bucket.push(valueMs);
    // 单键保留最近 1000 个样本，避免长期运行内存持续增长
    if (bucket.length > 1000) {
      bucket.shift();
    }
    this.observations.set(key, bucket);
  }

  /** 当前值型指标，如连接数、活动句柄数 */
  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = `${name}|${labelKey(labels)}`;
    this.gauges.set(key, { name, labels, value, updatedAt: new Date().toISOString() });
  }

  /** 读取计数器当前值，用于测试与告警判定 */
  counterValue(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(`${name}|${labelKey(labels)}`)?.value ?? 0;
  }

  /** 读取当前值型指标 */
  gaugeValue(name: string, labels: Record<string, string> = {}): number | undefined {
    return this.gauges.get(`${name}|${labelKey(labels)}`)?.value;
  }

  /** 读取观测样本的分位数，用于耗时告警 */
  quantile(name: string, q: number, labels: Record<string, string> = {}): number | undefined {
    const bucket = this.observations.get(`${name}|${labelKey(labels)}`);
    if (!bucket || bucket.length === 0) {
      return undefined;
    }
    const sorted = [...bucket].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index];
  }

  /** 导出全部指标样本，供采集端拉取 */
  snapshot(): MetricSample[] {
    return [...this.counters.values(), ...this.gauges.values()];
  }
}
