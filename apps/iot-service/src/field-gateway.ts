import { getModbusProfile, readModbusBinding } from "./device-binding.js";
import type { ModbusBinding, ModbusMeter, ModbusProfile } from "./device-binding.js";
import { ModbusTcpClient, combineUint32 } from "./modbus-tcp.js";
import { DEFAULT_TENANT } from "./device.repository.js";
import type { Device, DeviceRepository } from "./device.repository.js";

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

/** 网关一次只服务这一协议的设备；HTTP 回调式设备由设备自己上报，网关不该去连 */
export const FIELD_GATEWAY_PROTOCOL = "MODBUS_TCP";

/** control-service 缺省地址，与网关服务的 `CONTROL_SERVICE_URL` 同一口径 */
export const DEFAULT_CONTROL_BASE_URL = "http://127.0.0.1:3008";

/** 轮询间隔缺省值：现场阀门动作以分钟计，五秒一轮足够跟上，又不会把从站问爆 */
export const DEFAULT_FIELD_GATEWAY_INTERVAL_MS = 5_000;

/** 回执 result 里作业量的键名按计量单位取，灌溉的立方米正是下游要的那个字段 */
const METER_RESULT_KEY: Record<ModbusMeter["unit"], string> = {
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
  /** 单条指令执行失败的回调，缺省只在控制台留一行；不影响其它设备与其它指令 */
  onError?: (device: Device, command: FieldCommand, error: Error) => void;
  now?: () => number;
}

/** 网关用到的 Modbus 主站能力，`ModbusTcpClient` 的子集，便于测试替身 */
export interface ModbusClientLike {
  readDiscreteInputs(address: number, quantity: number): Promise<boolean[]>;
  readHoldingRegisters(address: number, quantity: number): Promise<number[]>;
  writeCoil(address: number, on: boolean): Promise<void>;
  close(): Promise<void>;
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
  if (command.type === "ESTOP") return { stopOnly: true };
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
  private readonly onError: (device: Device, command: FieldCommand, error: Error) => void;
  private readonly now: () => number;
  private readonly clients = new Map<string, ModbusClientLike>();
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
    this.onError = options.onError ?? ((device, command, error) => console.warn(`[field-gateway] ${device.deviceNo} 指令 ${command.id} 失败：${error.message}`));
    this.now = options.now ?? Date.now;
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
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  /** 一台设备的连接复用；出错后由调用方丢弃重建 */
  private client(device: Device, binding: ModbusBinding): ModbusClientLike {
    const cached = this.clients.get(device.id);
    if (cached) return cached;
    const created = this.clientFor(device, binding);
    this.clients.set(device.id, created);
    return created;
  }

  /**
   * 轮询一轮：取现场协议设备，逐台把在途指令往前推一步。
   * 一轮里每条指令至多推进一步（写入或结单），因此同一个指令不会既写线圈又立刻结单。
   * 单台设备的台账问题（缺绑定、剖面写错）只影响它自己，不把整轮带走；
   * 现场连接出错由 `ModbusTcpClient` 自行断线重连，这里不额外拆连接。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const devices = await this.devices.list(this.tenantId, { protocol: FIELD_GATEWAY_PROTOCOL });
      for (const device of devices) {
        try {
          const binding = readModbusBinding(device.binding, device.type);
          const profile = getModbusProfile(binding.profile);
          const commands = await this.channel.pending(device.id);
          for (const command of commands) {
            try {
              await this.execute(device, binding, profile, command);
            } catch (error) {
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

  private async execute(device: Device, binding: ModbusBinding, profile: ModbusProfile, command: FieldCommand): Promise<void> {
    const spec = jobSpecOf(command);
    // 判不出收口条件就不领取、不碰硬件：QUEUED 可以直接收口成 FAILED，
    // 先把指令领成 SENT 再失败，等于把「没人规定开多久」的责任推给超时收口
    if (!spec) {
      await this.channel.receipt(command.id, "FAILED", "指令未给出作业时长或计划作业量，现场网关不猜该开多久");
      return;
    }
    const client = this.client(device, binding);
    if (command.status === "QUEUED") {
      await this.channel.dispatch(command.id);
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

  /** 第二步：写入启停线圈，读一眼故障输入，没问题就报「设备已接收」 */
  private async startJob(client: ModbusClientLike, profile: ModbusProfile, command: FieldCommand, spec: JobSpec): Promise<void> {
    const on = !spec.stopOnly;
    await client.writeCoil(profile.switchCoil, on);
    if (await this.isFaulted(client, profile)) {
      await this.channel.receipt(command.id, "FAILED", `设备故障输入置位（${hex(profile.faultInput)}）`);
      return;
    }
    this.jobs.set(command.id, {
      startedAtMs: this.now(),
      // 急停不需要计量；没有累计寄存器的设备也记空基线，结单时只报时长
      baselineCounts: spec.stopOnly || profile.meter === null ? null : await this.readMeterCounts(client, profile.meter),
    });
    await this.channel.receipt(command.id, "ACKED", `已写入${on ? "启" : "停"}线圈 ${hex(profile.switchCoil)}`);
  }

