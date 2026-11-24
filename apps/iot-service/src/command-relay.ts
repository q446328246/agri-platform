import type { Device, DeviceRepository } from "./device.repository.js";
import { InMemoryMqttDeliveryRepository, type MqttDeliveryRepository } from "./mqtt-delivery.repository.js";

export interface FieldCommand {
  id: string;
  deviceId: string;
  plotCode: string;
  type: string;
  status: string;
  parameters: Record<string, unknown>;
  createdAt: string;
  dispatchable?: boolean;
}

export interface MqttCommandRelayOptions {
  devices: DeviceRepository;
  deliveries?: MqttDeliveryRepository;
  controlUrl?: string | undefined;
  tenantId: string;
  topicPrefix?: string;
  deviceToken?: string | undefined;
  publishCommand: (deviceNo: string, command: unknown) => Promise<boolean> | boolean;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (deviceNo: string, error: Error) => void;
}

export interface MqttCommandRelay {
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
  const topicPrefix = options.topicPrefix?.trim() || process.env.MQTT_TOPIC_PREFIX?.trim() || "agri";
  const fetchImpl = options.fetchImpl ?? fetch;
  const deliveries = options.deliveries ?? new InMemoryMqttDeliveryRepository();
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
      signal: AbortSignal.timeout(5000),
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || !payload || payload.code !== "OK") {
      throw new Error(`控制服务 ${path} 失败：${response.status} ${payload?.message ?? "无响应体"}`);
    }
    return payload.data;
  };

  const deliver = async (device: Device, queued: FieldCommand): Promise<void> => {
    await deliveries.enqueueOutbound({
      tenantId: options.tenantId,
      deviceNo: device.deviceNo,
      deviceId: device.id,
      topic: `${topicPrefix}/${options.tenantId}/${device.deviceNo}/command`,
      payload: { ...queued },
    });
    const claimed = await call<FieldCommand>("POST", "/api/v1/control/device/dispatch", { commandId: queued.id, deviceId: device.id, requireQueued: true });
    if (claimed.deviceId !== device.id) throw new Error("控制服务返回的指令设备与中继设备不一致");
    if (claimed.dispatchable === false) {
      await deliveries.complete(`out-${queued.id}`);
      return;
    }
    const command = { ...claimed };
    delete command.dispatchable;
    await deliveries.enqueueOutbound({
      tenantId: options.tenantId,
      deviceNo: device.deviceNo,
      deviceId: device.id,
      topic: `${topicPrefix}/${options.tenantId}/${device.deviceNo}/command`,
      payload: command,
    });
    const published = await options.publishCommand(device.deviceNo, command);
    if (!published) throw new Error("MQTT broker 未确认指令发布");
    await deliveries.complete(`out-${queued.id}`);
  };

  const recover = async (): Promise<void> => {
    const due = await deliveries.due(Date.now(), 100);
    for (const row of due) {
      if (row.direction !== "OUTBOUND") continue;
      try {
        const device = await options.devices.find(options.tenantId, row.deviceId);
        if (!device || device.protocol !== "MQTT" || device.deviceNo !== row.deviceNo) {
          await deliveries.complete(row.id);
          continue;
        }
        await deliver(device, row.payload as unknown as FieldCommand);
      } catch (error) {
        await deliveries.fail(row.id, error instanceof Error ? error.message : String(error), Date.now());
        onError(row.deviceNo, error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  let ticking: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (ticking) return ticking;
    ticking = (async () => {
      await deliveries.cleanup(Date.now(), 100);
      await recover();
      const devices = await options.devices.list(options.tenantId, { protocol: "MQTT" });
      for (const device of devices) {
        try {
          const page = await call<{ items: FieldCommand[] }>("GET", `/api/v1/control/device/pending?deviceId=${encodeURIComponent(device.id)}&size=50`);
          for (const command of page.items) {
            if (command.status !== "QUEUED") continue;
            await deliver(device, command);
          }
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
