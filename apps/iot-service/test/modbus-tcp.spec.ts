import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";

import {
  ModbusException,
  ModbusFunction,
  ModbusTcpClient,
  ModbusTransportError,
  combineUint32,
  decodeReadBits,
  decodeReadRegisters,
  decodeWriteEcho,
  encodeModbusTcpFrame,
  encodeReadBits,
  encodeReadRegisters,
  encodeWriteCoil,
  encodeWriteRegister,
  encodeWriteRegisters,
  readModbusTcpHeader,
  takeModbusTcpFrame,
} from "../src/modbus-tcp.js";

/**
 * Modbus TCP 主站侧（网关主动连现场设备）的逐字节验证。
 *
 * 黄金帧按规范报文结构手算写死，用来钉住「MBAP 长度字段由 PDU 现算」这条口径——
 * 一旦有人把长度写成常量，帧就和真实从站对不上，而这类偏差在现场极难定位。
 * 端到端部分用 node:net 起进程内假从站，覆盖读位 / 读寄存器 / 写线圈 / 写单寄存器 / 写多寄存器、
 * 异常响应、超时断连与重连、对端提前断开。
 */

const servers: Server[] = [];
const clients: ModbusTcpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** 寄存器应答：读回 300/200，写入回显；地址 0x7fff 一律回异常码 0x02，用来测异常通路 */
function defaultRespond(pdu: Buffer): Buffer | null {
  const functionCode = pdu.readUInt8(0);
  const address = pdu.readUInt16BE(1);
  if (address === 0x7fff) return Buffer.from([functionCode | 0x80, 0x02]);
  switch (functionCode) {
    case ModbusFunction.ReadCoils:
    case ModbusFunction.ReadDiscreteInputs: {
      const quantity = pdu.readUInt16BE(3);
      const bits = Buffer.alloc(Math.ceil(quantity / 8));
      bits[0] = 0x05;
      return Buffer.concat([Buffer.from([functionCode, bits.length]), bits]);
    }
    case ModbusFunction.ReadHoldingRegisters: {
      const quantity = pdu.readUInt16BE(3);
      const body = Buffer.alloc(quantity * 2);
      body.writeUInt16BE(300, 0);
      if (quantity > 1) body.writeUInt16BE(200, 2);
      return Buffer.concat([Buffer.from([functionCode, body.length]), body]);
    }
    case ModbusFunction.ReadInputRegisters: {
      const body = Buffer.alloc(quantityBytes(pdu));
      body.writeUInt16BE(1, 0);
      return Buffer.concat([Buffer.from([functionCode, body.length]), body]);
    }
    case ModbusFunction.WriteSingleCoil:
    case ModbusFunction.WriteSingleRegister:
      return Buffer.from(pdu.subarray(0, 5));
    case ModbusFunction.WriteMultipleRegisters: {
      // FC16 响应 PDU = 功能码 + 起始地址 + 写入数量，共 5 字节
      const echo = Buffer.alloc(5);
      echo.writeUInt8(functionCode, 0);
      echo.writeUInt16BE(address, 1);
      echo.writeUInt16BE(pdu.readUInt16BE(3), 3);
      return echo;
    }
    default:
      return Buffer.from([functionCode | 0x80, 0x01]);
  }
}

function quantityBytes(pdu: Buffer): number {
  return pdu.readUInt16BE(3) * 2;
}

interface FakeSlave {
  port: number;
  /** 从站收到的请求 PDU，用于断言网关确实逐笔发了这些帧 */
  requests: Buffer[];
  /** 从站经历过的连接数：超时断连后重连应当 +1 */
  connections(): number;
  /** 置为 true 后从站收到请求不回包，用来测超时 */
  silent: boolean;
}

