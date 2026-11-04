import { randomBytes } from "node:crypto";

/**
 * 链路追踪。
 *
 * 链路标识由网关生成并透传至全部下游，服务内派生跨度以区分阶段耗时。
 * 标识采用十六进制短串，便于在日志与链路系统中检索。
 */

/** 一个链路跨度 */
export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  /** 起始时间（毫秒时间戳） */
  startedAt: number;
  /** 结束时间（毫秒时间戳），未结束时为空 */
  endedAt?: number;
  /** 耗时（毫秒），未结束时为空 */
  durationMs?: number;
  /** 是否以异常结束 */
  error?: boolean;
}

/** 链路服务 */
export class TraceService {
  private traceId: string | undefined;

  private spanStack: Span[] = [];

  /** 生成链路标识 */
  static newTraceId(): string {
    return randomBytes(16).toString("hex");
  }

  /** 设置当前链路标识，通常由网关中间件在请求入口调用 */
  setTraceId(traceId: string): void {
    this.traceId = traceId;
  }

  /** 读取当前链路标识 */
  currentTraceId(): string | undefined {
    return this.traceId;
  }

  /** 开启一个跨度 */
  startSpan(name: string): Span {
    const span: Span = {
      traceId: this.traceId ?? TraceService.newTraceId(),
      spanId: randomBytes(8).toString("hex"),
      name,
      startedAt: Date.now(),
    };
    this.spanStack.push(span);
    return span;
  }

  /** 结束最近一个跨度，写入耗时与异常标记 */
  endSpan(error = false): Span | undefined {
    const span = this.spanStack.pop();
    if (!span) {
      return undefined;
    }
    span.endedAt = Date.now();
    span.durationMs = span.endedAt - span.startedAt;
    span.error = error;
    return span;
  }

  /** 以跨度包裹一次调用，异常时仍会正常结束跨度并向上抛出 */
  async withSpan<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    this.startSpan(name);
    try {
      const result = await fn();
      this.endSpan(false);
      return result;
    } catch (error) {
      this.endSpan(true);
      throw error;
    }
  }
}
