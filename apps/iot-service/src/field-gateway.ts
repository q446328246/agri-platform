import { isJobCommandType } from "@agri/contracts";
import { fieldGatewayProtocols, getModbusProfile, isPlcProtocol, readModbusBinding } from "./device-binding.js";
import type { ModbusBinding } from "./device-binding.js";
import { ModbusTcpClient, combineUint32 } from "./modbus-tcp.js";
import { DEFAULT_TENANT } from "./device.repository.js";
import type { Device, DeviceRepository } from "./device.repository.js";
import type { MqttConfigCipher } from "./mqtt-config.js";
import { createPlcClient, plcMeterFor } from "./plc-clients.js";
import type { PlcClientLike } from "./plc-clients.js";
import { getPlcProfile, readPlcConfig } from "./plc-binding.js";
import type { PlcDeviceConfig, PlcMeter, PlcPoint } from "./plc-binding.js";

/**
 * 现场协议网关：把控制指令落到 Modbus TCP 的执行机构上。
 *
 * 平台原本只有一条下发路——指令躺在 control-service 的队列里，等设备自己回调
 * `/device/dispatch` 与 `/device/receipt`。泵、阀、水肥机这些真正在执行动作的从站不会回调：
 * Modbus 里主站问、从站答，从站永远不主动说话。所以这一侧必须由平台开口：
 * 网关按设备轮询 `/device/pending`，领到指令后写线圈，再回读运行/故障反馈把状态推到底。
 *
 * 状态机仍然是唯一的账本：网关只是又一个回执方，走的是与设备回调完全相同的两个接口，
 * 因此人工回填、超时收口、结单事件都不需要为它改口径。
 *
 * 「开多久」只认指令里已有的权威数值，不猜：
 * - 水肥指令在入队时带上由分区参数现算的 `parameters.plan`（时长 + 计划水量）；
 * - 其它指令可显式给 `parameters.durationMin`；
 * - 两个都没有就不碰硬件，直接 FAILED 说清原因——把阀门开到一个没人规定的时刻再收，
 *   比拒绝执行更危险。
 * 计量口径：有累计寄存器时按计划水量提前收口，且回执上报**作业期间的增量**而非表计读数；
 * 网关重启后拿不到基线，就只报时长，水量留给控制侧按方案回退，不拿累计读数冒充用量。
 */

/** 保留旧常量供既有调用方判断；实际网关按驱动目录扫描全部现场协议 */
export const FIELD_GATEWAY_PROTOCOL = "MODBUS_TCP";

/** control-service 缺省地址，与网关服务的 `CONTROL_SERVICE_URL` 同一口径 */
export const DEFAULT_CONTROL_BASE_URL = "http://127.0.0.1:3008";

/** 轮询间隔缺省值：现场阀门动作以分钟计，五秒一轮足够跟上，又不会把从站问爆 */
export const DEFAULT_FIELD_GATEWAY_INTERVAL_MS = 5_000;

/** 回执 result 里作业量的键名按计量单位取，灌溉的立方米正是下游要的那个字段 */
const METER_RESULT_KEY: Record<PlcMeter["unit"], string> = {
  "m³": "waterVolumeM3",
  // 剖面量出的是出液升数；投肥量（千克）需要料液密度，平台没有这个权威值，因此不换算成 kg
  L: "fertilizerLiters",
};

/** 指令的最小可读形状（control-service 的 CommandView 在本服务里只用到这些字段） */
export interface FieldCommand {
  id: string;
  deviceId: string;
  type: string;
  status: "QUEUED" | "SENT" | "ACKED" | "DONE" | "FAILED";
  /** 归属地块，电子围栏（B4）据此校验设备绑定地块与指令地块一致 */
  plotCode?: string;
  parameters: Record<string, unknown>;
  sentAt?: string;
  ackedAt?: string;
  createdAt: string;
}

/** 网关判一次作业何时收口所需的执行包络 */
interface JobSpec {
  /** 时长上限（分钟），到时即关阀收口 */
  durationMin?: number;
  /** 计划作业量（与剖面计量单位同量纲），先于时长达成即收口 */
  targetVolume?: number;
  /** 急停：不看计划量也不看时长，只等「停到位」 */
  stopOnly: boolean;
}

