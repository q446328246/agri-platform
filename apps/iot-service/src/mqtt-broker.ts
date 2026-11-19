import mqtt, { type MqttClient } from "mqtt";

/**
 * MQTT 接入适配器（A2）：订阅设备遥测与执行回执 topic，并把平台指令下发到设备。
 *
 * Topic 规范：
 * - `agri/{tenantId}/{deviceNo}/telemetry` 设备 → 平台：遥测/状态
 * - `agri/{tenantId}/{deviceNo}/command`   平台 → 设备：指令下发
 * - `agri/{tenantId}/{deviceNo}/receipt`   设备 → 平台：执行回执
 *
 * 遥测解析后转发到 telemetry-service `POST /api/v1/telemetry/report`；
 * 回执转发到 control-service `POST /api/v1/control/device/receipt`（复用 ControlChannel 口径）。
 * 适配器只做解析与转发，不落库——落库与告警口径仍由遥测/控制服务统一收口。
 *
 * 鉴权：转发时携带 `DEVICE_CALLBACK_TOKEN`（`x-device-token` 头），与
 * field-gateway 的 HTTP 回调通道同口径；未配置时省略该头，回落用户身份通道。
 *
 * 开关：`IOT_MQTT_ENABLED=1` 时由 main.ts 启动；缺省关闭，保留 HTTP 回调链路。
 */

export interface MqttBrokerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MqttBrokerOptions {
  /** Broker 地址，缺省 mqtt://127.0.0.1:1883 */
  url?: string | undefined;
  /** 遥测服务上报地址，缺省取 TELEMETRY_SERVICE_URL 或 http://127.0.0.1:3004 */
  telemetryUrl?: string | undefined;
  /** 控制服务地址，缺省取 CONTROL_SERVICE_URL 或 http://127.0.0.1:3008 */
  controlUrl?: string | undefined;
  /** 租户，缺省取进程 TENANT_ID */
  tenantId?: string | undefined;
  /** topic 前缀，缺省 agri */
  topicPrefix?: string | undefined;
  /** 设备回调共享凭证（DEVICE_CALLBACK_TOKEN）；未配置时不发送 x-device-token 头 */
  deviceToken?: string | undefined;
  logger?: MqttBrokerLogger;
  /** 连接客户端注入点，测试用 */
  clientFactory?: (url: string, options: mqtt.IClientOptions) => MqttClient;
  /** HTTP 注入点，测试用 */
  fetchImpl?: typeof fetch;
}

export interface MqttBroker {
  start(): void;
  stop(): Promise<void>;
  /** 平台向设备下发指令：发布到 `{prefix}/{tenant}/{deviceNo}/command`（QoS 1），返回是否已入队 */
  publishCommand(deviceNo: string, payload: unknown): boolean;
}

const DEFAULT_TELEMETRY_URL = "http://127.0.0.1:3004";
const DEFAULT_CONTROL_URL = "http://127.0.0.1:3008";

export function createMqttBroker(options: MqttBrokerOptions = {}): MqttBroker {
  const tenantId = options.tenantId?.trim() || process.env.TENANT_ID?.trim() || "default";
  const topicPrefix = options.topicPrefix?.trim() || "agri";
  const telemetryBaseUrl = (options.telemetryUrl?.trim() || process.env.TELEMETRY_SERVICE_URL?.trim() || DEFAULT_TELEMETRY_URL).replace(/\/+$/, "");
  const controlBaseUrl = (options.controlUrl?.trim() || process.env.CONTROL_SERVICE_URL?.trim() || DEFAULT_CONTROL_URL).replace(/\/+$/, "");
  const deviceToken = options.deviceToken?.trim() || process.env.DEVICE_CALLBACK_TOKEN?.trim() || "";
  const telemetryTopic = `${topicPrefix}/${tenantId}/+/telemetry`;
  const receiptTopic = `${topicPrefix}/${tenantId}/+/receipt`;
  const logger = options.logger ?? {
    info: (message) => console.log(`[mqtt-broker] ${message}`),
    warn: (message, meta) => console.warn(`[mqtt-broker] ${message}`, meta ?? {}),
  };
  const clientFactory = options.clientFactory ?? ((url, opts) => mqtt.connect(url, opts));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-tenant-id": tenantId,
    ...(deviceToken ? { "x-device-token": deviceToken } : {}),
  });

  const client = clientFactory(options.url?.trim() || process.env.MQTT_URL?.trim() || "mqtt://127.0.0.1:1883", {
    clientId: `iot-service-mqtt-${process.pid}`,
    reconnectPeriod: 5000,
  });

  async function forwardTelemetry(topic: string, payload: Buffer): Promise<void> {
    try {
      const text = payload.toString("utf8").trim();
      if (!text) return;
      const body = JSON.parse(text) as Record<string, unknown>;
      const deviceId = String(body.deviceId ?? "").trim();
      const metric = String(body.metric ?? "").trim();
      // 设备自报 deviceId 优先；缺省用 topic 里的设备号兜底（topic 段：agri/tenant/deviceNo/telemetry）
      const segments = topic.split("/").filter(Boolean);
      const deviceNo = deviceId || (segments.length >= 2 ? segments[segments.length - 2] : "");
      if (!deviceNo || !metric) {
        logger.warn("遥测消息缺少 deviceId/metric，已跳过", { topic });
        return;
      }
      const response = await fetchImpl(`${telemetryBaseUrl}/api/v1/telemetry/report`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...body, deviceId: deviceNo, metric }),
      });
      if (!response.ok) {
        logger.warn("遥测上报失败", { topic, status: response.status });
      }
    } catch (error) {
      logger.warn("遥测消息处理失败", { topic, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function forwardReceipt(topic: string, payload: Buffer): Promise<void> {
    try {
      const text = payload.toString("utf8").trim();
      if (!text) return;
      const body = JSON.parse(text) as Record<string, unknown>;
      const commandId = String(body.commandId ?? "").trim();
      const status = String(body.status ?? "").trim();
      if (!commandId || !status) {
        logger.warn("回执消息缺少 commandId/status，已跳过", { topic });
        return;
      }
      const response = await fetchImpl(`${controlBaseUrl}/api/v1/control/device/receipt`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...body, commandId, status }),
      });
      if (!response.ok) {
        logger.warn("回执上报失败", { topic, status: response.status });
      }
    } catch (error) {
      logger.warn("回执消息处理失败", { topic, error: error instanceof Error ? error.message : String(error) });
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
      });
      client.on("message", (topic, payload) => {
        if (topic.endsWith("/telemetry")) void forwardTelemetry(topic, payload);
        else if (topic.endsWith("/receipt")) void forwardReceipt(topic, payload);
      });
      client.on("error", (error) => {
        logger.warn("MQTT 连接错误", { error: error.message });
      });
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    },
    publishCommand(deviceNo: string, payload: unknown): boolean {
      const device = deviceNo.trim();
      if (!device) return false;
      const topic = `${topicPrefix}/${tenantId}/${device}/command`;
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) logger.warn("指令下发 MQTT 发布失败", { topic, error: error.message });
      });
      // mqtt.js 的 publish 返回客户端实例本身，实际投递失败由回调告警，这里以调用已受理为准
      return true;
    },
  };
}
