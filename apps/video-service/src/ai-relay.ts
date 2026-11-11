import { forwardPestDetection } from "./ai-event.js";
import type { ForwardResult } from "./ai-event.js";
import { toDetection } from "./ai-event.repository.js";
import type { AiEventRepository } from "./ai-event.repository.js";

export interface AiRelayOptions {
  baseUrl: string;
  deviceToken?: string | undefined;
  /** 补投间隔，默认 30 秒 */
  intervalMs?: number;
  /** 失败重试上限（含首次转发），默认 5 次；人工重试不受限 */
  maxRetries?: number;
  batchSize?: number;
  forward?: (detection: Parameters<typeof forwardPestDetection>[0], options: { baseUrl: string; deviceToken?: string | undefined }) => Promise<ForwardResult>;
}

/** 转发失败的识别事件按接收时间顺序补投，超过上限后停止自动重试，仍可人工触发 */
export class AiForwardRelay {
  private timer?: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly events: AiEventRepository, private readonly options: AiRelayOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const pending = await this.events.listRetryable(this.options.batchSize ?? 20, this.options.maxRetries ?? 5);
      const forward = this.options.forward ?? forwardPestDetection;
      let forwarded = 0;
      for (const event of pending) {
        const result = await forward(toDetection(event), { baseUrl: this.options.baseUrl, deviceToken: this.options.deviceToken });
        if (result.forwarded) {
          await this.events.markForwarded(event.tenantId, event.id, new Date().toISOString(), result.status, result.message);
          forwarded += 1;
        } else {
          await this.events.markFailed(event.tenantId, event.id, result.status, result.message);
        }
      }
      return forwarded;
    } finally {
      this.running = false;
    }
  }
}