import type { PrismaClientLike } from "./transaction.js";

/**
 * 数据源健康检查与优雅关闭。
 *
 * 健康检查纳入就绪探针：数据库不可达时服务不应被接入流量，
 * 否则容器编排会把请求转发到必然失败的处理逻辑上。
 */

/** 最小日志契约：为一次探活日志把可观测性包引入数据访问层并不划算 */
export interface HealthLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** 健康状态 */
export interface DbHealth {
  status: "up" | "down";
  /** 探测耗时（毫秒） */
  latencyMs: number;
  message?: string;
}

/** 数据源健康检查 */
export class DbHealthIndicator {
  private readonly client: PrismaClientLike;

  private readonly logger: HealthLogger | undefined;

  private readonly slowQueryMs: number;

  constructor(client: PrismaClientLike, options: { logger?: HealthLogger; slowQueryMs?: number } = {}) {
    this.client = client;
    this.logger = options.logger;
    this.slowQueryMs = options.slowQueryMs ?? 500;
  }

  /** 执行一次健康探测 */
  async check(): Promise<DbHealth> {
    const startedAt = Date.now();
    try {
      await this.client.$queryRawUnsafe("SELECT 1");
      const latencyMs = Date.now() - startedAt;
      if (latencyMs > this.slowQueryMs) {
        this.logger?.warn("数据库探测耗时超过慢查询阈值", { latencyMs, slowQueryMs: this.slowQueryMs });
      }
      return { status: "up", latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error("数据库不可达", { latencyMs, reason: message });
      return { status: "down", latencyMs, message };
    }
  }
}

/**
 * 注册优雅关闭钩子：进程退出前断开数据库连接，避免连接被强制中断。
 * @param client 数据库客户端
 * @param signals 监听的信号，默认 SIGINT 与 SIGTERM
 * @returns 解除注册的函数
 */
export function onShutdown(
  client: PrismaClientLike,
  signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"],
): () => void {
  const handlers = signals.map((signal) => {
    const handler = (): void => {
      void client.$disconnect();
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return (): void => {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  };
}
