import { readFileSync } from "node:fs";

import mqtt, { type MqttClient } from "mqtt";

import { DEFAULT_TENANT } from "./device.repository.js";
import { InMemoryMqttDeliveryRepository, type MqttDelivery, type MqttDeliveryRepository } from "./mqtt-delivery.repository.js";

export interface MqttBrokerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MqttBrokerOptions {
  url?: string | undefined;
  telemetryUrl?: string | undefined;
  controlUrl?: string | undefined;
  tenantId?: string | undefined;
  topicPrefix?: string | undefined;
  deviceToken?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  clientId?: string | undefined;
  caPath?: string | undefined;
  rejectUnauthorized?: boolean | undefined;
  retryIntervalMs?: number;
  deliveries?: MqttDeliveryRepository;
  resolveDeviceId?: (deviceNo: string) => Promise<string | null>;
  logger?: MqttBrokerLogger;
  clientFactory?: (url: string, options: mqtt.IClientOptions) => MqttClient;
  fetchImpl?: typeof fetch;
}

export interface MqttBroker {
  start(): void;
  stop(): Promise<void>;
  publishCommand(deviceNo: string, payload: unknown): Promise<boolean>;
}

const DEFAULT_TELEMETRY_URL = "http://127.0.0.1:3004";
const DEFAULT_CONTROL_URL = "http://127.0.0.1:3008";

type AckCallback = (error: Error | number, code?: number) => void;
type InboundPacket = { mid?: number; dup?: boolean };

