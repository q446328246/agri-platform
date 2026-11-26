import type { ClientSession } from "node-opcua";
import { AttributeIds, DataType, DataValue, MessageSecurityMode, OPCUAClient, SecurityPolicy, UserTokenType, Variant } from "node-opcua";
import McProtocol from "mcprotocol";
import NodeS7 from "nodes7";

import { ModbusTcpClient } from "./modbus-tcp.js";
import type { MqttConfigCipher } from "./mqtt-config.js";
import type {
  MitsubishiMcConfig,
  OpcUaConfig,
  PlcDeviceConfig,
  PlcMeter,
  PlcModbusConfig,
  PlcPoint,
  SiemensS7Config,
} from "./plc-binding.js";
import { getPlcProfile } from "./plc-binding.js";

export interface PlcClientLike {
  writeBoolean(point: PlcPoint, value: boolean): Promise<void>;
  readBoolean(point: PlcPoint): Promise<boolean>;
  readMeter(point: PlcPoint, meter: PlcMeter): Promise<number>;
  close(): Promise<void>;
}

export interface CallbackPlcTransport {
  initiateConnection(options: Record<string, unknown>, callback: (error?: unknown) => void): void;
  dropConnection(callback?: () => void): void;
  setTranslationCB(callback: (tag: string) => string): void;
  addItems(items: string | string[]): void;
  removeItems(items?: string | string[]): void;
  writeItems(items: string | string[], values: unknown, callback: (anythingBad: unknown) => void): number | void;
  readAllItems(callback: (anythingBad: unknown, values: Record<string, unknown>) => void): void;
}

abstract class CallbackPlcClient implements PlcClientLike {
  protected readonly transport: CallbackPlcTransport;
  private readonly timeoutMs: number;

  protected constructor(transport: CallbackPlcTransport, timeoutMs: number) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.transport.setTranslationCB((tag) => tag);
  }

  async connect(): Promise<void> {
    await this.call<void>((callback) => this.transport.initiateConnection(this.connectionOptions(), callback));
  }

  protected abstract connectionOptions(): Record<string, unknown>;

  async writeBoolean(point: PlcPoint, value: boolean): Promise<void> {
    await this.call<void>((callback) => this.transport.writeItems(String(point), value, callback));
  }

  async readBoolean(point: PlcPoint): Promise<boolean> {
    const value = await this.readValue(point);
    if (typeof value !== "boolean") throw new Error("PLC boolean point did not return a boolean");
    return value;
  }

  async readMeter(point: PlcPoint, meter: PlcMeter): Promise<number> {
    const value = await this.readValue(point);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("PLC meter point did not return a finite number");
    }
    return value * meter.scale;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.transport.dropConnection(() => resolve()));
  }

  protected async readValue(point: PlcPoint): Promise<unknown> {
    const [value] = await this.readValues([point]);
    return value;
  }

  protected async readValues(points: PlcPoint[]): Promise<unknown[]> {
    const tags = points.map(String);
    this.transport.addItems(tags);
    try {
      const values = await this.call<Record<string, unknown>>((callback) => this.transport.readAllItems(callback));
      return tags.map((tag) => values[tag]);
    } finally {
      this.transport.removeItems(tags);
    }
  }

  private call<T>(invoke: (callback: (error?: unknown, value?: T) => void) => unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PLC driver response timed out")), this.timeoutMs);
      const finish = (error?: unknown, value?: T): void => {
        clearTimeout(timer);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(value as T);
      };
      try {
        const queued = invoke(finish);
        if (queued === 1) finish(new Error("PLC driver write queue is full"));
      } catch (error) {
        finish(error);
      }
    });
  }
}

export class PlcModbusClient implements PlcClientLike {
  constructor(
    private readonly transport: Pick<ModbusTcpClient, "writeCoil" | "readDiscreteInputs" | "readHoldingRegisters" | "close">,
  ) {}

  async writeBoolean(point: PlcPoint, value: boolean): Promise<void> {
    await this.transport.writeCoil(Number(point), value);
  }

