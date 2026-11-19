import { describe, expect, it, vi } from "vitest";
import type { MqttClient } from "mqtt";

import { createMqttBroker } from "../src/mqtt-broker.js";
import type { MqttBrokerOptions } from "../src/mqtt-broker.js";

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
    callback?.();
    return true;
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
    tenantId: "tenant-demo",
    telemetryUrl: "http://telemetry.test:3004",
    controlUrl: "http://control.test:3008",
    clientFactory: () => client as unknown as MqttClient,
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

  return { broker, client, requests, warnings, infos, fetchImpl };
}

describe("createMqttBroker", () => {
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
    const { broker, client, requests } = createHarness({ deviceToken: "device-secret" });
    broker.start();
    client.emit(
      "message",
      "agri/tenant-demo/DEV-001/telemetry",
      Buffer.from(JSON.stringify({ deviceId: "DEV-001", plotCode: "PLOT-1", metric: "soilMoisture", value: 42.5, unit: "%", recordedAt: "2026-11-19T00:00:00Z" })),
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!).toMatchObject({
      url: "http://telemetry.test:3004/api/v1/telemetry/report",
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo", "x-device-token": "device-secret" },
    });
    expect(requests[0]!.body).toMatchObject({ deviceId: "DEV-001", plotCode: "PLOT-1", metric: "soilMoisture", value: 42.5, unit: "%", recordedAt: "2026-11-19T00:00:00Z" });
  });

  it("回执消息转发到控制服务，复用设备回调凭证", async () => {
    const { broker, client, requests } = createHarness({ deviceToken: "device-secret" });
    broker.start();
    client.emit(
      "message",
      "agri/tenant-demo/DEV-001/receipt",
      Buffer.from(JSON.stringify({ commandId: "cmd-1", status: "ACKED", message: "已写入启停线圈" })),
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
    const { broker, client, requests, warnings } = createHarness();
    broker.start();
    client.emit("message", "agri/tenant-demo/DEV-001/receipt", Buffer.from(JSON.stringify({ commandId: "cmd-1" })));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
    expect(warnings.some((entry) => entry.message.includes("缺少"))).toBe(true);
  });

  it("publishCommand 下发到设备 command topic（QoS 1）", () => {
    const { broker, client } = createHarness();
    const queued = broker.publishCommand("DEV-001", { id: "cmd-1", type: "IRRIGATION", status: "SENT" });
    expect(queued).toBe(true);
    expect(client.published).toEqual([
      { topic: "agri/tenant-demo/DEV-001/command", payload: JSON.stringify({ id: "cmd-1", type: "IRRIGATION", status: "SENT" }), options: { qos: 1 } },
    ]);
  });

  it("publishCommand 设备号为空时不发布", () => {
    const { broker, client } = createHarness();
    expect(broker.publishCommand("  ", { id: "cmd-1" })).toBe(false);
    expect(client.published).toHaveLength(0);
  });

  it("payload 缺 deviceId 时用 topic 设备号兜底", async () => {
    const { broker, client, requests } = createHarness();
    broker.start();
    client.emit(
      "message",
      "agri/tenant-demo/DEV-FALLBACK/telemetry",
      Buffer.from(JSON.stringify({ metric: "soilMoisture", value: 12 })),
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body).toMatchObject({ deviceId: "DEV-FALLBACK", metric: "soilMoisture" });
  });

  it("遥测缺少 metric 的消息跳过且不发请求", async () => {
    const { broker, client, requests, warnings } = createHarness();
    broker.start();
    client.emit("message", "agri/tenant-demo/DEV-001/telemetry", Buffer.from(JSON.stringify({ deviceId: "DEV-001" })));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
    expect(warnings.some((entry) => entry.message.includes("缺少"))).toBe(true);
  });

  it("非法 JSON 跳过且不发请求", async () => {
    const { broker, client, requests, warnings } = createHarness();
    broker.start();
    client.emit("message", "agri/tenant-demo/DEV-001/telemetry", Buffer.from("not-json"));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(0);
    expect(warnings.some((entry) => entry.message.includes("处理失败"))).toBe(true);
  });

  it("上报返回非 2xx 时记录告警，不抛出", async () => {
    const fetchImpl = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const { broker, client, warnings } = createHarness({ fetchImpl });
    broker.start();
    client.emit(
      "message",
      "agri/tenant-demo/DEV-001/telemetry",
      Buffer.from(JSON.stringify({ deviceId: "DEV-001", metric: "soilMoisture", value: 1 })),
    );

    await vi.waitFor(() => expect(warnings.some((entry) => entry.message.includes("上报失败"))).toBe(true));
    expect(warnings.find((entry) => entry.message.includes("上报失败"))?.meta).toMatchObject({ topic: "agri/tenant-demo/DEV-001/telemetry", status: 401 });
  });

  it("stop 结束客户端连接", async () => {
    const { broker, client } = createHarness();
    await broker.stop();
    expect(client.ended).toBe(true);
  });
});
