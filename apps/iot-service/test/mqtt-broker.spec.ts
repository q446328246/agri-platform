import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MqttClient } from "mqtt";

import { createMqttBroker } from "../src/mqtt-broker.js";
import type { MqttBrokerOptions } from "../src/mqtt-broker.js";
import { InMemoryMqttDeliveryRepository } from "../src/mqtt-delivery.repository.js";

/**
 * MQTT 接入适配器（A2）行为验证：不连真 broker，也不起遥测/控制服务。
 *
 * `clientFactory` 换成能手动 emit/publish 的假客户端，`fetchImpl` 换成记录请求的假 HTTP。
 * 断言的是「订阅了哪些 topic、遥测与回执各转发到哪个地址、指令下发到哪个 topic、
 * 带了什么凭证与字段、坏消息是否跳过」——这些错了，接上真 EMQX 只会更错。
 */

/** 最小 MQTT 客户端替身：记事件、订阅、发布、可手动触发、可断言结束 */
class FakeMqttClient {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly subscriptions: Array<{ topic: string; options: unknown }> = [];
  readonly published: Array<{ topic: string; payload: string; options: unknown }> = [];
  connectionOptions: mqtt.IClientOptions = {};
  publishError: Error | undefined;
  connected = true;
  ended = false;

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  subscribe(topic: string, options: unknown, callback?: (error?: Error) => void): void {
    this.subscriptions.push({ topic, options });
    callback?.();
  }

  end(_force: boolean, _options: unknown, callback?: () => void): void {
    this.ended = true;
    callback?.();
  }

  publish(topic: string, payload: string, options: unknown, callback?: (error?: Error) => void): boolean {
    this.published.push({ topic, payload, options });
    callback?.(this.publishError);
    return !this.publishError;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface LogEntry {
  message: string;
  meta?: Record<string, unknown> | undefined;
}

function createGate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** 控制仓储返回快照的时机：第二次调用先读取 PENDING，再暂停交给 broker。 */
function holdSecondInboundSnapshot(repository: InMemoryMqttDeliveryRepository) {
  const snapshotTaken = createGate();
  const releaseSnapshot = createGate();
  const enqueueInbound = repository.enqueueInbound.bind(repository);
  let calls = 0;
  vi.spyOn(repository, "enqueueInbound").mockImplementation(async (...args) => {
    const snapshot = await enqueueInbound(...args);
    calls += 1;
    if (calls === 2) {
      snapshotTaken.open();
      await releaseSnapshot.promise;
    }
    return snapshot;
  });
  return { snapshotTaken: snapshotTaken.promise, releaseSnapshot: releaseSnapshot.open };
}

function createHarness(overrides: Partial<MqttBrokerOptions> = {}) {
  const client = new FakeMqttClient();
  const requests: CapturedRequest[] = [];
  const warnings: LogEntry[] = [];
  const infos: LogEntry[] = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [name, value] of Object.entries(init.headers as Record<string, string>)) headers[name.toLowerCase()] = value;
    }
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;

  const broker = createMqttBroker({
    url: "mqtt://broker.test:1883",
    username: "test-service",
    password: "test-password",
    tenantId: "tenant-demo",
    telemetryUrl: "http://telemetry.test:3004",
    controlUrl: "http://control.test:3008",
    clientFactory: (_url, connectionOptions) => {
      client.connectionOptions = connectionOptions;
      return client as unknown as MqttClient;
    },
    fetchImpl,
    logger: {
      info: (message, meta) => {
        infos.push({ message, meta });
      },
      warn: (message, meta) => {
        warnings.push({ message, meta });
      },
    },
    ...overrides,
  });

  let packetId = 0;
  const receive = (topic: string, body: string, onAck: (error: Error | number, code?: number) => void = () => {}, packet: { mid?: number; dup?: boolean } = {}): void => {
    packetId += 1;
    void client.connectionOptions.customHandleAcks?.(topic, Buffer.from(body), { qos: 1, mid: packet.mid ?? packetId, dup: packet.dup ?? false }, onAck);
  };
  return { broker, client, requests, warnings, infos, fetchImpl, receive };
}

