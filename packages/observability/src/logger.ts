/**
 * 结构化日志。
 *
 * 日志以单行 JSON 输出，字段固定，便于采集端解析与检索。
 * 所有日志必须携带服务名与链路标识，否则跨服务排查时无法把一次请求串联起来。
 */

/** 日志级别，数值越大越严重 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 一条结构化日志的固定字段 */
export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  traceId?: string;
  [key: string]: unknown;
}

/** 日志器选项 */
export interface LoggerOptions {
  serviceName: string;
  level?: LogLevel;
  base?: Record<string, unknown>;
  /** 输出落点，默认写标准输出，测试可替换为采集函数 */
  sink?: (line: string) => void;
}

/** 结构化日志器 */
export class LoggerService {
  private readonly serviceName: string;

  private readonly level: LogLevel;

  private readonly base: Record<string, unknown>;

  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions) {
    this.serviceName = options.serviceName;
    this.level = options.level ?? "info";
    this.base = options.base ?? {};
    this.sink = options.sink ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  }

  /** 派生带固定上下文的子日志器，后续日志自动携带该上下文 */
  child(context: Record<string, unknown>, level?: LogLevel): LoggerService {
    return new LoggerService({
      serviceName: this.serviceName,
      level: level ?? this.level,
      base: { ...this.base, ...context },
      sink: this.sink,
    });
  }

  /** 派生带链路标识的子日志器 */
  withTrace(traceId: string): LoggerService {
    return this.child({ traceId });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
      return;
    }
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      ...this.base,
      ...(context ?? {}),
    };
    this.sink(JSON.stringify(record));
  }
}