export interface FieldGatewayOptions {
  devices: DeviceRepository;
  /** 台账租户，与设备服务同一个进程配置 */
  tenantId?: string;
  controlBaseUrl?: string;
  /** 设备回调共享凭证（DEVICE_CALLBACK_TOKEN）；未配置时按 control-service 的用户身份通道放行 */
  deviceToken?: string;
  intervalMs?: number;
  /** HTTP 注入点，测试用；缺省取全局 fetch */
  fetchImpl?: typeof fetch;
  /** Modbus 客户端注入点，测试用 */
  clientFor?: (device: Device, binding: ModbusBinding) => ModbusClientLike;
  /** PLC 客户端注入点，测试用；缺省按设备连接配置建立真实协议连接 */
  plcClientFor?: (device: Device, config: PlcDeviceConfig) => PlcClientLike | Promise<PlcClientLike>;
  /** MQTT 配置加密器，同时用于解密 PLC 的 OPC UA 登录密码 */
  configCipher?: MqttConfigCipher;
  /** 单条指令执行失败的回调，缺省只在控制台留一行；不影响其它设备与其它指令 */
  onError?: (device: Device, command: FieldCommand, error: Error) => void;
  now?: () => number;
  /** MQTT 指令下发（A2）：领取指令后向设备 command topic 补发一条，与 Modbus 线圈下发并存；缺省不发 */
  publishCommand?: ((deviceNo: string, command: unknown) => void) | undefined;
}

/** 网关用到的 Modbus 主站能力，`ModbusTcpClient` 的子集，便于测试替身 */
export interface ModbusClientLike {
  readDiscreteInputs(address: number, quantity: number): Promise<boolean[]>;
  readHoldingRegisters(address: number, quantity: number): Promise<number[]>;
  writeCoil(address: number, on: boolean): Promise<void>;
  close(): Promise<void>;
}

interface FieldProfile {
  switchPoint: PlcPoint;
  switchLabel: string;
  runFeedbackPoint: PlcPoint;
  faultPoint: PlcPoint;
  faultLabel: string;
  meter: (PlcMeter & { point: PlcPoint }) | null;
}

interface FieldClientLike {
  writeBoolean(point: PlcPoint, value: boolean): Promise<void>;
  readBoolean(point: PlcPoint): Promise<boolean>;
  readMeter(point: PlcPoint, meter: PlcMeter): Promise<number>;
  close(): Promise<void>;
}

class ModbusFieldClient implements FieldClientLike {
  constructor(private readonly client: ModbusClientLike) {}

  async writeBoolean(point: PlcPoint, value: boolean): Promise<void> {
    await this.client.writeCoil(Number(point), value);
  }

  async readBoolean(point: PlcPoint): Promise<boolean> {
    const bits = await this.client.readDiscreteInputs(Number(point), 1);
    return bits[0] ?? false;
  }