describe("createMqttBroker", () => {
  it("未传 tenantId 且无 TENANT_ID 时落全仓统一的演示租户，与指令中继同口径", () => {
    // 曾缺省 "default"：中继按 tenant-demo 找设备、往 agri/default/... 发指令，
    // 设备按 agri/tenant-demo/... 上报又订阅不到——两侧静默错开，无任何报错。
    const previous = process.env.TENANT_ID;
    delete process.env.TENANT_ID;
    try {
      const { broker, client } = createHarness({ tenantId: undefined });
      broker.start();
      client.emit("connect");
      expect(client.subscriptions).toEqual([
        { topic: "agri/tenant-demo/+/telemetry", options: { qos: 1 } },
        { topic: "agri/tenant-demo/+/receipt", options: { qos: 1 } },
      ]);
      void broker.publishCommand("DEV-001", { id: "cmd-1" });
      expect(client.published[0]!.topic).toBe("agri/tenant-demo/DEV-001/command");
    } finally {
      if (previous !== undefined) process.env.TENANT_ID = previous;
    }
  });

  it("start 后同时订阅遥测与回执 topic（QoS 1）", () => {
    const { broker, client, infos } = createHarness();
    broker.start();
    client.emit("connect");
    expect(client.subscriptions).toEqual([
      { topic: "agri/tenant-demo/+/telemetry", options: { qos: 1 } },
      { topic: "agri/tenant-demo/+/receipt", options: { qos: 1 } },
    ]);
    expect(infos.some((entry) => entry.message.includes("已订阅"))).toBe(true);
  });

  it("遥测消息转发到遥测服务，携带设备回调凭证与租户头", async () => {
    const { broker, requests, receive } = createHarness({ deviceToken: "device-secret" });
    broker.start();
    receive(
      "agri/tenant-demo/DEV-001/telemetry",
      JSON.stringify({ deviceId: "DEV-001", plotCode: "PLOT-1", metric: "soilMoisture", value: 42.5, unit: "%", recordedAt: "2026-11-19T00:00:00Z" }),
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!).toMatchObject({
      url: "http://telemetry.test:3004/api/v1/telemetry/report",
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo", "x-device-token": "device-secret" },
    });
    expect(requests[0]!.body).toMatchObject({ deviceId: "DEV-001", plotCode: "PLOT-1", metric: "soilMoisture", value: 42.5, unit: "%", recordedAt: "2026-11-19T00:00:00Z" });
  });

  it("相同载荷的正常遥测重复上报各自转发，不误当业务重复", async () => {
    const { broker, requests, receive } = createHarness();
    broker.start();
    const body = JSON.stringify({ metric: "soilMoisture", value: 12 });
    receive("agri/tenant-demo/DEV-001/telemetry", body);
    receive("agri/tenant-demo/DEV-001/telemetry", body);

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.body).toEqual(requests[1]!.body);
  });

  it("已确认报文的重传只确认不重复转发，新报文复用标识仍转发", async () => {
    const { broker, requests, receive } = createHarness();
    broker.start();
    const body = JSON.stringify({ metric: "soilMoisture", value: 12 });
    receive("agri/tenant-demo/DEV-001/telemetry", body, () => {}, { mid: 9 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    const retransmissionAck = vi.fn();
    receive("agri/tenant-demo/DEV-001/telemetry", body, retransmissionAck, { mid: 9, dup: true });
    await vi.waitFor(() => expect(retransmissionAck).toHaveBeenCalledWith(0, 0));
    expect(requests).toHaveLength(1);

    receive("agri/tenant-demo/DEV-001/telemetry", body, () => {}, { mid: 9 });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
  });

  it("完成并清理 processing 后收到的旧 PENDING 快照只确认、不重复转发", async () => {
    const deliveries = new InMemoryMqttDeliveryRepository();
    const { snapshotTaken, releaseSnapshot } = holdSecondInboundSnapshot(deliveries);
    const fetchGate = createGate();
    const fetchImpl = vi.fn(async () => {
      await fetchGate.promise;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const { broker, receive } = createHarness({ deliveries, fetchImpl });
    const firstAck = vi.fn();
    const lateAck = vi.fn();
    const body = JSON.stringify({ metric: "soilMoisture", value: 12 });
    broker.start();
    receive("agri/tenant-demo/DEV-001/telemetry", body, firstAck, { mid: 9 });
    receive("agri/tenant-demo/DEV-001/telemetry", body, lateAck, { mid: 9, dup: true });

    try {
      await snapshotTaken;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      fetchGate.open();
      await vi.waitFor(() => expect(firstAck).toHaveBeenCalledWith(0, 0));
      // stop 等待在途投递结束，确保 processInbound 已删除 processing。
      await broker.stop();
      releaseSnapshot();
      await vi.waitFor(() => expect(lateAck).toHaveBeenCalledWith(0, 0));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      fetchGate.open();
      releaseSnapshot();
      await broker.stop();
    }
  });

  it("确认后、processing 清理前注册的迟到 callback 立即收到 PUBACK", async () => {
    const deliveries = new InMemoryMqttDeliveryRepository();
    const { snapshotTaken, releaseSnapshot } = holdSecondInboundSnapshot(deliveries);
    const fetchGate = createGate();
    const fetchImpl = vi.fn(async () => {
      await fetchGate.promise;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const { broker, receive } = createHarness({ deliveries, fetchImpl });
    const firstAck = vi.fn(() => releaseSnapshot());
    const lateAck = vi.fn();
    const body = JSON.stringify({ metric: "soilMoisture", value: 12 });
    broker.start();
    receive("agri/tenant-demo/DEV-001/telemetry", body, firstAck, { mid: 9 });
    receive("agri/tenant-demo/DEV-001/telemetry", body, lateAck, { mid: 9, dup: true });

    try {
      await snapshotTaken;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      fetchGate.open();
      await vi.waitFor(() => expect(lateAck).toHaveBeenCalledWith(0, 0));
      expect(firstAck).toHaveBeenCalledWith(0, 0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      fetchGate.open();
      releaseSnapshot();
      await broker.stop();
    }
  });

  it("回执消息转发到控制服务，复用设备回调凭证", async () => {
    const { broker, requests, receive } = createHarness({ deviceToken: "device-secret" });
    broker.start();
    receive(
      "agri/tenant-demo/DEV-001/receipt",
      JSON.stringify({ commandId: "cmd-1", status: "ACKED", message: "已写入启停线圈" }),
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!).toMatchObject({
      url: "http://control.test:3008/api/v1/control/device/receipt",
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo", "x-device-token": "device-secret" },
    });
    expect(requests[0]!.body).toMatchObject({ commandId: "cmd-1", status: "ACKED", message: "已写入启停线圈" });
  });

  it("回执缺 commandId/status 时跳过且不发请求", async () => {
    const { broker, requests, warnings, receive } = createHarness();
    broker.start();
    receive("agri/tenant-demo/DEV-001/receipt", JSON.stringify({ commandId: "cmd-1" }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
    expect(warnings.some((entry) => entry.message.includes("缺少"))).toBe(true);
  });

  it("publishCommand 下发到设备 command topic（QoS 1）", async () => {
    const { broker, client } = createHarness();
    const queued = await broker.publishCommand("DEV-001", { id: "cmd-1", type: "IRRIGATION", status: "SENT" });
    expect(queued).toBe(true);
    expect(client.published).toEqual([
      { topic: "agri/tenant-demo/DEV-001/command", payload: JSON.stringify({ id: "cmd-1", type: "IRRIGATION", status: "SENT" }), options: { qos: 1 } },
    ]);
  });

  it("publishCommand 设备号为空时不发布", async () => {
    const { broker, client } = createHarness();
    expect(await broker.publishCommand("  ", { id: "cmd-1" })).toBe(false);
    expect(client.published).toHaveLength(0);
  });

  it("payload 缺 deviceId 时用 topic 设备号兜底", async () => {
    const { broker, requests, receive } = createHarness();
    broker.start();
    receive("agri/tenant-demo/DEV-FALLBACK/telemetry", JSON.stringify({ metric: "soilMoisture", value: 12 }));

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body).toMatchObject({ deviceId: "DEV-FALLBACK", metric: "soilMoisture" });
  });

  it("遥测缺少 metric 的消息跳过且不发请求", async () => {
    const { broker, requests, warnings, receive } = createHarness();
    broker.start();
    receive("agri/tenant-demo/DEV-001/telemetry", JSON.stringify({ deviceId: "DEV-001" }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
    expect(warnings.some((entry) => entry.message.includes("缺少"))).toBe(true);
  });

  it("非法 JSON 跳过且不发请求", async () => {
    const { broker, requests, warnings, receive } = createHarness();
    broker.start();
    receive("agri/tenant-demo/DEV-001/telemetry", "not-json");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
    expect(warnings.some((entry) => entry.message.includes("JSON 非法"))).toBe(true);
  });

  it("上报返回非 2xx 时记录告警，不抛出", async () => {
    const fetchImpl = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const { broker, warnings, receive } = createHarness({ fetchImpl });
    broker.start();
    receive("agri/tenant-demo/DEV-001/telemetry", JSON.stringify({ deviceId: "DEV-001", metric: "soilMoisture", value: 1 }));

    await vi.waitFor(() => expect(warnings.some((entry) => entry.message.includes("入站投递失败"))).toBe(true));
    expect(warnings.find((entry) => entry.message.includes("入站投递失败"))?.meta).toMatchObject({ topic: "agri/tenant-demo/DEV-001/telemetry" });
  });

  it.each([400, 404, 409])("业务侧返回 %s 时确认入站消息并停止重试", async (status) => {
    const deliveries = new InMemoryMqttDeliveryRepository();
    const fetchImpl = (async () => new Response(null, { status })) as unknown as typeof fetch;
    const { broker, warnings, receive } = createHarness({ fetchImpl, deliveries, retryIntervalMs: 500 });
    const ack = vi.fn();
    broker.start();
    receive("agri/tenant-demo/DEV-001/receipt", JSON.stringify({ commandId: "cmd-unknown", status: "ACKED" }), ack);

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(0, 0));
    expect(await deliveries.due(Date.now() + 60_000, 10)).toEqual([]);
    expect(warnings.find((entry) => entry.message.includes("永久拒绝"))?.meta).toMatchObject({
      topic: "agri/tenant-demo/DEV-001/receipt",
      status,
    });
    await broker.stop();
  });

  it("启用接入时缺少用户名或口令直接失败，不静默发起无凭证连接", () => {
    vi.stubEnv("MQTT_USERNAME", "");
    vi.stubEnv("MQTT_PASSWORD", "");
    try {
      expect(() => createHarness({ username: "", password: "test-password" })).toThrow("MQTT_USERNAME is required");
      expect(() => createHarness({ username: "test-service", password: "" })).toThrow("MQTT_PASSWORD is required");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("使用稳定 clientId、持久会话和 broker 凭据", () => {
    const password = randomBytes(16).toString("hex");
    const { client } = createHarness({ username: "iot-service", password, clientId: "iot-service-tenant-demo" });
    expect(client.connectionOptions).toMatchObject({
      clientId: "iot-service-tenant-demo",
      clean: false,
      protocolVersion: 5,
      username: "iot-service",
      password,
      properties: { sessionExpiryInterval: 86_400 },
    });
    expect(client.connectionOptions.customHandleAcks).toBeTypeOf("function");
  });

  it("读取 CA 文件内容供 TLS 校验，而不是把路径当证书", () => {
    const directory = mkdtempSync(join(tmpdir(), "agri-mqtt-ca-"));
    const caPath = join(directory, "ca.crt");
    const certificate = "test-ca-certificate";
    writeFileSync(caPath, certificate);
    try {
      const { client } = createHarness({ caPath });
      expect(client.connectionOptions.ca).toEqual(Buffer.from(certificate));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("主题设备是唯一身份，并映射到台账设备 id", async () => {
    const { broker, requests, receive } = createHarness({ resolveDeviceId: async (deviceNo) => deviceNo === "DEV-001" ? "device-internal" : null });
    broker.start();
    receive("agri/tenant-demo/DEV-001/telemetry", JSON.stringify({ metric: "soilMoisture", value: 12 }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body.deviceId).toBe("device-internal");

    receive("agri/tenant-demo/DEV-001/telemetry", JSON.stringify({ deviceId: "DEV-FORGED", metric: "soilMoisture", value: 13 }));
    receive("agri/tenant-demo/UNKNOWN/telemetry", JSON.stringify({ metric: "soilMoisture", value: 14 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(1);
  });

  it("HTTP 转发失败时不确认 QoS 消息，重试成功后才确认", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 201 });
    }) as unknown as typeof fetch;
    const { broker, receive } = createHarness({ fetchImpl, retryIntervalMs: 500 });
    const ack = vi.fn();
    broker.start();
    receive("agri/tenant-demo/DEV-001/telemetry", JSON.stringify({ metric: "soilMoisture", value: 12 }), ack);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(ack).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(0, 0), { timeout: 3000 });
    expect(calls).toBe(2);
    await broker.stop();
  });

  it("broker 发布失败时返回 false，供中继保留待发记录", async () => {
    const { broker, client } = createHarness();
    client.publishError = new Error("not authorized");
    expect(await broker.publishCommand("DEV-001", { id: "cmd-1" })).toBe(false);
  });

  it("stop 结束客户端连接", async () => {
    const { broker, client } = createHarness();
    await broker.stop();
    expect(client.ended).toBe(true);
  });
});