/** 起一个进程内 Modbus TCP 从站；respond 返回 null 表示「装死」不回包 */
async function startFakeSlave(respond: (pdu: Buffer) => Buffer | null = defaultRespond): Promise<FakeSlave> {
  const requests: Buffer[] = [];
  let opened = 0;
  const state: FakeSlave = { port: 0, requests, connections: () => opened, silent: false };
  const server = createServer((socket: Socket) => {
    opened += 1;
    // 网关超时后会硬断，被 accept 侧收到 ECONNRESET 是预期内的，不让它冒成未捕获异常
    socket.on("error", () => undefined);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const taken = takeModbusTcpFrame(buffer);
        if (!taken) return;
        buffer = taken.rest;
        const { transactionId, unitId, pdu } = readModbusTcpHeader(taken.frame);
        requests.push(Buffer.from(pdu));
        if (state.silent) continue;
        const answer = respond(pdu);
        if (answer) socket.write(encodeModbusTcpFrame(transactionId, unitId, answer));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("假从站未分配端口");
  state.port = address.port;
  return state;
}

function connect(port: number, options: { unitId?: number; timeoutMs?: number } = {}): ModbusTcpClient {
  const client = new ModbusTcpClient({ host: "127.0.0.1", port, ...options });
  clients.push(client);
  return client;
}

const toHex = (buffer: Buffer) => buffer.toString("hex").toUpperCase();

describe("Modbus TCP 帧编解码", () => {
  it("请求帧逐字节等于规范示例报文，长度字段由 PDU 现算", () => {
    // 读保持寄存器 0 起 2 个：MBAP 长度 = 单元标识 1 + PDU 5 = 6
    expect(toHex(encodeModbusTcpFrame(0x0001, 0xff, encodeReadRegisters(ModbusFunction.ReadHoldingRegisters, 0x0000, 0x0002)))).toBe("000100000006FF0300000002");
    // 写单个线圈 0xAC00 置位
    expect(toHex(encodeModbusTcpFrame(0x0001, 0xff, encodeWriteCoil(0xac00, true)))).toBe("000100000006FF05AC00FF00");
    expect(toHex(encodeWriteCoil(0xac00, false))).toBe("05AC000000");
    // 从 0x13 起读 37 个线圈
    expect(toHex(encodeModbusTcpFrame(0x0001, 0xff, encodeReadBits(ModbusFunction.ReadCoils, 0x0013, 0x0025)))).toBe("000100000006FF0100130025");
    // 从 0x01 起写 2 个寄存器 [300, 0]：PDU 10 字节，长度字段 11
    expect(toHex(encodeModbusTcpFrame(0x0001, 0xff, encodeWriteRegisters(0x0001, [300, 0])))).toBe("00010000000BFF100001000204012C0000");
    expect(toHex(encodeWriteRegister(0x0001, 0x000a))).toBe("060001000A");
  });

  it("MBAP 头可回读，事务标识与单元标识各自归位", () => {
    const frame = encodeModbusTcpFrame(0x1234, 0x07, encodeReadBits(ModbusFunction.ReadDiscreteInputs, 0x0000, 0x0001));
    const header = readModbusTcpHeader(frame);
    expect(header).toMatchObject({ transactionId: 0x1234, unitId: 0x07 });
    expect(toHex(header.pdu)).toBe("0200000001");
  });

  it("定界按长度字段走：拆包等下一段、粘包逐帧取、非 Modbus 流量直接拒", () => {
    const frame = encodeModbusTcpFrame(0x0001, 0x01, encodeWriteRegister(0x0000, 0x002c));
    expect(takeModbusTcpFrame(frame.subarray(0, 5))).toBeNull();
    const two = Buffer.concat([frame, frame]);
    const first = takeModbusTcpFrame(two);
    expect(first?.frame.length).toBe(frame.length);
    expect(takeModbusTcpFrame(first?.rest ?? Buffer.alloc(0))?.frame.length).toBe(frame.length);

    const wrongProtocol = Buffer.from(frame);
    wrongProtocol.writeUInt16BE(0x0001, 2);
    expect(() => takeModbusTcpFrame(wrongProtocol)).toThrow(/协议标识非 0/);
    // 长度字段小于「单元标识 + 功能码」的 2 字节下限即为非法
    const badLength = Buffer.from(frame);
    badLength.writeUInt16BE(1, 4);
    expect(() => takeModbusTcpFrame(badLength)).toThrow(/长度字段非法/);
  });

  it("位读取按 LSB 在前跨字节展开，字节数与请求数量不符视为坏响应", () => {
    // 10 个位 → 2 字节：0x05 = 位 0、位 2 合；0x02 = 位 9 合（第 2 字节的 bit1）
    const pdu = Buffer.from([ModbusFunction.ReadCoils, 0x02, 0x05, 0x02]);
    expect(decodeReadBits(pdu, 10)).toEqual([true, false, true, false, false, false, false, false, false, true]);
    expect(() => decodeReadBits(pdu, 8)).toThrow(/字节数与请求数量不符/);
    expect(() => decodeReadBits(Buffer.from([ModbusFunction.ReadCoils, 0x02, 0x05]), 10)).toThrow(/被截断/);
  });

  it("寄存器读取还原为 16 位无符号数组，32 位量由高低字拼出", () => {
    expect(decodeReadRegisters(Buffer.from([ModbusFunction.ReadHoldingRegisters, 0x04, 0x01, 0x2c, 0x00, 0xc8]), 2)).toEqual([300, 200]);
    expect(() => decodeReadRegisters(Buffer.from([ModbusFunction.ReadHoldingRegisters, 0x02, 0x01]), 1)).toThrow(/被截断/);
    expect(combineUint32(0x0001, 0x2c00)).toBe(76800);
    expect(() => combineUint32(0x10000, 0)).toThrow(/16 位无符号/);
  });

  it("异常响应还原成 ModbusException，写回显功能码不符视为传输错误", () => {
    expect(() => decodeReadRegisters(Buffer.from([0x83, 0x02]), 1)).toThrow(ModbusException);
    expect(() => decodeReadBits(Buffer.from([0x81, 0x0b]), 1)).toThrow(/目标设备无响应/);
    try {
      decodeWriteEcho(Buffer.from([0x86, 0x03]), ModbusFunction.WriteSingleRegister);
      throw new Error("应当抛出异常");
    } catch (error) {
      expect(error).toBeInstanceOf(ModbusException);
      expect((error as ModbusException).exceptionCode).toBe(0x03);
    }
    // 只有功能码没有异常码的残帧按传输错误报出，不能让 RangeError 逃到网关外层
    expect(() => decodeWriteEcho(Buffer.from([0x86]), ModbusFunction.WriteSingleRegister)).toThrow(/缺少异常码/);
    expect(() => decodeWriteEcho(Buffer.from([0x05, 0x00, 0x00, 0xff, 0x00]), ModbusFunction.WriteSingleRegister)).toThrow(/功能码不符/);
    expect(decodeWriteEcho(Buffer.from([0x06, 0x00, 0x01, 0x00, 0x2c]), ModbusFunction.WriteSingleRegister)).toEqual({ address: 1, value: 44 });
  });

  it("地址、数量与单元标识越界在发包前拒掉，避免把非法帧发到现场", () => {
    expect(() => encodeReadRegisters(ModbusFunction.ReadHoldingRegisters, 0x10000, 1)).toThrow(/0~65535/);
    expect(() => encodeReadRegisters(ModbusFunction.ReadHoldingRegisters, 0, 126)).toThrow(/1~125/);
    expect(() => encodeReadBits(ModbusFunction.ReadCoils, 0, 2001)).toThrow(/1~2000/);
    expect(() => encodeWriteRegisters(0, Array.from({ length: 124 }, () => 1))).toThrow(/1~123/);
    expect(() => encodeWriteRegister(0, -1)).toThrow(/16 位无符号/);
    expect(() => encodeModbusTcpFrame(0, 256, Buffer.from([0x03]))).toThrow(/0~255/);
  });
});

describe("Modbus TCP 客户端事务", () => {
  it("读写穿过真实 TCP：请求帧逐笔对齐，全程复用一条连接", async () => {
    const slave = await startFakeSlave();
    const client = connect(slave.port, { unitId: 0x0a });

    expect(await client.readHoldingRegisters(0x0000, 2)).toEqual([300, 200]);
    expect(await client.readInputRegisters(0x0000, 1)).toEqual([1]);
    expect(await client.readCoils(0x0000, 8)).toEqual([true, false, true, false, false, false, false, false]);
    await client.writeCoil(0x00ac, true);
    await client.writeRegister(0x0001, 300);
    await client.writeRegisters(0x0001, [300, 0]);

    expect(slave.requests.map((pdu) => pdu.toString("hex"))).toEqual([
      "0300000002",
      "0400000001",
      "0100000008",
      "0500acff00",
      "060001012c",
      "100001000204012c0000",
    ]);
    // 现场设备不欢迎每笔都重连：一个 endpoint 一条长连接
    expect(slave.connections()).toBe(1);
  });

  it("从站异常响应按业务异常抛出，网关据此把指令收口成 FAILED", async () => {
    const slave = await startFakeSlave();
    const client = connect(slave.port);
    await expect(client.readHoldingRegisters(0x7fff, 1)).rejects.toThrow(ModbusException);
    await expect(client.writeRegisters(0x7fff, [1])).rejects.toThrow(/非法数据地址/);
    await expect(client.writeCoil(0x7fff, true)).rejects.toThrow(ModbusException);
    // 异常是设备「明确拒绝」，连接本身没问题：不该为此重连
    expect(slave.connections()).toBe(1);
  });

  it("从站装死则超时断开，下一笔请求自动重连", async () => {
    const slave = await startFakeSlave();
    const client = connect(slave.port, { timeoutMs: 120 });
    slave.silent = true;
    await expect(client.readHoldingRegisters(0x0000, 1)).rejects.toThrow(/无响应/);

    slave.silent = false;
    expect(await client.readHoldingRegisters(0x0000, 1)).toEqual([300]);
    expect(slave.connections()).toBe(2);
  });

  it("对端提前断开时待决事务一并失败，错误可定位到接入地址", async () => {
    const server = createServer((socket) => socket.destroy());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("假设备未分配端口");
    await expect(connect(address.port, { timeoutMs: 500 }).readHoldingRegisters(0x0000, 1)).rejects.toThrow(ModbusTransportError);
  });

  it("设备回显与请求不一致视为失败，不把没落地的动作报成成功", async () => {
    const slave = await startFakeSlave((pdu) => {
      // 写单寄存器：地址照抄、值改一个位——现实中「设备收到但没按请求落地」的样子
      if (pdu.readUInt8(0) === ModbusFunction.WriteSingleRegister) return Buffer.from([0x06, pdu.readUInt8(1), pdu.readUInt8(2), 0xff, 0xff]);
      return defaultRespond(pdu);
    });
    const client = connect(slave.port);
    await expect(client.writeRegister(0x0001, 300)).rejects.toThrow(/回显与请求不一致/);
    expect(slave.requests.length).toBe(1);
  });
});
