import type { CommandTimeoutPayload } from "@agri/contracts";
import { EventTopic } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import type { OutboxService } from "@agri/mq";

import { pendingMinutesOf } from "./control.repository.js";
import type { ControlCommand, ControlCommandRepository } from "./control.repository.js";

/**
 * 超时未回执的收口任务。
 *
 * #94 只把「超时」做成可见（列表红标 + overdue 筛选），在途指令本身不动。这里补上
 * 后半段：超过阈值仍没有任何回执的指令，按状态机收口成 FAILED 并推一条
 * control.command.timeout 事件，让消息中心提醒人工核查——否则一条指令可以永远停在
 * 「已入队」，看板越来越红却没有任何人被告知。
 *
 * 收口走的是合法跃迁（任一在途状态 → FAILED）与同一套 version 乐观锁，因此与现场
 * 迟到的真实回执是先到先得：谁先落到终态，另一边拿 409。这是有意的——超时事件已经把
 * 「需要人工确认设备到底做没做」说清楚了，不悄悄覆盖任何一侧的结果。
 *
 * 口径复用：候选查询与列表 `overdue=true` 用同一个 SQL 谓词（COALESCE 在途起点 +
 * CONTROL_RECEIPT_TIMEOUT_MIN），不存在「页面标红」和「后台收口」两套超时定义。
 */

/** 收口任务装配参数 */
export interface ReceiptSweeperOptions {
  /** 超时阈值（分钟），与列表标记同源 */
  timeoutMin: number;
  /** 扫描间隔（毫秒），缺省 60000 */
  intervalMs?: number;
  /** 单轮最多收口多少条，缺省 50 */
  batchSize?: number;
  /** 本地消息表；配置后每条收口同事务推一条超时事件 */
  outbox?: OutboxService;
  /** 事务句柄；配置了 outbox 就必须给，否则状态改了事件却没落库 */
  withTransaction?: PrismaClientLike["$transaction"];
  /** 单条收口失败回调，缺省静默，等下一轮重试 */
  onError?: (commandId: string, error: Error) => void;
}

export class ControlReceiptSweeper {
  private readonly commands: ControlCommandRepository;

  private readonly options: ReceiptSweeperOptions;

  private timer: NodeJS.Timeout | undefined;

  /** 同一进程内不叠扫：上一轮没跑完就跳过本轮 */
  private running = false;

  constructor(commands: ControlCommandRepository, options: ReceiptSweeperOptions) {
    if (options.outbox && !options.withTransaction) {
      throw new Error("超时收口要推事件时必须配置事务句柄，避免状态与事件分家");
    }
    this.commands = commands;
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(1000, this.options.intervalMs ?? 60_000);
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((error: unknown) => {
        // 单条失败由 sweepOnce 内部回调处理；走到这里说明整轮查询炸了，留给下一轮重试
        console.error("[control-service] 超时收口扫描失败", error instanceof Error ? error.message : String(error));
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 执行一轮收口。
   * @param nowMs 判定时刻，测试可注入
   * @returns 本轮实际收口的指令条数
   */
  async sweepOnce(nowMs = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const candidates = await this.commands.listOverdue(this.options.timeoutMin, nowMs, this.options.batchSize ?? 50);
      let closed = 0;
      for (const command of candidates) {
        try {
          if (await this.fail(command, nowMs)) closed += 1;
        } catch (error) {
          this.options.onError?.(command.id, error instanceof Error ? error : new Error(String(error)));
        }
      }
      return closed;
    } finally {
      this.running = false;
    }
  }

  /**
   * 收口一条指令：状态置 FAILED，并按配置同事务写超时事件。
   * @returns 是否真的推进了（版本被现场回执抢走时返回 false）
   */
  private async fail(command: ControlCommand, nowMs: number): Promise<boolean> {
    const waited = pendingMinutesOf(command, nowMs) ?? 0;
    const transition = {
      id: command.id,
      status: "FAILED" as const,
      at: new Date(nowMs).toISOString(),
      version: command.version,
      message: `超过 ${this.options.timeoutMin} 分钟未收到设备回执（已等待 ${waited} 分钟），系统自动收口为失败`,
    };
    const payload: CommandTimeoutPayload = {
      commandId: command.id,
      parcelId: command.plotCode,
      deviceId: command.deviceId,
      commandType: command.type,
      pendingMin: waited,
      timeoutMin: this.options.timeoutMin,
      failedAt: transition.at,
    };
    const outbox = this.options.outbox;
    if (!outbox) return (await this.commands.transition(command.tenantId, transition)) !== null;

    const run = async (tx: Tx | undefined): Promise<boolean> => {
      // 先跃迁再入队：跃迁不成立（现场回执先到终态）就不留事件，避免推出一条没人改状态的孤儿消息
      const updated = await this.commands.transition(command.tenantId, transition, tx);
      if (!updated) return false;
      await outbox.enqueue(tx, EventTopic.ControlCommandTimeout, payload, {
        tenantId: command.tenantId,
        traceId: `control-timeout:${command.id}`,
        producer: "control",
      });
      return true;
    };
    const withTransaction = this.options.withTransaction;
    // SQL 消息表要求事务句柄，内存模式（测试与本地）直接按无事务跑
    return withTransaction ? await withTransaction(run) : await run(undefined);
  }
}