  /** 第三步：读反馈判收口，够了就关线圈并带上实测作业量结单 */
  private async finishJob(client: ModbusClientLike, profile: ModbusProfile, command: FieldCommand, spec: JobSpec): Promise<void> {
    if (await this.isFaulted(client, profile)) {
      this.jobs.delete(command.id);
      // 作业中出故障先关线圈止损，再如实报失败：阀门挂在打开状态等人来关是最坏结果
      await client.writeCoil(profile.switchCoil, false).catch(() => undefined);
      await this.channel.receipt(command.id, "FAILED", `作业中故障输入置位（${hex(profile.faultInput)}），已关线圈止损`);
      return;
    }

    const state = this.jobs.get(command.id);
    const elapsedMin = Math.max(0, Math.round((this.now() - (state?.startedAtMs ?? startedAtMs(command))) / 60_000));
    const measured = profile.meter && state ? await this.readMeterValue(client, profile.meter, state.baselineCounts) : undefined;

    if (spec.stopOnly) {
      // 急停要的是「真的停了」：运行反馈输入为假才允许结单，且必须带到位确认
      const running = await client.readDiscreteInputs(profile.runFeedbackInput, 1).then((bits) => bits[0] ?? false);
      if (running) return;
      this.jobs.delete(command.id);
      await this.channel.receipt(command.id, "DONE", "运行反馈已消失，急停到位", { confirmed: true });
      return;
    }

    const volumeReached = measured !== undefined && spec.targetVolume !== undefined && measured >= spec.targetVolume;
    const durationReached = spec.durationMin !== undefined && elapsedMin >= spec.durationMin;
    if (!volumeReached && !durationReached) return;

    await client.writeCoil(profile.switchCoil, false);
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
      volumeReached ? `计划作业量达成（实测 ${finalMeasured ?? 0} ${profile.meter?.unit ?? ""}），已关线圈` : `作业满 ${elapsedMin} 分钟，已关线圈`,
      result,
    );
  }

  private async isFaulted(client: ModbusClientLike, profile: ModbusProfile): Promise<boolean> {
    const bits = await client.readDiscreteInputs(profile.faultInput, 1);
    return bits[0] ?? false;
  }

  /** 累计量占两个寄存器，按剖面的字序拼 32 位后乘倍率换成业务量 */
  private async readMeterCounts(client: ModbusClientLike, meter: ModbusMeter): Promise<number> {
    const words = await client.readHoldingRegisters(meter.register, 2);
    const high = meter.wordOrder === "HIGH_FIRST" ? (words[0] ?? 0) : (words[1] ?? 0);
    const low = meter.wordOrder === "HIGH_FIRST" ? (words[1] ?? 0) : (words[0] ?? 0);
    return combineUint32(high, low);
  }

  /** 表计读数换成作业期间的增量；没有基线就不报作业量，免得把出厂累计值当成这一轮的用量 */
  private async readMeterValue(client: ModbusClientLike, meter: ModbusMeter, baselineCounts: number | null): Promise<number | undefined> {
    const counts = await this.readMeterCounts(client, meter);
    if (baselineCounts === null) return undefined;
    return Math.max(0, (counts - baselineCounts) * meter.scale);
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