  async readBoolean(point: PlcPoint): Promise<boolean> {
    const bits = await this.transport.readDiscreteInputs(Number(point), 1);
    const value = bits[0];
    if (value === undefined) throw new Error("PLC driver returned no discrete input");
    return Boolean(value);
  }

  async readMeter(point: PlcPoint, meter: PlcMeter): Promise<number> {
    const register = Number(point);
    const [first, second] = await this.transport.readHoldingRegisters(register, 2);
    if (first === undefined || second === undefined) throw new Error("PLC meter returned fewer than two registers");
    const wordOrder = meter.wordOrder === "HIGH_FIRST" ? [first, second] : [second, first];
    let value: number;
    if (meter.dataType === "REAL") {
      const buffer = Buffer.alloc(4);
      wordOrder.forEach((word, index) => buffer.writeUInt16BE(word, index * 2));
      value = buffer.readFloatBE(0);
    } else {
      value = wordOrder[0]! * 0x10000 + wordOrder[1]!;
    }
    return value * meter.scale;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

export class SiemensS7PlcClient extends CallbackPlcClient {
  constructor(
    private readonly config: SiemensS7Config,
    factory: () => CallbackPlcTransport = () => new NodeS7() as unknown as CallbackPlcTransport,
  ) {
    super(factory(), config.timeoutMs);
  }

  protected connectionOptions(): Record<string, unknown> {
    return { host: this.config.host, port: this.config.port, rack: this.config.rack, slot: this.config.slot };
  }

  override async readMeter(point: PlcPoint, meter: PlcMeter): Promise<number> {
    if (meter.dataType === "REAL") return super.readMeter(point, meter);
    const match = /^(DB\d+|M),INT(\d+)$/.exec(String(point));
    if (!match) throw new Error("Siemens S7 UINT32 meter requires an INT word address");
    // nodes7 将 INT 后缀按字节偏移解析，平台点位按 16 位字索引。
    const byteOffset = Number(match[2]) * 2;
    const values = [
      await this.readValue(`${match[1]},INT${byteOffset}`),
      await this.readValue(`${match[1]},INT${byteOffset + 2}`),
    ];
    const words = values.map((value) => {
      if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Siemens S7 meter word is not an integer");
      return value & 0xffff;
    });
    const ordered = meter.wordOrder === "HIGH_FIRST" ? words : words.reverse();
    return (ordered[0]! * 0x10000 + ordered[1]!) * meter.scale;
  }
}

export class MitsubishiMcPlcClient extends CallbackPlcClient {
  constructor(
    private readonly config: MitsubishiMcConfig,
    factory: () => CallbackPlcTransport = () => new McProtocol() as unknown as CallbackPlcTransport,
  ) {
    super(factory(), config.timeoutMs);
  }

  protected connectionOptions(): Record<string, unknown> {
    return { host: this.config.host, port: this.config.port, ascii: this.config.ascii };
  }

  override async close(): Promise<void> {
    this.transport.dropConnection();
  }

  override async readMeter(point: PlcPoint, meter: PlcMeter): Promise<number> {
    if (meter.dataType === "REAL") return super.readMeter(point, meter);
    const match = /^([DR])(\d+)$/.exec(String(point));
    if (!match) throw new Error("Mitsubishi MC UINT32 meter requires a D/R word address");
    const values = await this.readValues([point, `${match[1]}${Number(match[2]) + 1}`]);
    const words = values.map((value) => {
      if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Mitsubishi MC meter word is not an integer");
      return value & 0xffff;
    });
    const ordered = meter.wordOrder === "HIGH_FIRST" ? words : words.reverse();
    return (ordered[0]! * 0x10000 + ordered[1]!) * meter.scale;
  }
}

type OpcUaTransport = Pick<OPCUAClient, "connect" | "disconnect" | "createSession">;
type OpcUaRuntimeConfig = Omit<OpcUaConfig, "passwordCiphertext"> & { password?: string };

export class OpcUaPlcClient implements PlcClientLike {
  private readonly client: OpcUaTransport;
  private session: ClientSession | null = null;

  constructor(
    private readonly config: OpcUaRuntimeConfig,
    private readonly factory: () => OpcUaTransport = () => OPCUAClient.create({
      connectionStrategy: { maxRetry: 0 },
      requestedSessionTimeout: config.timeoutMs,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      endpointMustExist: false,
    }),
  ) {
    this.client = factory();
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect(this.config.endpointUrl);
      this.session = await createOpcUaSession(this.client, this.config);
    } catch (error) {
      await this.client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async writeBoolean(point: PlcPoint, value: boolean): Promise<void> {
    const statuses = await this.sessionValue().write([{
      nodeId: String(point),
      attributeId: AttributeIds.Value,
      value: new DataValue({ value: new Variant({ dataType: DataType.Boolean, value }) }),
    }]);
    const failed = statuses.find((status) => !status.isGood());
    if (failed) throw new Error(`OPC UA write failed: ${failed.name}`);
  }

  async readBoolean(point: PlcPoint): Promise<boolean> {
    const value = await this.readValue(point);
    if (typeof value !== "boolean") throw new Error("OPC UA boolean point did not return a boolean");
    return value;
  }

  async readMeter(point: PlcPoint, meter: PlcMeter): Promise<number> {
    const value = await this.readValue(point);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("OPC UA meter point did not return a finite number");
    }
    return value * meter.scale;
  }

  async close(): Promise<void> {
    try {
      await this.session?.close();
    } finally {
      this.session = null;
      await this.client.disconnect();
    }
  }

  private async readValue(point: PlcPoint): Promise<unknown> {
    const [result] = await this.sessionValue().read([{ nodeId: String(point), attributeId: AttributeIds.Value }]);
    if (!result) throw new Error("OPC UA read returned no value");
    if (!result.statusCode.isGood()) throw new Error(`OPC UA read failed: ${result.statusCode.name}`);
    return result.value.value;
  }

  private sessionValue(): ClientSession {
    if (!this.session) throw new Error("OPC UA session is not connected");
    return this.session;
  }
}

async function createOpcUaSession(client: OpcUaTransport, config: OpcUaRuntimeConfig): Promise<ClientSession> {
  return client.createSession(
    config.authMode === "ANONYMOUS"
      ? { type: UserTokenType.Anonymous }
      : { type: UserTokenType.UserName, userName: config.username ?? "", password: config.password ?? "" },
  );
}

export async function createPlcClient(config: PlcDeviceConfig, cipher?: MqttConfigCipher): Promise<PlcClientLike> {
  if (config.driverId === "PLC_MODBUS_TCP_GATEWAY") {
    const client = new ModbusTcpClient({ host: config.host, port: config.port, unitId: config.unitId, timeoutMs: config.timeoutMs });
    return new PlcModbusClient(client);
  }
  if (config.driverId === "SIEMENS_S7_DRIVER") {
    const client = new SiemensS7PlcClient(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
  if (config.driverId === "MITSUBISHI_MC_DRIVER") {
    const client = new MitsubishiMcPlcClient(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
  if (config.authMode === "ANONYMOUS") {
    const base = { ...config };
    delete base.passwordCiphertext;
    const client = new OpcUaPlcClient(base);
    await client.connect();
    return client;
  }
  if (!config.passwordCiphertext || !cipher) {
    throw new Error("OPC UA encrypted password requires the configuration cipher");
  }
  const { passwordCiphertext, ...base } = config;
  const client = new OpcUaPlcClient({ ...base, password: cipher.decrypt(passwordCiphertext) });
  await client.connect();
  return client;
}

export function plcMeterFor(config: PlcDeviceConfig): PlcMeter | null {
  const protocol =
    config.driverId === "PLC_MODBUS_TCP_GATEWAY"
      ? "PLC_MODBUS_TCP"
      : config.driverId === "SIEMENS_S7_DRIVER"
        ? "SIEMENS_S7"
        : config.driverId === "MITSUBISHI_MC_DRIVER"
          ? "MITSUBISHI_MC"
          : "OPC_UA";
  return getPlcProfile(protocol, config.profile).meter;
}
