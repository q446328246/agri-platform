import type { PtzCommand } from "./ptz.repository.js";

/**
 * 云台投递通道。
 *
 * 摄像机云台属于现场硬件，平台不自带厂商 SDK：配置 PTZ_WEBHOOK_URL 后把指令 POST 给
 * 摄像机网关（国标平台/厂商服务），按真实响应记 SENT/FAILED；未配置时指令留存 QUEUED
 * 并明确告知通道未接入，不假装下发成功。
 */
export interface PtzChannel {
  readonly configured: boolean;
  deliver(command: PtzCommand): Promise<{ ok: boolean; message: string }>;
}

export class UnconfiguredPtzChannel implements PtzChannel {
  readonly configured = false;
  async deliver(): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: "云台控制通道未配置，指令已留存；接入摄像机网关（PTZ_WEBHOOK_URL）后可重试下发" };
  }
}

export class WebhookPtzChannel implements PtzChannel {
  readonly configured = true;
  constructor(private readonly url: string, private readonly timeoutMs = 5000, private readonly fetchImpl: typeof fetch = fetch) {}

  async deliver(command: PtzCommand): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: command.id, cameraId: command.cameraId, action: command.action, ...(command.speed !== undefined ? { speed: command.speed } : {}) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok
        ? { ok: true, message: `摄像机网关已接收（${response.status}）` }
        : { ok: false, message: `摄像机网关返回 ${response.status}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "摄像机网关不可达" };
    }
  }
}