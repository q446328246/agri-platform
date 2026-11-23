import { describe, expect, it, vi } from "vitest";

import { createMqttCommandRelay } from "../src/command-relay.js";
import { InMemoryDeviceRepository } from "../src/device.repository.js";
import type { Device } from "../src/device.repository.js";

/**
 * MQTT 指令中继（B2）行为验证：不连真 broker，也不起控制服务。
 *
 * `devices` 用内存台账，`fetchImpl` 换成按路径分发的假 HTTP，`publishCommand` 记录发布。
 * 断言的是「只轮 MQTT 设备、只领取 QUEUED、领取后发布一次、已领取的不重复发布、
 * 控制服务报错时走 onError 留痕不抛出」——中继接的是指令状态机，错了就是设备收不到指令，
 * 或同一指令被下发两遍。
 */

const BASE_DEVICE: Device = {
  id: "device-tractor-001",
  tenantId: "tenant-demo",
  deviceNo: "DZ-T-001",
  name: "一号拖拉机",
  type: "AUTO_TRACTOR",
  status: "ONLINE",
  plotCode: "P-1",
  protocol: "MQTT",
  lastSeenAt: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

const HTTP_DEVICE: Device = {
  ...BASE_DEVICE,
  id: "device-valve-001",
  deviceNo: "DZ-V-001",
  name: "一号灌溉阀",
  type: "IRRIGATION_VALVE",
  protocol: "HTTP",
};

interface PendingCommand {
  id: string;
  deviceId: string;
  plotCode: string;
  type: string;
  status: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

/** 按路径分发的假 HTTP：pending 返回给定指令集，dispatch 记下请求体，其余回错误 */
function makeFetch(pending: PendingCommand[], captured: CapturedRequest[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    captured.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    const path = url.split("?")[0] ?? "";
    if (path.endsWith("/control/device/pending")) {
      return new Response(JSON.stringify({ code: "OK", message: "", data: { items: pending } }), { status: 200 });
    }
    if (path.endsWith("/control/device/dispatch")) {
      return new Response(JSON.stringify({ code: "OK", message: "", data: { id: "" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "NOT_FOUND", message: "无此接口", data: null }), { status: 404 });
  };
}

const QUEUED_COMMAND: PendingCommand = {
  id: "cmd-1",
  deviceId: BASE_DEVICE.id,
  plotCode: "P-1",
  type: "IRRIGATION",
  status: "QUEUED",
  parameters: { zones: [] },
  createdAt: "2026-11-20T00:00:00.000Z",
};

describe("MQTT 指令中继（B2）", () => {
  it("按 MQTT 设备轮询 pending，QUEUED 指令领取后发布一次，已领取的不重复发布", async () => {
    const captured: CapturedRequest[] = [];
    const publishCommand = vi.fn();
    const relay = createMqttCommandRelay({
      devices: new InMemoryDeviceRepository([BASE_DEVICE, HTTP_DEVICE]),
      controlUrl: "http://control.test",
      tenantId: "tenant-demo",
      publishCommand,
      fetchImpl: makeFetch(
        [QUEUED_COMMAND, { ...QUEUED_COMMAND, id: "cmd-2", status: "SENT" }],
        captured,
      ),
    });

    await relay.tick();

    // 只轮 MQTT 设备：HTTP 回调设备不在中继的服务范围
    expect(captured.filter((item) => item.url.includes("pending"))).toHaveLength(1);
    expect(captured.find((item) => item.url.includes("pending"))?.url).toContain("deviceId=device-tractor-001");
    // 只有 QUEUED 的被领取，SENT 的不再领
    expect(captured.find((item) => item.method === "POST")?.body).toEqual({ commandId: "cmd-1" });
    // 发布用设备编号，载荷是整条指令
    expect(publishCommand).toHaveBeenCalledTimes(1);
    expect(publishCommand.mock.calls[0]?.[0]).toBe("DZ-T-001");
    expect(publishCommand.mock.calls[0]?.[1]).toMatchObject({ id: "cmd-1", status: "QUEUED", deviceId: BASE_DEVICE.id });
  });

  it("没有 MQTT 设备时不轮询控制服务", async () => {
    const captured: CapturedRequest[] = [];
    const relay = createMqttCommandRelay({
      devices: new InMemoryDeviceRepository([HTTP_DEVICE]),
      controlUrl: "http://control.test",
      tenantId: "tenant-demo",
      publishCommand: vi.fn(),
      fetchImpl: makeFetch([], captured),
    });

    await relay.tick();

    expect(captured).toHaveLength(0);
  });

  it("控制服务报错时走 onError 留痕，不中断整轮", async () => {
    const onError = vi.fn();
    const relay = createMqttCommandRelay({
      devices: new InMemoryDeviceRepository([BASE_DEVICE]),
      controlUrl: "http://control.test",
      tenantId: "tenant-demo",
      publishCommand: vi.fn(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "ERR", message: "控制服务不可用", data: null }), { status: 503 }),
      onError,
    });

    await expect(relay.tick()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("DZ-T-001");
  });
});
