import { describe, expect, it } from "vitest";

import { FieldGateway } from "../src/field-gateway.js";
import type { FieldCommand, ModbusClientLike } from "../src/field-gateway.js";
import { InMemoryDeviceRepository, DEFAULT_TENANT } from "../src/device.repository.js";
import type { Device } from "../src/device.repository.js";
import type { PlcClientLike } from "../src/plc-clients.js";
import { normalizePlcConfig } from "../src/plc-binding.js";
import type { PlcMeter, PlcPoint } from "../src/plc-binding.js";

/**
 * 现场协议网关的行为验证：领队列、写线圈、读反馈、把状态推到底。
 *
 * 这里不连真设备也不起 control-service：`fetchImpl` 换成一个按状态机推进的假队列，
 * `clientFor` 换成记地址的假主站。断言的是「调了哪几个点、报了哪个状态、
 * 回执里带了什么量」——这三件事错了，接上真从站只会更错。
 */

const CLOCK_START = Date.parse("2026-11-12T08:00:00.000Z");

/** 可变时钟：网关的时长判据全靠它，写死 Date.now 会让用例按时钟脸色 */
function makeClock() {
  let at = CLOCK_START;
  return { now: () => at, advance: (minutes: number) => (at += minutes * 60_000) };
}

interface ChannelCall {
  method: "GET" | "POST";
  path: string;
  deviceId: string | null;
  body?: { commandId?: string; status?: string; message?: string; result?: Record<string, unknown>; at?: string };
}

/** 假设备通道：按 control-service 的响应壳子推进指令状态，并记下调用顺序 */
function makeChannel(commands: FieldCommand[]) {
  const calls: ChannelCall[] = [];
  const clock = makeClock();
  const rows = new Map(commands.map((command) => [command.id, { ...command }]));
  let failReceipt = false;

  function reply(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = ((init?.method ?? "GET") as ChannelCall["method"]).toUpperCase() as ChannelCall["method"];
    const body = init?.body ? (JSON.parse(String(init.body)) as ChannelCall["body"]) : undefined;
    calls.push({ method, path: url.pathname, deviceId: url.searchParams.get("deviceId"), ...(body ? { body } : {}) });

    if (method === "GET" && url.pathname === "/api/v1/control/device/pending") {
      const items = [...rows.values()].filter((row) => row.deviceId === url.searchParams.get("deviceId"));
      return reply(200, { code: "OK", message: "", data: { items, total: items.length, page: 1, size: 50, pages: 1 } });
    }
    if (method === "POST" && url.pathname === "/api/v1/control/device/dispatch") {
      const row = rows.get(body?.commandId as string);
      if (!row) return reply(404, { code: "CONTROL-404", message: "指令不存在", data: null });
      row.status = "SENT";
      return reply(200, { code: "OK", message: "", data: row });
    }
    if (method === "POST" && url.pathname === "/api/v1/control/device/receipt") {
      if (failReceipt) return reply(409, { code: "CONTROL-409", message: "指令状态已被其它回执推进，请刷新后重试", data: null });
      const row = rows.get(body?.commandId as string);
      if (!row) return reply(404, { code: "CONTROL-404", message: "指令不存在", data: null });
      row.status = body?.status as FieldCommand["status"];
      const at = body?.at ?? new Date(clock.now()).toISOString();
      if (row.status === "ACKED") {
        row.ackedAt = at;
        if (rows.get(String(row.parameters.targetCommandId))?.status === "PAUSED") row.resumedAt = at;
      }
      if (row.status === "DONE" && (row.type === "PAUSE" || row.type === "RESUME")) {
        const linked = rows.get(String(row.parameters.targetCommandId));
        if (linked) {
          linked.status = row.type === "PAUSE" ? "PAUSED" : "ACKED";
          if (row.type === "PAUSE") linked.pausedAt = at;
          else linked.resumedAt = at;
        }
      }
      return reply(200, { code: "OK", message: "", data: row });
    }
    return reply(404, { code: "CONTROL-404", message: "接口不存在", data: null });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    now: clock.now,
    advance: clock.advance,
    rows,
    receipt: (commandId: string) => calls.filter((call) => call.path === "/api/v1/control/device/receipt" && call.body?.commandId === commandId).at(-1)?.body,
    /** 让回执通道报 409，验证网关不会把硬件已写的现场报成成功 */
    breakReceipts: () => (failReceipt = true),
    /** 冲突过后（人工把状态改回来了）恢复放行，用来观察网关的下一轮 */
    healReceipts: () => (failReceipt = false),
  };
}

