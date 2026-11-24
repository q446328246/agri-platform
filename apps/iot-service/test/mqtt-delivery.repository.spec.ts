import { describe, expect, it } from "vitest";

import { InMemoryMqttDeliveryRepository } from "../src/mqtt-delivery.repository.js";

const inbound = () => ({
  direction: "INBOUND" as const,
  tenantId: "tenant-demo",
  deviceNo: "DEV-001",
  deviceId: "device-internal",
  topic: "agri/tenant-demo/DEV-001/telemetry",
  payload: { metric: "soilMoisture", value: 12 },
});

const outbound = (status = "QUEUED") => ({
  tenantId: "tenant-demo",
  deviceNo: "DEV-001",
  deviceId: "device-internal",
  topic: "agri/tenant-demo/DEV-001/command",
  payload: { id: "cmd-1", status },
});

describe("InMemoryMqttDeliveryRepository", () => {
  it("相同主题与载荷的正常报文各自投递，仅 QoS 重传按报文标识去重", async () => {
    const repository = new InMemoryMqttDeliveryRepository();
    const first = await repository.enqueueInbound(inbound(), { packetId: 7 });
    const repeatedReading = await repository.enqueueInbound(inbound(), { packetId: 8 });
    expect(repeatedReading.id).not.toBe(first.id);
    expect(await repository.due(Date.now(), 10)).toHaveLength(2);

    const retransmission = await repository.enqueueInbound(inbound(), { packetId: 7, duplicate: true });
    expect(retransmission.id).toBe(first.id);
    await repository.complete(first.id);
    expect((await repository.enqueueInbound(inbound(), { packetId: 7, duplicate: true })).status).toBe("DONE");
    expect((await repository.enqueueInbound(inbound(), { packetId: 7 })).status).toBe("PENDING");
  });

  it("失败后退避重试，不丢失 pending 记录", async () => {
    const repository = new InMemoryMqttDeliveryRepository();
    const delivery = await repository.enqueueInbound(inbound());
    const now = Date.parse(delivery.createdAt);
    await repository.fail(delivery.id, "upstream unavailable", now);
    expect(await repository.due(now + 1999, 10)).toEqual([]);
    const due = await repository.due(now + 2000, 10);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ attempts: 1, lastError: "upstream unavailable" });
  });

  it("出站记录在领取后更新为 SENT 载荷，确认发布后删除", async () => {
    const repository = new InMemoryMqttDeliveryRepository();
    await repository.enqueueOutbound(outbound());
    await repository.enqueueOutbound(outbound("SENT"));
    const due = await repository.due(Date.now(), 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.payload.status).toBe("SENT");
    await repository.complete(due[0]!.id);
    expect(await repository.due(Date.now(), 10)).toEqual([]);
  });

  it("指令缺少 id 时拒绝入队", async () => {
    const repository = new InMemoryMqttDeliveryRepository();
    await expect(repository.enqueueOutbound({ ...outbound(), payload: { status: "QUEUED" } })).rejects.toThrow("缺少 id");
  });

  it("仅清理已完成的过期入站记录", async () => {
    const repository = new InMemoryMqttDeliveryRepository();
    const old = await repository.enqueueInbound(inbound());
    const pending = await repository.enqueueInbound({
      ...inbound(),
      topic: "agri/tenant-demo/DEV-001/receipt",
      payload: { commandId: "cmd-1", status: "ACKED" },
    });
    await repository.complete(old.id);
    await repository.enqueueOutbound(outbound());
    const now = Date.now() + 86_400_001;
    await repository.cleanup(now, 10);
    expect((await repository.enqueueInbound(inbound())).status).toBe("PENDING");
    expect(await repository.due(now, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.id }),
      expect.objectContaining({ id: "out-cmd-1" }),
    ]));
  });
});
