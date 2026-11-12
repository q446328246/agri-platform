import { describe, expect, it } from "vitest";

import { FieldGateway } from "../src/field-gateway.js";
import type { FieldCommand, ModbusClientLike } from "../src/field-gateway.js";
import { InMemoryDeviceRepository, DEFAULT_TENANT } from "../src/device.repository.js";
import type { Device } from "../src/device.repository.js";

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
  body?: { commandId?: string; status?: string; message?: string; result?: Record<string, unknown> };
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
      if (row.status === "ACKED") row.ackedAt = new Date(clock.now()).toISOString();
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
    const devices = new InMemoryDeviceRepository();
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
        seen.push(url.searchParams.get("deviceId") ?? "");
        return new Response(JSON.stringify({ code: "OK", message: "", data: { items: [], total: 0, page: 1, size: 50, pages: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
      clientFor: () => new FakeModbus(),
      onError: (device) => errors.push(device.deviceNo),
    });
    await gateway.tick();
    await gateway.stop();

    expect(errors).toEqual(["DZ-P-903"]);
    // 坏绑定没有拖住后面那台：台账按编号排序，好设备照常轮到
    expect(seen).toEqual([good.id]);
  });
});