/**
 * 假主站：记点位地址与写入值。
 *
 * 线圈（可写）与离散输入（只读反馈）刻意分成两套地址：真从站的运行反馈、故障信号来自端子输入，
 * 把网关刚写下去的线圈当成反馈，急停会「立刻到位」。
 */
class FakeModbus implements ModbusClientLike {
  writes: Array<{ address: number; on: boolean }> = [];
  inputReads: number[] = [];
  meterReads = 0;
  inputs = new Map<number, boolean>();
  registers = new Map<number, number>();
  closed = 0;

  async readDiscreteInputs(address: number, quantity: number): Promise<boolean[]> {
    this.inputReads.push(address);
    return Array.from({ length: quantity }, (_, index) => this.inputs.get(address + index) ?? false);
  }

  async readHoldingRegisters(address: number, quantity: number): Promise<number[]> {
    this.meterReads += 1;
    return Array.from({ length: quantity }, (_, index) => this.registers.get(address + index) ?? 0);
  }

  async writeCoil(address: number, on: boolean): Promise<void> {
    this.writes.push({ address, on });
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  /** 累计量是相邻两个 16 位寄存器：WATER_M3 剖面每计数 0.001 m³，故 1 m³ 记作 1000 计数 */
  setVolumeM3(value: number): void {
    const counts = Math.round(value / 0.001);
    this.registers.set(0x0000, Math.floor(counts / 0x10000));
    this.registers.set(0x0001, counts % 0x10000);
  }
}

/** 只装现场设备的台账：网关按协议取设备，别让演示种子把轮询顺序掺进断言 */
function ledgerOf(devices: Device[]): InMemoryDeviceRepository {
  return new InMemoryDeviceRepository(devices);
}

async function pumpDevice(): Promise<Device> {
  const devices = new InMemoryDeviceRepository([]);
  return devices.create(DEFAULT_TENANT, {
    deviceNo: "DZ-P-900",
    name: "东区一号田水泵 P900",
    type: "IRRIGATION_PUMP",
    status: "ONLINE",
    plotCode: "511723-000001-01-00001-0000-5",
    protocol: "MODBUS_TCP",
    binding: { host: "10.0.0.9", port: 502, unitId: 3, profile: "WATER_M3", timeoutMs: 2000 },
  });
}

function command(overrides: Partial<FieldCommand> = {}): FieldCommand {
  return {
    id: "cmd-field-1",
    deviceId: "device-field-pump",
    type: "IRRIGATION",
    status: "QUEUED",
    // 执行包络由 control-service 入队时按分区参数现算，网关只消费不重算
    parameters: { zones: [{ areaMu: 10, targetMm: 20 }], plan: { totalDurationMin: 10, totalWaterVolume: 8 } },
    createdAt: new Date(CLOCK_START).toISOString(),
    ...overrides,
  };
}

describe("现场协议网关", () => {
  it("只轮询现场协议设备，并把台账里的接入地址与单元标识交给主站", async () => {
    const devices = new InMemoryDeviceRepository([]);
    await devices.create(DEFAULT_TENANT, { deviceNo: "DZ-P-901", name: "回调式水泵", type: "IRRIGATION_PUMP", status: "ONLINE" });
    const busDevice = await devices.create(DEFAULT_TENANT, {
      deviceNo: "DZ-P-900",
      name: "总线式水泵",
      type: "IRRIGATION_PUMP",
      status: "ONLINE",
      protocol: "MODBUS_TCP",
      binding: { host: "10.0.0.9", port: 1502, unitId: 7, profile: "WATER_M3", timeoutMs: 3000 },
    });

    // 队列里两台设备各有一条指令：按编号排序回调式那台（DZ-P-001）排在前面
    const channel = makeChannel([
      command({ id: "cmd-callback", deviceId: "device-pump-001" }),
      command({ id: "cmd-bus", deviceId: busDevice.id }),
    ]);
    const endpoints: Array<{ host: string; port: number; unitId: number; timeoutMs: number }> = [];
    const gateway = new FieldGateway({
      devices,
      fetchImpl: channel.fetchImpl,
      clientFor: (_device, binding) => {
        endpoints.push({ host: binding.host, port: binding.port, unitId: binding.unitId, timeoutMs: binding.timeoutMs });
        return new FakeModbus();
      },
      now: channel.now,
    });
    await gateway.tick();
    await gateway.stop();

    // 回调式设备不在场：它的指令由设备自己领，网关去连只会白等一次超时
    const polled = channel.calls.filter((call) => call.method === "GET").map((call) => call.deviceId);
    expect(polled).toEqual([busDevice.id]);
    expect(channel.calls.some((call) => call.deviceId === "device-pump-001")).toBe(false);
    expect(endpoints).toEqual([{ host: "10.0.0.9", port: 1502, unitId: 7, timeoutMs: 3000 }]);
  });

  it("没有待执行指令时不连接现场设备", async () => {
    const pump = await pumpDevice();
    const channel = makeChannel([]);
    let connections = 0;
    const gateway = new FieldGateway({
      devices: ledgerOf([pump]),
      fetchImpl: channel.fetchImpl,
      clientFor: () => {
        connections += 1;
        return new FakeModbus();
      },
      now: channel.now,
    });

    await gateway.tick();
    await gateway.stop();

    expect(channel.calls.map((call) => call.path)).toEqual(["/api/v1/control/device/pending"]);
    expect(connections).toBe(0);
  });

  it("入队指令：先领取再写启线圈，读故障输入后报已接收", async () => {
    const pump = await pumpDevice();
    const queued = command({ deviceId: pump.id });
    const channel = makeChannel([queued]);
    const modbus = new FakeModbus();
    const gateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });

    await gateway.tick();

    expect(channel.calls.map((call) => call.path)).toEqual([
      "/api/v1/control/device/pending",
      "/api/v1/control/device/dispatch",
      "/api/v1/control/device/receipt",
    ]);
    // WATER_M3 剖面：启停线圈 0x0000，故障输入 0x0001
    expect(modbus.writes).toEqual([{ address: 0x0000, on: true }]);
    expect(modbus.inputReads).toEqual([0x0001]);
    expect(channel.receipt(queued.id)).toMatchObject({ status: "ACKED" });
    expect(channel.receipt(queued.id)?.message).toContain("0x0000");
    // 一轮只推进一步：同一轮不许既写线圈又结单
    expect(channel.rows.get(queued.id)?.status).toBe("ACKED");
    await gateway.stop();
  });