  async readMeter(point: PlcPoint, meter: PlcMeter): Promise<number> {
    const words = await this.client.readHoldingRegisters(Number(point), 2);
    const high = meter.wordOrder === "HIGH_FIRST" ? (words[0] ?? 0) : (words[1] ?? 0);
    const low = meter.wordOrder === "HIGH_FIRST" ? (words[1] ?? 0) : (words[0] ?? 0);
    return combineUint32(high, low) * meter.scale;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class PlcFieldClient implements FieldClientLike {
  constructor(private readonly client: PlcClientLike) {}

  writeBoolean(point: PlcPoint, value: boolean): Promise<void> {
    return this.client.writeBoolean(point, value);
  }

  readBoolean(point: PlcPoint): Promise<boolean> {
    return this.client.readBoolean(point);
  }

  readMeter(point: PlcPoint, meter: PlcMeter): Promise<number> {
    return this.client.readMeter(point, meter);
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/** 已写入但尚未结单的作业现场，只存在网关进程内；丢失后按「无基线」继续收口 */
interface JobState {
  startedAtMs: number;
  /** 写入时刻的累计计数原始值，null 表示这台设备没有计量或网关重启后没赶上取基线 */
  baselineCounts: number | null;
}

interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

/** control-service 设备通道的最小客户端：只认队列、领取、回执三件事 */
class ControlChannel {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly tenantId: string,
    deviceToken: string | undefined,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.headers = { "content-type": "application/json", "x-tenant-id": tenantId, ...(deviceToken ? { "x-device-token": deviceToken } : {}) };
  }

  private readonly headers: Record<string, string>;

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    const response = await this.fetchImpl(url, { method, headers: this.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || !payload || payload.code !== "OK") {
      throw new Error(`控制服务 ${path} 失败：${response.status} ${payload?.message ?? "无响应体"}`);
    }
    return payload.data;
  }

  async pending(deviceId: string): Promise<FieldCommand[]> {
    const page = await this.call<{ items: FieldCommand[] }>("GET", `/api/v1/control/device/pending?deviceId=${encodeURIComponent(deviceId)}`);
    return page.items;
  }

  dispatch(commandId: string): Promise<unknown> {
    return this.call("POST", "/api/v1/control/device/dispatch", { commandId });
  }

  receipt(commandId: string, status: "ACKED" | "DONE" | "FAILED", message: string, result?: Record<string, unknown>): Promise<unknown> {
    return this.call("POST", "/api/v1/control/device/receipt", {
      commandId,
      status,
      message,
      ...(result === undefined ? {} : { result }),
    });
  }
}

/** 从指令参数里取执行包络；算不出收口条件时返回 undefined，调用方据此拒绝动硬件 */
function jobSpecOf(command: FieldCommand): JobSpec | undefined {
  if (command.type === "ESTOP" || command.type === "POWER_OFF") return { stopOnly: true };
  const parameters = command.parameters ?? {};
  const plan = parameters.plan;
  const planRecord = plan && typeof plan === "object" && !Array.isArray(plan) ? (plan as Record<string, unknown>) : {};
  const positive = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const durationMin = positive(parameters.durationMin) ?? positive(planRecord.totalDurationMin);
  const targetVolume = positive(planRecord.totalWaterVolume);
  if (durationMin === undefined && targetVolume === undefined) return undefined;
  return {
    stopOnly: false,
    ...(durationMin === undefined ? {} : { durationMin }),
    ...(targetVolume === undefined ? {} : { targetVolume }),
  };
}

export class FieldGateway {
  private readonly devices: DeviceRepository;
  private readonly tenantId: string;
  private readonly channel: ControlChannel;
  private readonly intervalMs: number;
  private readonly clientFor: (device: Device, binding: ModbusBinding) => ModbusClientLike;
  private readonly plcClientFor: (device: Device, config: PlcDeviceConfig) => PlcClientLike | Promise<PlcClientLike>;
  private readonly configCipher: MqttConfigCipher | undefined;
  private readonly onError: (device: Device, command: FieldCommand, error: Error) => void;
  private readonly now: () => number;
  private readonly publishCommand: ((deviceNo: string, command: unknown) => void) | undefined;
  private readonly clients = new Map<string, FieldClientLike>();
  private readonly clientSignatures = new Map<string, string>();
  private readonly jobs = new Map<string, JobState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: FieldGatewayOptions) {
    this.devices = options.devices;
    this.tenantId = options.tenantId?.trim() || process.env.TENANT_ID?.trim() || DEFAULT_TENANT;
    this.channel = new ControlChannel(
      options.controlBaseUrl?.trim() || process.env.CONTROL_SERVICE_URL?.trim() || DEFAULT_CONTROL_BASE_URL,
      this.tenantId,
      options.deviceToken ?? process.env.DEVICE_CALLBACK_TOKEN,
      options.fetchImpl,
    );
    this.intervalMs = Math.max(500, Number(options.intervalMs ?? process.env.FIELD_GATEWAY_INTERVAL_MS ?? DEFAULT_FIELD_GATEWAY_INTERVAL_MS) || DEFAULT_FIELD_GATEWAY_INTERVAL_MS);
    this.clientFor =
      options.clientFor ??
      ((_device, binding) => new ModbusTcpClient({ host: binding.host, port: binding.port, unitId: binding.unitId, timeoutMs: binding.timeoutMs }));
    this.plcClientFor = options.plcClientFor ?? ((_device, config) => createPlcClient(config, this.configCipher));
    this.configCipher = options.configCipher;
    this.onError = options.onError ?? ((device, command, error) => console.warn(`[field-gateway] ${device.deviceNo} 指令 ${command.id} 失败：${error.message}`));
    this.now = options.now ?? Date.now;
    this.publishCommand = options.publishCommand;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((error) => console.warn(`[field-gateway] 轮询失败：${String(error)}`)), this.intervalMs);
    // 立刻跑一轮，否则启动后第一秒内下发的指令要等到下个周期才被看见
    void this.tick().catch((error) => console.warn(`[field-gateway] 轮询失败：${String(error)}`));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.closeClients();
  }

  /** 释放全部现场连接：网关重启或测试收尾时调用，别留半开的 socket */
  async closeClients(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.clientSignatures.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  /** 一台设备的连接复用；出错后由调用方丢弃重建 */
  private async context(device: Device): Promise<{ client: FieldClientLike; profile: FieldProfile }> {
    if (!isPlcProtocol(device.protocol)) {
      const binding = readModbusBinding(device.binding, device.type);
      const signature = JSON.stringify({ protocol: device.protocol, binding });
      const cached = this.clients.get(device.id);
      if (cached && this.clientSignatures.get(device.id) === signature) {
        const selected = getModbusProfile(binding.profile);
        return {
          client: cached,
          profile: {
            switchPoint: selected.switchCoil,
            switchLabel: hex(selected.switchCoil),
            runFeedbackPoint: selected.runFeedbackInput,
            faultPoint: selected.faultInput,
            faultLabel: hex(selected.faultInput),
            meter: selected.meter ? { ...selected.meter, dataType: "UINT32", point: selected.meter.register } : null,
          },
        };
      }
      if (cached) await cached.close().catch(() => undefined);
      const client = new ModbusFieldClient(this.clientFor(device, binding));
      this.clients.set(device.id, client);
      this.clientSignatures.set(device.id, signature);
      const selected = getModbusProfile(binding.profile);
      return {
        client,
        profile: {
          switchPoint: selected.switchCoil,
          switchLabel: hex(selected.switchCoil),
          runFeedbackPoint: selected.runFeedbackInput,
          faultPoint: selected.faultInput,
          faultLabel: hex(selected.faultInput),
          meter: selected.meter ? { ...selected.meter, dataType: "UINT32", point: selected.meter.register } : null,
        },
      };
    }
    const config = readPlcConfig(device.protocol, device.plc, device.type, this.configCipher);
    const selected = getPlcProfile(device.protocol, config.profile);
    const signature = JSON.stringify({ protocol: device.protocol, config });
    let client = this.clients.get(device.id);
    if (client && this.clientSignatures.get(device.id) !== signature) {
      await client.close().catch(() => undefined);
      this.clients.delete(device.id);
      this.clientSignatures.delete(device.id);
      client = undefined;
    }
    if (!client) {
      client = new PlcFieldClient(await this.plcClientFor(device, config));
      this.clients.set(device.id, client);
      this.clientSignatures.set(device.id, signature);
    }
    const meter = plcMeterFor(config);
    return {
      client,
      profile: {
        switchPoint: config.switchPoint,
        switchLabel: String(config.switchPoint),
        runFeedbackPoint: config.runFeedbackPoint,
        faultPoint: config.faultPoint,
        faultLabel: String(config.faultPoint),
        meter: meter ? { ...meter, point: config.meterPoint! } : null,
      },
    };
  }

  /**
   * 轮询一轮：取全部现场协议设备，逐台把在途指令往前推一步。
   * 一轮里每条指令至多推进一步（写入或结单），因此同一个指令不会既写线圈又立刻结单。
   * 单台设备的台账问题（缺连接、剖面写错）只影响它自己，不把整轮带走。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const devices = await this.devices.list(this.tenantId, { protocols: fieldGatewayProtocols() });
      for (const device of devices) {
        try {
          await this.context(device);
          const commands = await this.channel.pending(device.id);
          for (const command of commands) {
            let client: FieldClientLike | undefined;
            try {
              const context = await this.context(device);
              client = context.client;
              await this.execute(device, context.client, context.profile, command);
            } catch (error) {
              await client?.close().catch(() => undefined);
              this.clients.delete(device.id);
              this.clientSignatures.delete(device.id);
              this.onError(device, command, error instanceof Error ? error : new Error(String(error)));
            }
          }
        } catch (error) {
          this.onError(device, { id: "", deviceId: device.id, type: "", status: "QUEUED", parameters: {}, createdAt: "" }, error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async execute(device: Device, client: FieldClientLike, profile: FieldProfile, command: FieldCommand): Promise<void> {
    // 作业联锁与电子围栏（B4）：作业类指令执行前先过安全校验，判不过直接失败收口，不碰硬件。
    // 控制类指令（急停/断电/暂停等）不受此约束——它们是对在途作业的处置动作，急停必须能下达。
    if (isJobCommandType(command.type)) {
      if (device.status === "OFFLINE") {
        await this.channel.receipt(command.id, "FAILED", "设备离线（作业联锁）：设备未在线，禁止执行作业指令");
        return;
      }
      if (device.plotCode && command.plotCode && device.plotCode !== command.plotCode) {
        await this.channel.receipt(command.id, "FAILED", `电子围栏拦截：指令地块 ${command.plotCode} 与设备绑定地块 ${device.plotCode} 不一致`);
        return;
      }
    }
    const spec = jobSpecOf(command);
    // 判不出收口条件就不领取、不碰硬件：QUEUED 可以直接收口成 FAILED，
    // 先把指令领成 SENT 再失败，等于把「没人规定开多久」的责任推给超时收口
    if (!spec) {
      // 上游算不出包络时会写明原因（处方缺面积、施肥缺定额、越限只带阈值），照实回给台账
      const blocked = command.parameters?.envelopeBlocked;
      await this.channel.receipt(
        command.id,
        "FAILED",
        typeof blocked === "string" && blocked.trim() !== "" ? blocked : "指令未给出作业时长或计划作业量，现场网关不猜该开多久",
      );
      return;
    }
    if (command.status === "QUEUED") {
      await this.channel.dispatch(command.id);
      // MQTT 指令通道（A2）：与 Modbus 线圈下发并存，领取后补发一条给订阅 command topic 的设备
      this.publishCommand?.(device.deviceNo, command);
      await this.startJob(client, profile, command, spec);
      return;
    }
    if (command.status === "SENT") {
      // 上一轮领取后没写成功（掉线、从站忙）：重发一次线圈写入，Modbus 的写线圈本身可重复执行
      await this.startJob(client, profile, command, spec);
      return;
    }
    if (command.status === "ACKED") {
      await this.finishJob(client, profile, command, spec);
    }
  }

  /** 第二步：写入启停点位，读一眼故障输入，没问题就报「设备已接收」 */
  private async startJob(client: FieldClientLike, profile: FieldProfile, command: FieldCommand, spec: JobSpec): Promise<void> {
    const on = !spec.stopOnly;
    await client.writeBoolean(profile.switchPoint, on);
    let faulted: boolean;
    try {
      faulted = await this.isFaulted(client, profile);
    } catch (error) {
      await client.writeBoolean(profile.switchPoint, false).catch(() => undefined);
      throw error;
    }
    if (faulted) {
      // 刚写下去就撞上故障输入：先把开关收回位再报失败，别让阀门挂在打开状态等人来关
      await client.writeBoolean(profile.switchPoint, false).catch(() => undefined);
      await this.channel.receipt(command.id, "FAILED", `设备故障输入置位（${profile.faultLabel}），已关闭启停点位止损`);
      return;
    }
    let baselineCounts: number | null = null;
    if (!spec.stopOnly && profile.meter) {
      try {
        baselineCounts = (await this.readMeterValue(client, profile.meter, null)) ?? null;
      } catch (error) {
        await client.writeBoolean(profile.switchPoint, false).catch(() => undefined);
        throw error;
      }
    }
    this.jobs.set(command.id, { startedAtMs: this.now(), baselineCounts });
    await this.channel.receipt(command.id, "ACKED", `已写入${on ? "启" : "停"}点位 ${profile.switchLabel}`);
  }

  /** 第三步：读反馈判收口，够了就关点位并带上实测作业量结单 */
  private async finishJob(client: FieldClientLike, profile: FieldProfile, command: FieldCommand, spec: JobSpec): Promise<void> {
    let faulted: boolean;
    try {
      faulted = await this.isFaulted(client, profile);
    } catch (error) {
      this.jobs.delete(command.id);
      await client.writeBoolean(profile.switchPoint, false).catch(() => undefined);
      await this.channel.receipt(command.id, "FAILED", `故障反馈读取失败，已关闭启停点位止损：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (faulted) {
      // 作业中出故障先关点位止损，再如实报失败：阀门挂在打开状态等人来关是最坏结果
      await client.writeBoolean(profile.switchPoint, false).catch(() => undefined);
      await this.channel.receipt(command.id, "FAILED", `作业中故障输入置位（${profile.faultLabel}），已关闭启停点位止损`);
      return;
    }

    const state = this.jobs.get(command.id);
    const elapsedMin = Math.max(0, Math.round((this.now() - (state?.startedAtMs ?? startedAtMs(command))) / 60_000));
    let measured: number | undefined;
    if (profile.meter && state) {
      try {
        measured = await this.readMeterValue(client, profile.meter, state.baselineCounts);
      } catch (error) {
        this.jobs.delete(command.id);
        await client.writeBoolean(profile.switchPoint, false).catch(() => undefined);
        await this.channel.receipt(command.id, "FAILED", `作业计量读取失败，已关闭启停点位止损：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    if (spec.stopOnly) {
      // 急停要的是「真的停了」：运行反馈为假才允许结单，且必须带到位确认
      const running = await client.readBoolean(profile.runFeedbackPoint);
      if (running) return;
      this.jobs.delete(command.id);
      await this.channel.receipt(command.id, "DONE", "运行反馈已消失，急停到位", { confirmed: true });
      return;
    }

    const volumeReached = measured !== undefined && spec.targetVolume !== undefined && measured >= spec.targetVolume;
    const durationReached = spec.durationMin !== undefined && elapsedMin >= spec.durationMin;
    if (!volumeReached && !durationReached) return;

    await client.writeBoolean(profile.switchPoint, false);
    // 关阀后再读一次表：管路里的余量不计入本轮用量，最后一次读数才是作业量
    const finalMeasured = profile.meter && state ? await this.readMeterValue(client, profile.meter, state.baselineCounts) : measured;
    this.jobs.delete(command.id);
    const result: Record<string, unknown> = { durationMin: elapsedMin };
    if (finalMeasured !== undefined && profile.meter) {
      result[METER_RESULT_KEY[profile.meter.unit]] = round(finalMeasured, profile.meter.unit === "m³" ? 3 : 1);
    }
    await this.channel.receipt(
      command.id,
      "DONE",
      volumeReached ? `计划作业量达成（实测 ${finalMeasured ?? 0} ${profile.meter?.unit ?? ""}），已关闭启停点位` : `作业满 ${elapsedMin} 分钟，已关闭启停点位`,
      result,
    );
  }

  private async isFaulted(client: FieldClientLike, profile: FieldProfile): Promise<boolean> {
    return client.readBoolean(profile.faultPoint);
  }

  /** 表计读数换算成业务量；没有基线就不报作业量，免得把出厂累计值当成这一轮的用量 */
  private async readMeterValue(client: FieldClientLike, meter: PlcMeter & { point: PlcPoint }, baseline: number | null): Promise<number | undefined> {
    const value = await client.readMeter(meter.point, meter);
    if (baseline === null) return value;
    return Math.max(0, value - baseline);
  }
}

function hex(address: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(4, "0")}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 网关重启后不认识这条在途指令，作业起点退回状态机记录的最后一次推进时刻 */
function startedAtMs(command: FieldCommand): number {
  const at = command.ackedAt ?? command.sentAt ?? command.createdAt;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
