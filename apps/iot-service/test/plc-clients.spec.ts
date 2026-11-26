import { describe, expect, it } from "vitest";

import { DataType, DataValue, UserTokenType } from "node-opcua";

import { MitsubishiMcPlcClient, OpcUaPlcClient, PlcModbusClient, SiemensS7PlcClient, plcMeterFor } from "../src/plc-clients.js";
import type { CallbackPlcTransport } from "../src/plc-clients.js";
import type { MitsubishiMcConfig, OpcUaConfig, PlcModbusConfig, SiemensS7Config } from "../src/plc-binding.js";

class FakeCallbackTransport implements CallbackPlcTransport {
  options: Record<string, unknown> | undefined;
  values: Record<string, unknown> = {};
  added: string[][] = [];
  removed: string[][] = [];
  writes: Array<{ point: string; value: unknown }> = [];
  closed = false;

  initiateConnection(options: Record<string, unknown>, callback: (error?: unknown) => void): void {
    this.options = options;
    callback();
  }

  dropConnection(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }

  setTranslationCB(): void {}

  addItems(items: string | string[]): void {
    this.added.push(typeof items === "string" ? [items] : items);
  }

  removeItems(items?: string | string[]): void {
    this.removed.push(typeof items === "string" ? [items] : items ?? []);
  }

  writeItems(items: string | string[], values: unknown, callback: (anythingBad: unknown) => void): void {
    this.writes.push({ point: String(items), value: values });
    callback(undefined);
  }

  readAllItems(callback: (anythingBad: unknown, values: Record<string, unknown>) => void): void {
    callback(undefined, this.values);
  }
}

const modbus: PlcModbusConfig = {
  driverId: "PLC_MODBUS_TCP_GATEWAY",
  host: "plc.test",
  port: 502,
  unitId: 1,
  timeoutMs: 1000,
  profile: "PLC_MODBUS_TCP_WATER_M3",
  switchPoint: 10,
  runFeedbackPoint: 11,
  faultPoint: 12,
  meterPoint: 20,
};

const s7: SiemensS7Config = {
  driverId: "SIEMENS_S7_DRIVER",
  host: "s7.test",
  port: 102,
  rack: 0,
  slot: 1,
  timeoutMs: 1000,
  profile: "SIEMENS_S7_WATER_M3",
  switchPoint: "DB1,X0.0",
  runFeedbackPoint: "DB1,X0.1",
  faultPoint: "DB1,X0.2",
  meterPoint: "DB1,INT0",
};

const mc: MitsubishiMcConfig = {
  driverId: "MITSUBISHI_MC_DRIVER",
  host: "mc.test",
  port: 1281,
  ascii: true,
  timeoutMs: 1000,
  profile: "MITSUBISHI_MC_WATER_M3",
  switchPoint: "M0",
  runFeedbackPoint: "M1",
  faultPoint: "M2",
  meterPoint: "D0",
};

describe("PLC 协议客户端", () => {
  it("PLC Modbus 用线圈和离散输入读写布尔点位，用两个保持寄存器计量", async () => {
    const calls: string[] = [];
    const client = new PlcModbusClient({
      writeCoil: async (point, value) => { calls.push(`coil:${point}:${value}`); },
      readDiscreteInputs: async (point) => { calls.push(`input:${point}`); return [true]; },
      readHoldingRegisters: async (point) => { calls.push(`register:${point}`); return [1, 2]; },
      close: async () => {},
    });
    const meter = plcMeterFor(modbus)!;

    await client.writeBoolean(10, true);
    expect(await client.readBoolean(11)).toBe(true);
    expect(await client.readMeter(20, meter)).toBe(0x10002 * meter.scale);
    expect(calls).toEqual(["coil:10:true", "input:11", "register:20"]);
  });

  it("S7 将平台 INT 字索引转换为 nodes7 字节偏移，并按字序拼接 UINT32", async () => {
    const transport = new FakeCallbackTransport();
    const config = { ...s7, meterPoint: "DB1,INT4" };
    transport.values = { "DB1,INT8": 1, "DB1,INT10": 2 };
    const client = new SiemensS7PlcClient(config, () => transport);
    await client.connect();
    const meter = plcMeterFor(config)!;

    expect(await client.readMeter(config.meterPoint, meter)).toBe(0x10002 * meter.scale);
    expect(await client.readMeter(config.meterPoint, { ...meter, wordOrder: "LOW_FIRST" })).toBe(0x20001 * meter.scale);
    expect(transport.options).toEqual({ host: "s7.test", port: 102, rack: 0, slot: 1 });
    expect(transport.added.slice(-2)).toEqual([["DB1,INT8"], ["DB1,INT10"]]);
    await client.close();
    expect(transport.closed).toBe(true);
  });

  it("三菱 MC 保留帧格式并自动读取相邻 D 字", async () => {
    const transport = new FakeCallbackTransport();
    transport.values = { D0: 1, D1: 2 };
    const client = new MitsubishiMcPlcClient(mc, () => transport);
    await client.connect();
    const meter = plcMeterFor(mc)!;

    expect(await client.readMeter(mc.meterPoint, meter)).toBe(0x10002 * meter.scale);
    expect(transport.options).toEqual({ host: "mc.test", port: 1281, ascii: true });
    expect(transport.added.at(-1)).toEqual(["D0", "D1"]);
    await client.close();
    expect(transport.closed).toBe(true);
  });

  it("OPC UA 使用数组读写并检查服务端状态码", async () => {
    const calls: Array<{ method: string; fields: Array<Record<string, unknown>> }> = [];
    const identities: unknown[] = [];
    const session = {
      close: async () => {},
      write: async (fields: Array<Record<string, unknown>>) => {
        calls.push({ method: "write", fields });
        return [{ isGood: () => true, name: "Good" }];
      },
      read: async (fields: Array<Record<string, unknown>>) => {
        calls.push({ method: "read", fields });
        return [{ statusCode: { isGood: () => true, name: "Good" }, value: { value: true } }];
      },
    };
    const transport = {
      connect: async () => {},
      disconnect: async () => {},
      createSession: async (identity: unknown) => { identities.push(identity); return session; },
    };
    const config: OpcUaConfig = {
      driverId: "OPC_UA_CLIENT",
      endpointUrl: "opc.tcp://opc.test:4840",
      timeoutMs: 1000,
      authMode: "ANONYMOUS",
      profile: "OPC_UA_SWITCH_ONLY",
      switchPoint: "ns=2;i=1001",
      runFeedbackPoint: "ns=2;i=1002",
      faultPoint: "ns=2;i=1003",
    };
    const client = new OpcUaPlcClient(config, () => transport as never);
    await client.connect();

    await client.writeBoolean(config.switchPoint, false);
    expect(await client.readBoolean(config.runFeedbackPoint)).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["write", "read"]);
    expect(calls[0]?.fields[0]?.nodeId).toBe(config.switchPoint);
    const written = calls[0]?.fields[0]?.value as DataValue;
    expect(written).toBeInstanceOf(DataValue);
    expect(written.value.dataType).toBe(DataType.Boolean);
    expect(written.value.value).toBe(false);
    expect(identities).toEqual([{ type: UserTokenType.Anonymous }]);
  });
});