  it("时长判据只看指令里现算的包络，算不出就不碰硬件直接失败", async () => {
    const pump = await pumpDevice();
    const blind = command({ id: "cmd-field-blind", deviceId: pump.id, parameters: { items: [{ materialCode: "UREA", dosage: 5 }] } });
    const channel = makeChannel([blind]);
    const modbus = new FakeModbus();
    const gateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });

    await gateway.tick();

    // 没领取、没写线圈：把阀门开到一个没人规定的时刻再收，比拒绝执行更危险
    expect(channel.calls.map((call) => call.path)).toEqual(["/api/v1/control/device/pending", "/api/v1/control/device/receipt"]);
    expect(modbus.writes).toEqual([]);
    expect(channel.rows.get(blind.id)?.status).toBe("FAILED");
    expect(channel.receipt(blind.id)?.message).toContain("作业时长");
    await gateway.stop();
  });

  it("作业满时长后关线圈，按表计增量上报用水量结单", async () => {
    const pump = await pumpDevice();
    const job = command({ id: "cmd-field-duration", deviceId: pump.id, status: "QUEUED" });
    const channel = makeChannel([job]);
    const modbus = new FakeModbus();
    const gateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });

    // 第一轮：领取并写入，基线取此刻的表读数 0
    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");
    expect(modbus.meterReads).toBe(1);

    // 过 3 分钟、灌到 2.5 立方米：时长与计划量都没到，继续等
    modbus.setVolumeM3(2.5);
    channel.advance(3);
    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");
    expect(modbus.writes).toEqual([{ address: 0x0000, on: true }]);

    // 满 10 分钟：先到的是时长判据，水量报本轮增量 7.5
    modbus.setVolumeM3(7.5);
    channel.advance(7);
    await gateway.tick();

    expect(modbus.writes).toEqual([{ address: 0x0000, on: true }, { address: 0x0000, on: false }]);
    expect(channel.receipt(job.id)).toMatchObject({ status: "DONE", result: { durationMin: 10, waterVolumeM3: 7.5 } });
    expect(channel.receipt(job.id)?.message).toContain("10 分钟");
    await gateway.stop();
  });

  it("计划水量先达成就提前收口，不等满时长", async () => {
    const pump = await pumpDevice();
    const job = command({ id: "cmd-field-volume", deviceId: pump.id, status: "QUEUED" });
    const channel = makeChannel([job]);
    const modbus = new FakeModbus();
    const gateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });

    // 写入时刻表计停在 1.2 立方米，作为本轮基线
    modbus.setVolumeM3(1.2);
    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");

    // 过 2 分钟，增量 5.0 < 计划 8：继续等
    modbus.setVolumeM3(6.2);
    channel.advance(2);
    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");

    // 过 3 分钟，增量 7.2 仍未达成：继续等
    modbus.setVolumeM3(8.4);
    channel.advance(1);
    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");

    // 过 4 分钟，增量 8.1 达成计划 8 立方米：提前收口，报增量而不是表计读数
    modbus.setVolumeM3(9.3);
    channel.advance(1);
    await gateway.tick();
    expect(modbus.writes).toEqual([{ address: 0x0000, on: true }, { address: 0x0000, on: false }]);
    expect(channel.receipt(job.id)?.result).toMatchObject({ durationMin: 4, waterVolumeM3: 8.1 });
    expect(channel.receipt(job.id)?.message).toContain("计划作业量达成");
    await gateway.stop();
  });

  it("暂停恢复：关停硬件、排除暂停时长，并在原作业继续推进后结单", async () => {
    const pump = await pumpDevice();
    const job = command({ id: "cmd-field-pause", deviceId: pump.id });
    const channel = makeChannel([job]);
    const modbus = new FakeModbus();
    const gateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });

    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");
    channel.advance(3);
    const pause = command({ id: "cmd-pause", deviceId: pump.id, type: "PAUSE", status: "QUEUED", parameters: { targetCommandId: job.id } });
    channel.rows.set(pause.id, { ...pause });
    await gateway.tick();

    expect(modbus.writes).toEqual([{ address: 0, on: true }, { address: 0, on: false }]);
    expect(channel.receipt(pause.id)).toMatchObject({ status: "DONE", at: new Date(channel.now()).toISOString() });
    expect(channel.rows.get(job.id)?.status).toBe("PAUSED");

    channel.advance(20);
    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("PAUSED");
    expect(modbus.writes).toHaveLength(2);

    const resume = command({ id: "cmd-resume", deviceId: pump.id, type: "RESUME", status: "QUEUED", parameters: { targetCommandId: job.id } });
    channel.rows.set(resume.id, { ...resume });
    await gateway.tick();
    expect(channel.receipt(resume.id)).toMatchObject({ status: "DONE", at: new Date(channel.now()).toISOString() });
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");
    expect(modbus.writes.at(-1)).toEqual({ address: 0, on: true });

    channel.advance(7);
    await gateway.tick();
    expect(modbus.writes).toEqual([
      { address: 0, on: true },
      { address: 0, on: false },
      { address: 0, on: true },
      { address: 0, on: false },
    ]);
    expect(channel.receipt(job.id)).toMatchObject({ status: "DONE", result: { durationMin: 10 } });
    await gateway.stop();
  });

  it("恢复前撞上故障输入只关停并失败，不重新启动设备", async () => {
    const pump = await pumpDevice();
    const job = command({ id: "cmd-field-pause-fault", deviceId: pump.id, status: "ACKED" });
    const pause = command({ id: "cmd-pause-fault", deviceId: pump.id, type: "PAUSE", status: "SENT", parameters: { targetCommandId: job.id } });
    const resume = command({ id: "cmd-resume-fault", deviceId: pump.id, type: "RESUME", status: "SENT", parameters: { targetCommandId: job.id } });
    const channel = makeChannel([job, pause]);
    const modbus = new FakeModbus();
    const gateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });

    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("PAUSED");
    channel.rows.set(resume.id, { ...resume });
    modbus.inputs.set(1, true);
    await gateway.tick();

    expect(modbus.writes).toEqual([{ address: 0, on: false }, { address: 0, on: false }]);
    expect(modbus.writes.some((write) => write.on)).toBe(false);
    expect(channel.receipt(resume.id)).toMatchObject({ status: "FAILED" });
    expect(channel.receipt(resume.id)?.message).toContain("禁止恢复运行");
    expect(channel.rows.get(job.id)?.status).toBe("PAUSED");
    await gateway.stop();
  });

  it("故障输入：接单后即失败，作业中故障先关阀止损", async () => {
    const pump = await pumpDevice();

    const faultAtStart = command({ id: "cmd-fault-start", deviceId: pump.id, status: "QUEUED" });
    const startChannel = makeChannel([faultAtStart]);
    const startModbus = new FakeModbus();
    startModbus.inputs.set(0x0001, true);
    const startGateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: startChannel.fetchImpl, clientFor: () => startModbus, now: startChannel.now });
    await startGateway.tick();
    // 线圈写下去了但读到故障输入：先收回线圈再报失败，不给现场留一个挂在打开位的阀门
    expect(startModbus.writes).toEqual([{ address: 0x0000, on: true }, { address: 0x0000, on: false }]);
    expect(startChannel.receipt(faultAtStart.id)).toMatchObject({ status: "FAILED" });
    expect(startChannel.receipt(faultAtStart.id)?.message).toContain("止损");

    const faultRunning = command({ id: "cmd-fault-running", deviceId: pump.id, status: "ACKED" });
    const runningChannel = makeChannel([faultRunning]);
    const runningModbus = new FakeModbus();
    runningModbus.inputs.set(0x0001, true);
    const runningGateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: runningChannel.fetchImpl, clientFor: () => runningModbus, now: runningChannel.now });
    await runningGateway.tick();
    expect(runningModbus.writes).toEqual([{ address: 0x0000, on: false }]);
    expect(runningChannel.receipt(faultRunning.id)).toMatchObject({ status: "FAILED" });
    expect(runningChannel.receipt(faultRunning.id)?.message).toContain("止损");

    await startGateway.stop();
    await runningGateway.stop();
  });

  it("急停：写停线圈后等运行反馈消失，才带到位确认结单", async () => {
    const devices = new InMemoryDeviceRepository([]);
    const tractor = await devices.create(DEFAULT_TENANT, {
      deviceNo: "DZ-T-900",
      name: "田间拖拉机 T900",
      type: "AUTO_TRACTOR",
      status: "ONLINE",
      protocol: "MODBUS_TCP",
      binding: { host: "10.0.0.30", profile: "SWITCH_ONLY" },
    });
    const estop = command({ id: "cmd-estop", deviceId: tractor.id, type: "ESTOP", parameters: {} });
    const channel = makeChannel([estop]);
    const modbus = new FakeModbus();
    // 车辆还在跑：运行反馈输入为真，它和刚写下去的停线圈是两套地址，不会被写入「假装」成已停
    modbus.inputs.set(0x0000, true);
    const gateway = new FieldGateway({ devices, fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });

    // 第一轮：领取 + 写停 + 报已接收
    await gateway.tick();
    expect(modbus.writes).toEqual([{ address: 0x0000, on: false }]);
    expect(channel.rows.get(estop.id)?.status).toBe("ACKED");

    // 第二轮：运行反馈还在，不许结单
    await gateway.tick();
    expect(channel.rows.get(estop.id)?.status).toBe("ACKED");
    expect(channel.calls.filter((call) => call.path === "/api/v1/control/device/receipt")).toHaveLength(1);

    // 反馈消失后才 DONE，且必须带到位确认，否则 control-service 会拒收
    modbus.inputs.set(0x0000, false);
    await gateway.tick();
    expect(channel.receipt(estop.id)).toMatchObject({ status: "DONE", result: { confirmed: true } });
    await gateway.stop();
  });

  it("网关重启后没有计量基线：只报时长，不拿累计读数冒充本轮用量", async () => {
    const pump = await pumpDevice();
    const stale = command({ id: "cmd-no-baseline", deviceId: pump.id, status: "ACKED", ackedAt: new Date(CLOCK_START).toISOString() });
    const channel = makeChannel([stale]);
    const modbus = new FakeModbus();
    // 表计停在 1200 立方米——这是这台泵从出厂到现在的累计量，不是本轮用量
    modbus.setVolumeM3(1200);
    channel.advance(10);
    const gateway = new FieldGateway({ devices: ledgerOf([pump]), fetchImpl: channel.fetchImpl, clientFor: () => modbus, now: channel.now });
    await gateway.tick();

    // 没有基线就连表都不读：读了也没有可比的前值，只会诱导出「累计量即用量」的错觉
    expect(modbus.meterReads).toBe(0);
    expect(channel.receipt(stale.id)?.result).toEqual({ durationMin: 10 });
    await gateway.stop();
  });

  it("回执被状态机拒绝时不谎报，下一轮只补写线圈、不重复领取", async () => {
    const pump = await pumpDevice();
    const job = command({ id: "cmd-race", deviceId: pump.id, status: "QUEUED" });
    const channel = makeChannel([job]);
    const errors: string[] = [];
    const modbus = new FakeModbus();
    const gateway = new FieldGateway({
      devices: ledgerOf([pump]),
      fetchImpl: channel.fetchImpl,
      clientFor: () => modbus,
      now: channel.now,
      onError: (_device, _command, error) => errors.push(error.message),
    });
    // 人工比网关先结单：网关这一轮的 ACKED 会被状态机挡住
    channel.breakReceipts();
    await gateway.tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("409");
    expect(channel.rows.get(job.id)?.status).toBe("SENT");

    // 下一轮：指令已是 SENT，只重发线圈写入，不再重复领取
    channel.healReceipts();
    channel.calls.length = 0;
    await gateway.tick();
    expect(channel.calls.map((call) => call.path)).toEqual(["/api/v1/control/device/pending", "/api/v1/control/device/receipt"]);
    expect(modbus.writes).toEqual([{ address: 0x0000, on: true }, { address: 0x0000, on: true }]);
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");
    await gateway.stop();
  });

  it("脏台账只影响这一台设备，不带走整轮", async () => {
    const devices = new InMemoryDeviceRepository([]);
    const good = await devices.create(DEFAULT_TENANT, {
      deviceNo: "DZ-P-902",
      name: "好设备",
      type: "IRRIGATION_PUMP",
      status: "ONLINE",
      protocol: "MODBUS_TCP",
      binding: { host: "10.0.0.11", profile: "SWITCH_ONLY" },
    });
    const broken = await devices.create(DEFAULT_TENANT, {
      deviceNo: "DZ-P-903",
      name: "绑定缺失的设备",
      type: "IRRIGATION_PUMP",
      status: "ONLINE",
      protocol: "MODBUS_TCP",
      binding: { host: "10.0.0.12", profile: "SWITCH_ONLY" },
    });
    // 脏台账：协议说走总线，绑定却空着。HTTP 层拦住了正常编辑，历史数据或直接把库改坏才会这样
    await devices.update(DEFAULT_TENANT, broken.id, { binding: null });

    const seen: string[] = [];
    const errors: string[] = [];
    const gateway = new FieldGateway({
      devices,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const deviceId = url.searchParams.get("deviceId") ?? "";
        seen.push(deviceId);
        const items = deviceId === broken.id ? [command({ id: "cmd-dirty-ledger", deviceId })] : [];
        return new Response(JSON.stringify({ code: "OK", message: "", data: { items, total: items.length, page: 1, size: 50, pages: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
      clientFor: () => new FakeModbus(),
      onError: (device) => errors.push(device.deviceNo),
    });
    await gateway.tick();
    await gateway.stop();

    expect(errors).toEqual(["DZ-P-903"]);
    expect(seen).toEqual([good.id, broken.id]);
  });
});

class FakePlc implements PlcClientLike {
  writes: Array<{ point: PlcPoint; value: boolean }> = [];
  fault = false;
  running = false;
  meterValue = 100;
  faultReadError: Error | null = null;
  meterReadError: Error | null = null;
  closed = false;

  async writeBoolean(point: PlcPoint, value: boolean): Promise<void> {
    this.writes.push({ point, value });
  }

  async readBoolean(point: PlcPoint): Promise<boolean> {
    if (point === "DB1,X0.2" || point === "ns=2;i=1003") {
      if (this.faultReadError) throw this.faultReadError;
      return this.fault;
    }
    return this.running;
  }

  async readMeter(_point: PlcPoint, _meter: PlcMeter): Promise<number> {
    if (this.meterReadError) throw this.meterReadError;
    return this.meterValue;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function plcDevice(protocol: "SIEMENS_S7" | "OPC_UA", profile: string): Promise<Device> {
  const common = {
    profile,
    switchPoint: protocol === "SIEMENS_S7" ? "DB1,X0.0" : "ns=2;i=1001",
    runFeedbackPoint: protocol === "SIEMENS_S7" ? "DB1,X0.1" : "ns=2;i=1002",
    faultPoint: protocol === "SIEMENS_S7" ? "DB1,X0.2" : "ns=2;i=1003",
  };
  const raw = protocol === "SIEMENS_S7"
    ? { ...common, host: "s7.test", ...(profile.endsWith("WATER_M3") ? { meterPoint: "DB1,INT0" } : {}) }
    : { ...common, endpointUrl: "opc.tcp://opc.test:4840", authMode: "ANONYMOUS", ...(profile.endsWith("WATER_M3") ? { meterPoint: "ns=2;i=1004" } : {}) };
  const plc = normalizePlcConfig(protocol, raw, "PLC").config;
  const devices = new InMemoryDeviceRepository([]);
  return devices.create(DEFAULT_TENANT, {
    deviceNo: protocol === "SIEMENS_S7" ? "DZ-PLC-900" : "DZ-PLC-901",
    name: "现场 PLC",
    type: "PLC",
    status: "ONLINE",
    protocol,
    plc,
  });
}

describe("PLC 现场协议网关", () => {
  it("S7 设备参与领单、写点位并按业务量增量结单", async () => {
    const device = await plcDevice("SIEMENS_S7", "SIEMENS_S7_WATER_M3");
    const job = command({ id: "cmd-plc-s7", deviceId: device.id });
    const channel = makeChannel([job]);
    const plc = new FakePlc();
    const gateway = new FieldGateway({ devices: ledgerOf([device]), fetchImpl: channel.fetchImpl, plcClientFor: () => plc, now: channel.now });

    await gateway.tick();
    expect(plc.writes).toEqual([{ point: "DB1,X0.0", value: true }]);
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");

    plc.meterValue = 108;
    channel.advance(3);
    await gateway.tick();
    expect(plc.writes.at(-1)).toEqual({ point: "DB1,X0.0", value: false });
    expect(channel.receipt(job.id)).toMatchObject({ status: "DONE", result: { durationMin: 3, waterVolumeM3: 8 } });
    await gateway.stop();
    expect(plc.closed).toBe(true);
  });

  it("PLC 启动即故障时先关闭点位再报失败", async () => {
    const device = await plcDevice("SIEMENS_S7", "SIEMENS_S7_SWITCH_ONLY");
    const job = command({ id: "cmd-plc-fault", deviceId: device.id });
    const channel = makeChannel([job]);
    const plc = new FakePlc();
    plc.fault = true;
    const gateway = new FieldGateway({ devices: ledgerOf([device]), fetchImpl: channel.fetchImpl, plcClientFor: () => plc, now: channel.now });

    await gateway.tick();
    expect(plc.writes).toEqual([{ point: "DB1,X0.0", value: true }, { point: "DB1,X0.0", value: false }]);
    expect(channel.receipt(job.id)).toMatchObject({ status: "FAILED" });
    expect(channel.receipt(job.id)?.message).toContain("DB1,X0.2");
    await gateway.stop();
  });

  it("PLC 计量基线读取失败时先收回启停点位", async () => {
    const device = await plcDevice("SIEMENS_S7", "SIEMENS_S7_WATER_M3");
    const job = command({ id: "cmd-plc-baseline", deviceId: device.id });
    const channel = makeChannel([job]);
    const plc = new FakePlc();
    plc.meterReadError = new Error("baseline unavailable");
    const errors: Error[] = [];
    const gateway = new FieldGateway({ devices: ledgerOf([device]), fetchImpl: channel.fetchImpl, plcClientFor: () => plc, now: channel.now, onError: (_device, _command, error) => errors.push(error) });

    await gateway.tick();
    expect(plc.writes).toEqual([{ point: "DB1,X0.0", value: true }, { point: "DB1,X0.0", value: false }]);
    expect(channel.rows.get(job.id)?.status).toBe("SENT");
    expect(errors[0]?.message).toBe("baseline unavailable");
    await gateway.stop();
  });

  it.each(["faultReadError", "meterReadError"] as const)("PLC 作业中 %s 时关闭点位并以 FAILED 收口", async (failure) => {
    const device = await plcDevice("SIEMENS_S7", "SIEMENS_S7_WATER_M3");
    const job = command({ id: `cmd-plc-running-${failure}`, deviceId: device.id });
    const channel = makeChannel([job]);
    const plc = new FakePlc();
    const gateway = new FieldGateway({ devices: ledgerOf([device]), fetchImpl: channel.fetchImpl, plcClientFor: () => plc, now: channel.now });

    await gateway.tick();
    expect(channel.rows.get(job.id)?.status).toBe("ACKED");
    plc[failure] = new Error("feedback unavailable");
    await gateway.tick();

    expect(plc.writes.at(-1)).toEqual({ point: "DB1,X0.0", value: false });
    expect(channel.receipt(job.id)).toMatchObject({ status: "FAILED" });
    expect(channel.receipt(job.id)?.message).toContain("已关闭启停点位止损");
    await gateway.stop();
  });

  it.each(["ESTOP", "POWER_OFF"] as const)("PLC %s 必须读到运行反馈为假才确认到位", async (type) => {
    const device = await plcDevice("OPC_UA", "OPC_UA_SWITCH_ONLY");
    const estop = command({ id: `cmd-plc-${type}`, deviceId: device.id, type, parameters: {} });
    const channel = makeChannel([estop]);
    const plc = new FakePlc();
    plc.running = true;
    const gateway = new FieldGateway({ devices: ledgerOf([device]), fetchImpl: channel.fetchImpl, plcClientFor: () => plc, now: channel.now });

    await gateway.tick();
    expect(plc.writes).toEqual([{ point: "ns=2;i=1001", value: false }]);
    expect(channel.rows.get(estop.id)?.status).toBe("ACKED");

    await gateway.tick();
    expect(channel.rows.get(estop.id)?.status).toBe("ACKED");
    plc.running = false;
    await gateway.tick();
    expect(channel.receipt(estop.id)).toMatchObject({ status: "DONE", result: { confirmed: true } });
    await gateway.stop();
  });
});
