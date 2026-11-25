import { describe, expect, it, vi } from "vitest";

import { createMqttCommandRelay } from "../src/command-relay.js";
import { InMemoryDeviceRepository } from "../src/device.repository.js";
import { InMemoryMqttDeliveryRepository } from "../src/mqtt-delivery.repository.js";
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
  driverId: "MQTT_DIRECT",
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
  driverId: "HTTP_CALLBACK",
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
      const request = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const command = pending.find((item) => item.id === request.commandId) ?? { ...QUEUED_COMMAND, id: String(request.commandId) };
      return new Response(JSON.stringify({ code: "OK", message: "", data: { ...command, status: "SENT", dispatchable: true } }), { status: 200 });
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
    const publishCommand = vi.fn(async () => true);
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
    expect(captured.find((item) => item.method === "POST")?.body).toEqual({ commandId: "cmd-1", deviceId: BASE_DEVICE.id, requireQueued: true });
    // 发布用设备编号，载荷是领取后的整条指令，不夹带内部控制标记
    expect(publishCommand).toHaveBeenCalledTimes(1);
    expect(publishCommand.mock.calls[0]?.[0]).toBe("DZ-T-001");
    expect(publishCommand.mock.calls[0]?.[1]).toMatchObject({ id: "cmd-1", status: "SENT", deviceId: BASE_DEVICE.id });
    expect(publishCommand.mock.calls[0]?.[1]).not.toHaveProperty("dispatchable");
  });

  it("发布未确认时保留出站记录，退避后重新领取并发布", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-24T00:00:00.000Z"));
      const deliveries = new InMemoryMqttDeliveryRepository();
      await deliveries.enqueueOutbound({
        tenantId: "tenant-demo",
        deviceNo: BASE_DEVICE.deviceNo,
        deviceId: BASE_DEVICE.id,
        topic: "agri/tenant-demo/DZ-T-001/command",
        payload: QUEUED_COMMAND,
      });
      const publishCommand = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const relay = createMqttCommandRelay({
        devices: new InMemoryDeviceRepository([BASE_DEVICE]),
        deliveries,
        controlUrl: "http://control.test",
        tenantId: "tenant-demo",
        publishCommand,
        fetchImpl: makeFetch([], []),
      });

      await relay.tick();
      expect(publishCommand).toHaveBeenCalledTimes(1);
      expect(await deliveries.due(Date.now() + 2000, 10)).toHaveLength(1);
      vi.setSystemTime(new Date("2026-11-24T00:00:02.100Z"));
      await relay.tick();
      expect(publishCommand).toHaveBeenCalledTimes(2);
      expect(await deliveries.due(Date.now(), 10)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatch 成功后、发布前崩溃可从 QUEUED 出站记录补发最新 SENT 载荷", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-24T00:00:00.000Z"));
      const deliveries = new InMemoryMqttDeliveryRepository();
      await deliveries.enqueueOutbound({
        tenantId: "tenant-demo", deviceNo: BASE_DEVICE.deviceNo, deviceId: BASE_DEVICE.id,
        topic: "agri/tenant-demo/DZ-T-001/command", payload: QUEUED_COMMAND,
      });
      const enqueue = deliveries.enqueueOutbound.bind(deliveries);
      let enqueueCalls = 0;
      let crash = true;
      const enqueueSpy = vi.spyOn(deliveries, "enqueueOutbound").mockImplementation(async (input) => {
        enqueueCalls += 1;
        if (enqueueCalls === 2 && crash) {
          crash = false;
          throw new Error("模拟二次落队前进程崩溃");
        }
        return enqueue(input);
      });
      const captured: CapturedRequest[] = [];
      const publishCommand = vi.fn(async () => true);
      const relay = createMqttCommandRelay({
        devices: new InMemoryDeviceRepository([BASE_DEVICE]), deliveries,
        controlUrl: "http://control.test", tenantId: "tenant-demo", publishCommand,
        fetchImpl: async (input, init) => {
          const url = String(input);
          captured.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
          if (url.includes("/dispatch")) {
            return new Response(JSON.stringify({ code: "OK", message: "", data: { ...QUEUED_COMMAND, status: "SENT", dispatchable: true } }), { status: 200 });
          }
          return new Response(JSON.stringify({ code: "OK", message: "", data: { items: [] } }), { status: 200 });
        },
      });

      await relay.tick();
      expect(captured.filter((item) => item.url.includes("/dispatch"))).toHaveLength(1);
      expect(publishCommand).not.toHaveBeenCalled();
      vi.setSystemTime(new Date("2026-11-24T00:00:02.100Z"));
      await relay.tick();
      expect(captured.filter((item) => item.url.includes("/dispatch"))).toHaveLength(2);
      expect(publishCommand).toHaveBeenCalledTimes(1);
      expect(publishCommand.mock.calls[0]?.[1]).toMatchObject({ id: "cmd-1", status: "SENT" });
      expect(await deliveries.due(Date.now(), 10)).toEqual([]);
      enqueueSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("恢复时遇到终态指令只清理出站记录，不再发布", async () => {
    const deliveries = new InMemoryMqttDeliveryRepository();
    await deliveries.enqueueOutbound({
      tenantId: "tenant-demo",
      deviceNo: BASE_DEVICE.deviceNo,
      deviceId: BASE_DEVICE.id,
      topic: "agri/tenant-demo/DZ-T-001/command",
      payload: { ...QUEUED_COMMAND, status: "DONE" },
    });
    const publishCommand = vi.fn(async () => true);
    const relay = createMqttCommandRelay({
      devices: new InMemoryDeviceRepository([BASE_DEVICE]),
      deliveries,
      controlUrl: "http://control.test",
      tenantId: "tenant-demo",
      publishCommand,
      fetchImpl: async (input) => String(input).includes("/dispatch")
        ? new Response(JSON.stringify({ code: "OK", message: "", data: { ...QUEUED_COMMAND, status: "DONE", dispatchable: false } }), { status: 200 })
        : new Response(JSON.stringify({ code: "OK", message: "", data: { items: [] } }), { status: 200 }),
    });

    await relay.tick();
    expect(publishCommand).not.toHaveBeenCalled();
    expect(await deliveries.due(Date.now(), 10)).toEqual([]);
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