export function createMqttBroker(options: MqttBrokerOptions = {}): MqttBroker {
  const tenantId = options.tenantId?.trim() || process.env.TENANT_ID?.trim() || DEFAULT_TENANT;
  const topicPrefix = options.topicPrefix?.trim() || process.env.MQTT_TOPIC_PREFIX?.trim() || "agri";
  const telemetryBaseUrl = (options.telemetryUrl?.trim() || process.env.TELEMETRY_SERVICE_URL?.trim() || DEFAULT_TELEMETRY_URL).replace(/\/+$/, "");
  const controlBaseUrl = (options.controlUrl?.trim() || process.env.CONTROL_SERVICE_URL?.trim() || DEFAULT_CONTROL_URL).replace(/\/+$/, "");
  const deviceToken = options.deviceToken?.trim() || process.env.DEVICE_CALLBACK_TOKEN?.trim() || "";
  const username = options.username?.trim() || process.env.MQTT_USERNAME?.trim() || "";
  const password = options.password ?? process.env.MQTT_PASSWORD ?? "";
  const clientId = options.clientId?.trim() || process.env.MQTT_CLIENT_ID?.trim() || `iot-service-${tenantId}`;
  const caPath = options.caPath?.trim() || process.env.MQTT_CA_PATH?.trim() || "";
  const deliveries = options.deliveries ?? new InMemoryMqttDeliveryRepository();
  const resolveDeviceId = options.resolveDeviceId ?? (async (deviceNo: string) => deviceNo);
  const telemetryTopic = `${topicPrefix}/${tenantId}/+/telemetry`;
  const receiptTopic = `${topicPrefix}/${tenantId}/+/receipt`;
  const retryIntervalMs = Math.max(500, options.retryIntervalMs ?? 2000);
  const logger = options.logger ?? {
    info: (message) => console.log(`[mqtt-broker] ${message}`),
    warn: (message, meta) => console.warn(`[mqtt-broker] ${message}`, meta ?? {}),
  };
  const clientFactory = options.clientFactory ?? ((url, opts) => mqtt.connect(url, opts));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pendingAcks = new Map<string, Set<AckCallback>>();
  const processing = new Map<string, Promise<void>>();
  // 保留完成标记，防止 processing 清理后迟到的 PENDING 快照再次转发。
  const completedDeliveryIds = new Set<string>();
  const active = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-tenant-id": tenantId,
    ...(deviceToken ? { "x-device-token": deviceToken } : {}),
  });

  const client = clientFactory(options.url?.trim() || process.env.MQTT_URL?.trim() || "mqtt://127.0.0.1:1883", {
    clientId,
    protocolVersion: 5,
    clean: false,
    properties: { sessionExpiryInterval: 86_400 },
    reconnectPeriod: 5000,
    customHandleAcks: (topic, payload, packet, callback) => {
      void acceptInbound(topic, payload, packet as InboundPacket, callback).catch((error) => {
        logger.warn("MQTT 入站消息入队失败", { topic, error: String(error) });
      });
    },
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(caPath ? { ca: readFileSync(caPath) } : {}),
    ...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
  });

  function topicDevice(topic: string): { deviceNo: string; kind: "telemetry" | "receipt" } | null {
    const segments = topic.split("/");
    if (segments.length !== 4 || segments[0] !== topicPrefix || segments[1] !== tenantId) return null;
    if (segments[3] !== "telemetry" && segments[3] !== "receipt") return null;
    if (!segments[2] || /[+#]/.test(segments[2])) return null;
    return { deviceNo: segments[2], kind: segments[3] };
  }

  function acknowledge(deliveryId: string): void {
    const callbacks = pendingAcks.get(deliveryId);
    pendingAcks.delete(deliveryId);
    for (const callback of callbacks ?? []) callback(0, 0);
  }

  function registerAck(deliveryId: string, callback: AckCallback): void {
    if (completedDeliveryIds.has(deliveryId)) {
      callback(0, 0);
      return;
    }
    const callbacks = pendingAcks.get(deliveryId) ?? new Set<AckCallback>();
    callbacks.add(callback);
    pendingAcks.set(deliveryId, callbacks);
  }

  async function forward(delivery: MqttDelivery): Promise<void> {
    if (delivery.direction !== "INBOUND") return;
    const path = delivery.topic.endsWith("/telemetry") ? "/api/v1/telemetry/report" : "/api/v1/control/device/receipt";
    const baseUrl = delivery.topic.endsWith("/telemetry") ? telemetryBaseUrl : controlBaseUrl;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(delivery.payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  }

  async function processInbound(delivery: MqttDelivery): Promise<void> {
    if (completedDeliveryIds.has(delivery.id)) {
      acknowledge(delivery.id);
      return;
    }
    const running = processing.get(delivery.id);
    if (running) return running;
    const task = (async () => {
      try {
        await forward(delivery);
        await deliveries.complete(delivery.id);
        completedDeliveryIds.add(delivery.id);
        if (completedDeliveryIds.size > 10_000) completedDeliveryIds.delete(completedDeliveryIds.values().next().value!);
        acknowledge(delivery.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deliveries.fail(delivery.id, message, Date.now());
        logger.warn("MQTT 入站投递失败，等待重试", { topic: delivery.topic, error: message });
      }
    })();
    processing.set(delivery.id, task);
    active.add(task);
    try {
      await task;
    } finally {
      processing.delete(delivery.id);
      active.delete(task);
    }
  }

  async function acceptInbound(topic: string, payload: Buffer, packet: InboundPacket, callback: AckCallback): Promise<void> {
    const parsedTopic = topicDevice(topic);
    if (!parsedTopic) {
      logger.warn("MQTT 主题不属于当前接入范围，已丢弃", { topic });
      callback(0, 0);
      return;
    }
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(payload.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("消息体必须是 JSON 对象");
      body = value as Record<string, unknown>;
    } catch (error) {
      logger.warn("MQTT 消息 JSON 非法，已丢弃", { topic, error: error instanceof Error ? error.message : String(error) });
      callback(0, 0);
      return;
    }
    const claimedDevice = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (claimedDevice && claimedDevice !== parsedTopic.deviceNo) {
      logger.warn("MQTT 消息 deviceId 与主题设备不一致，已丢弃", { topic, deviceId: claimedDevice });
      callback(0, 0);
      return;
    }
    if (parsedTopic.kind === "telemetry" && !String(body.metric ?? "").trim()) {
      logger.warn("遥测消息缺少 metric，已丢弃", { topic });
      callback(0, 0);
      return;
    }
    if (parsedTopic.kind === "receipt" && (!String(body.commandId ?? "").trim() || !String(body.status ?? "").trim())) {
      logger.warn("回执消息缺少 commandId/status，已丢弃", { topic });
      callback(0, 0);
      return;
    }
    const deviceId = await resolveDeviceId(parsedTopic.deviceNo);
    if (!deviceId) {
      logger.warn("MQTT 主题设备未在台账登记，已丢弃", { topic, deviceNo: parsedTopic.deviceNo });
      callback(0, 0);
      return;
    }
    const delivery = await deliveries.enqueueInbound({
      direction: "INBOUND",
      tenantId,
      deviceNo: parsedTopic.deviceNo,
      deviceId,
      topic,
      payload: { ...body, deviceId },
    }, { ...(packet.mid !== undefined ? { packetId: packet.mid } : {}), duplicate: packet.dup === true });
    if (delivery.status === "DONE" || completedDeliveryIds.has(delivery.id)) {
      callback(0, 0);
      return;
    }
    registerAck(delivery.id, callback);
    await processInbound(delivery);
  }

  async function flushInbound(): Promise<void> {
    const due = await deliveries.due(Date.now(), 100);
    for (const delivery of due) {
      if (delivery.direction === "INBOUND") await processInbound(delivery);
    }
  }

  return {
    start(): void {
      client.on("connect", () => {
        client.subscribe(telemetryTopic, { qos: 1 }, (error) => {
          if (error) logger.warn("订阅遥测 topic 失败", { topic: telemetryTopic, error: error.message });
          else logger.info("已订阅遥测 topic", { topic: telemetryTopic });
        });
        client.subscribe(receiptTopic, { qos: 1 }, (error) => {
          if (error) logger.warn("订阅回执 topic 失败", { topic: receiptTopic, error: error.message });
          else logger.info("已订阅回执 topic", { topic: receiptTopic });
        });
        void flushInbound().catch((error) => logger.warn("MQTT 入站重试扫描失败", { error: String(error) }));
      });
      client.on("error", (error) => logger.warn("MQTT 连接错误", { error: error.message }));
      timer = setInterval(() => {
        void flushInbound().catch((error) => logger.warn("MQTT 入站重试扫描失败", { error: String(error) }));
      }, retryIntervalMs);
    },
    async stop(): Promise<void> {
      stopping = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([...active]);
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    },
    async publishCommand(deviceNo: string, payload: unknown): Promise<boolean> {
      const device = deviceNo.trim();
      if (!device || stopping || !client.connected) return false;
      const topic = `${topicPrefix}/${tenantId}/${device}/command`;
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);
        client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
          clearTimeout(timeout);
          if (error) logger.warn("指令下发 MQTT 发布失败", { topic, error: error.message });
          resolve(!error);
        });
      });
    },
  };
}
