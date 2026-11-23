import type { Device, DeviceRepository } from "./device.repository.js";

/**
 * MQTT 指令中继（B2）。
 *
 * 场网关（FieldGateway）只服务 MODBUS_TCP 协议设备：领取指令、写线圈、回读反馈。
 * MQTT 直连设备（拖拉机等）订阅 `agri/{tenant}/{deviceNo}/command` 主题收指令，
 * 但控制服务的指令入队后没有任何一方把它们发布到 MQTT——场网关不领取 MQTT 设备，
 * 指令会永远停在 QUEUED 直到超时收口。本中继补上这一段：
 *
 * 按设备轮询控制服务待领取指令，对 QUEUED 指令先领取（推进 SENT）再经
 * MqttBroker.publishCommand 发布到指令主题；设备回执仍走 receipt 主题由
 * MqttBroker 转发，控制服务按既有状态机收口。
 *
 * 只处理 QUEUED：领取后指令已是 SENT，下轮轮询不会重复发布，避免设备收到重复指令。
 */

/** 控制服务设备通道返回的指令视图（与 field-gateway 的 FieldCommand 同形状） */
export interface FieldCommand {
  id: string;
  deviceId: string;
  plotCode: string;
  type: string;
  status: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}

export interface MqttCommandRelayOptions {
  devices: DeviceRepository;
  /** 控制服务地址，缺省 http://127.0.0.1:3008 */
  controlUrl?: string;
  tenantId: string;
  /** 设备回调凭证，与 MqttBroker 转发同口径 */
  deviceToken?: string;
  /** MQTT 指令发布器，由 MqttBroker 注入 */
  publishCommand: (deviceNo: string, command: unknown) => void;
  /** 轮询间隔（毫秒），缺省 2000 */
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (deviceNo: string, error: Error) => void;
}

export interface MqttCommandRelay {
  /** 立即执行一轮全量中继；进行中时复用当前轮次，不重叠 */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

export function createMqttCommandRelay(options: MqttCommandRelayOptions): MqttCommandRelay {
  const controlUrl = (options.controlUrl ?? "http://127.0.0.1:3008").replace(/\/+$/, "");
  const intervalMs = Math.max(500, options.intervalMs ?? 2000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tenant-id": options.tenantId,
    ...(options.deviceToken ? { "x-device-token": options.deviceToken } : {}),
  };
  const onError = options.onError ?? ((deviceNo: string, error: Error): void => {
    console.warn(`[mqtt-relay] ${deviceNo} 指令中继失败：${error.message}`);
  });

  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(`${controlUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || !payload || payload.code !== "OK") {
      throw new Error(`控制服务 ${path} 失败：${response.status} ${payload?.message ?? "无响应体"}`);
    }
    return payload.data;
  };

  const relayForDevice = async (device: Device): Promise<void> => {
    const page = await call<{ items: FieldCommand[] }>("GET", `/api/v1/control/device/pending?deviceId=${encodeURIComponent(device.id)}&size=50`);
    for (const command of page.items) {
      // 只领取 QUEUED：领取后变 SENT，下轮不再重复发布
      if (command.status !== "QUEUED") continue;
      await call("POST", "/api/v1/control/device/dispatch", { commandId: command.id });
      options.publishCommand(device.deviceNo, command);
    }
  };

  let ticking: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (ticking) return ticking;
    ticking = (async () => {
      const devices = await options.devices.list(options.tenantId, { protocol: "MQTT" });
      for (const device of devices) {
        try {
          await relayForDevice(device);
        } catch (error) {
          onError(device.deviceNo, error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();
    try {
      await ticking;
    } finally {
      ticking = undefined;
    }
  };

  return {
    tick,
    start(): void {
      timer = setInterval(() => { void tick(); }, intervalMs);
      void tick();
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
