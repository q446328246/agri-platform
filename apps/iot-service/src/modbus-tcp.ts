import { Socket } from "node:net";

/**
 * Modbus TCP 客户端（协议规范：Modbus Application Protocol Specification V1.1b3 / Modbus Messaging on TCP/IP V1.1b3）。
 *
 * 平台的控制指令过去只能等设备「自己打回来」（`/api/v1/control/device/*` 回调），
 * 现场真正在用的泵阀、水肥机讲的是 Modbus TCP——它是主站（网关）轮询/写寄存器，
 * 从站（设备）只会应答，永远不主动连平台。本模块把「主站」这一侧做实：
 * 平台侧网关按台账里的接入地址主动连设备、写线圈/寄存器下发动作、回读状态与计量值。
 *
 * 帧结构（TCP 无 CRC，靠 MBAP 头里的长度字段定界）：
 *   MBAP = 事务标识(2) + 协议标识(2，恒 0) + 后续字节数(2) + 单元标识(2 之后 1 字节)
 *   PDU  = 功能码(1) + 数据(N)
 *
 * 长度字段都不写死：寄存器/线圈数量、字节数都按请求参数现算，
 * 32 位量由两个 16 位寄存器拼出，字序（高字在前 / 低字在前）由设备剖面带过来。
 */

/** Modbus TCP 默认端口（规范值，接入地址未填端口时用它的条件见 device-profiles.ts） */
export const MODBUS_TCP_DEFAULT_PORT = 502;

/** 请求超时缺省值：现场网关到设备的 RTT 以毫秒计，超过这个数就是链路或从站出问题 */
export const MODBUS_TCP_DEFAULT_TIMEOUT_MS = 2_000;

/** MBAP 头长度：事务 2 + 协议 2 + 长度 2 + 单元 1 */
const MBAP_HEADER_LENGTH = 7;

/** 已实现的功能码 */
export const ModbusFunction = {
  ReadCoils: 0x01,
  ReadDiscreteInputs: 0x02,
  ReadHoldingRegisters: 0x03,
  ReadInputRegisters: 0x04,
  WriteSingleCoil: 0x05,
  WriteSingleRegister: 0x06,
  WriteMultipleCoils: 0x0f,
  WriteMultipleRegisters: 0x10,
} as const;
export type ModbusFunctionCode = (typeof ModbusFunction)[keyof typeof ModbusFunction];

/** 位读取只接受 FC01/FC02，寄存器读取只接受 FC03/FC04：传错功能码在编译期就挡掉 */
type BitReadFunctionCode = (typeof ModbusFunction)["ReadCoils" | "ReadDiscreteInputs"];
type RegisterReadFunctionCode = (typeof ModbusFunction)["ReadHoldingRegisters" | "ReadInputRegisters"];

/** 规范定义的异常码（响应 PDU = 功能码 | 0x80，随后一字节异常码） */
export const MODBUS_EXCEPTION_CODES: Record<number, string> = {
  0x01: "非法功能码",
  0x02: "非法数据地址",
  0x03: "非法数据值",
  0x04: "从站设备故障",
  0x05: "已确认（从站正在执行长操作）",
  0x06: "从站设备忙",
  0x08: "存储奇偶校验错误",
  0x0a: "网关路径不可用",
  0x0b: "目标设备无响应",
};

/** 从站返回异常响应 */
export class ModbusException extends Error {
  constructor(readonly functionCode: number, readonly exceptionCode: number) {
    super(`Modbus 异常响应：功能码 0x${functionCode.toString(16).padStart(2, "0")}，${MODBUS_EXCEPTION_CODES[exceptionCode] ?? `未知异常码 0x${exceptionCode.toString(16).padStart(2, "0")}`}`);
    this.name = "ModbusException";
  }
}

/** 传输层失败（连不上、超时、连接中断、帧不合法） */
export class ModbusTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModbusTransportError";
  }
}

/** 一次 Modbus 事务的对端地址 */
export interface ModbusEndpoint {
  host: string;
  port?: number;
  /** 单元标识（从站地址），串口网关转 RS-485 时用它区分挂在同一网关下的多台设备 */
  unitId?: number;
  timeoutMs?: number;
}

function checkAddress(name: string, address: number): void {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff) throw new ModbusTransportError(`${name}必须是 0~65535 的寄存器/线圈地址`);
}

function checkQuantity(name: string, quantity: number, max: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) throw new ModbusTransportError(`${name}必须是 1~${max} 的整数`);
}

/** 单个 16 位量的合法范围（Modbus 寄存器值域） */
function checkWord(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new ModbusTransportError(`${name}必须是 0~65535 的 16 位无符号整数`);
}

/** 单元标识是 MBAP 里的单个字节（串口网关下挂的从站地址，0 为广播） */
function checkUnitId(unitId: number): void {
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 0xff) throw new ModbusTransportError(`单元标识必须是 0~255 的整数，收到 ${unitId}`);
}

/**
 * 异常响应（功能码 | 0x80 + 异常码）转成 ModbusException。
 * 对端是现场设备，报文可能残缺，缺异常码时按传输错误报出，别让 RangeError 冒出来。
 */
function asModbusException(pdu: Buffer): ModbusException {
  if (pdu.length < 2) throw new ModbusTransportError("异常响应缺少异常码字节");
  return new ModbusException(pdu.readUInt8(0) & 0x7f, pdu.readUInt8(1));
}

/** 响应 PDU 首字节是否为异常功能码 */
function isException(pdu: Buffer): boolean {
  return (pdu.readUInt8(0) & 0x80) === 0x80;
}

/** 组 MBAP 头 + PDU 成一个完整请求帧 */
export function encodeModbusTcpFrame(transactionId: number, unitId: number, pdu: Buffer): Buffer {
  checkWord("事务标识", transactionId);
  checkUnitId(unitId);
  const frame = Buffer.alloc(MBAP_HEADER_LENGTH + pdu.length);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(0, 2);
  // 长度字段 = 单元标识 1 字节 + PDU，不含事务标识与协议标识自己
  frame.writeUInt16BE(pdu.length + 1, 4);
  frame.writeUInt8(unitId, 6);
  pdu.copy(frame, MBAP_HEADER_LENGTH);
  return frame;
}

/**
 * 从累积缓冲区里取出下一个完整响应帧。
 * TCP 会拆包粘包，所以调用方持续喂 buffer，这里只在凑齐一整帧时消费并返回，
 * 否则返回 null 等下一次数据（同时把明显不是 Modbus 的头拒掉）。
 */
export function takeModbusTcpFrame(buffer: Buffer): { frame: Buffer; rest: Buffer } | null {
  if (buffer.length < MBAP_HEADER_LENGTH) return null;
  const protocolId = buffer.readUInt16BE(2);
  if (protocolId !== 0) throw new ModbusTransportError(`协议标识非 0（${protocolId}），对端口不是 Modbus TCP`);
  const length = buffer.readUInt16BE(4);
  if (length < 2 || length > 260) throw new ModbusTransportError(`MBAP 长度字段非法：${length}`);
  const total = 6 + length;
  if (buffer.length < total) return null;
  return { frame: buffer.subarray(0, total), rest: buffer.subarray(total) };
}

/** 解析响应帧的 MBAP 头 */
export function readModbusTcpHeader(frame: Buffer): { transactionId: number; unitId: number; pdu: Buffer } {
  if (frame.length < MBAP_HEADER_LENGTH) throw new ModbusTransportError("响应帧不足 MBAP 头长度");
  return {
    transactionId: frame.readUInt16BE(0),
    unitId: frame.readUInt8(6),
    pdu: frame.subarray(MBAP_HEADER_LENGTH),
  };
}

/** 请求 PDU：读线圈（FC01）/ 读离散输入（FC02） */
export function encodeReadBits(functionCode: BitReadFunctionCode, address: number, quantity: number): Buffer {
  checkAddress("起始地址", address);
  // 规范上限：位读一次不超过 2000 个
  checkQuantity("读取数量", quantity, 2_000);
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(functionCode, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(quantity, 3);
  return pdu;
}

/** 响应 PDU：位读取的打包字节还原成布尔数组（LSB 在前） */
export function decodeReadBits(pdu: Buffer, quantity: number): boolean[] {
  if (isException(pdu)) throw asModbusException(pdu);
  const byteCount = pdu.readUInt8(1);
  if (byteCount !== Math.ceil(quantity / 8)) throw new ModbusTransportError(`位读取字节数与请求数量不符：期望 ${Math.ceil(quantity / 8)}，收到 ${byteCount}`);
  if (pdu.length < 2 + byteCount) throw new ModbusTransportError("位读取响应被截断");
  const bits: boolean[] = [];
  for (let index = 0; index < quantity; index += 1) {
    const byte = pdu.readUInt8(2 + Math.floor(index / 8));
    bits.push(((byte >> (index % 8)) & 1) === 1);
  }
  return bits;
}

/** 请求 PDU：读保持寄存器（FC03）/ 读输入寄存器（FC04） */
export function encodeReadRegisters(functionCode: RegisterReadFunctionCode, address: number, quantity: number): Buffer {
  checkAddress("起始地址", address);
  // 规范上限：寄存器读一次不超过 125 个
  checkQuantity("读取数量", quantity, 125);
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(functionCode, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(quantity, 3);
  return pdu;
}

/** 响应 PDU：寄存器数组（每个 16 位，大端） */
export function decodeReadRegisters(pdu: Buffer, quantity: number): number[] {
  if (isException(pdu)) throw asModbusException(pdu);
  const byteCount = pdu.readUInt8(1);
  if (byteCount !== quantity * 2) throw new ModbusTransportError(`寄存器读取字节数与请求数量不符：期望 ${quantity * 2}，收到 ${byteCount}`);
  if (pdu.length < 2 + byteCount) throw new ModbusTransportError("寄存器读取响应被截断");
  const values: number[] = [];
  for (let index = 0; index < quantity; index += 1) values.push(pdu.readUInt16BE(2 + index * 2));
  return values;
}

/** 请求 PDU：写单个线圈（FC05），值只能是 0xFF00（合）或 0x0000（分） */
export function encodeWriteCoil(address: number, on: boolean): Buffer {
  checkAddress("线圈地址", address);
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(ModbusFunction.WriteSingleCoil, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(on ? 0xff00 : 0x0000, 3);
  return pdu;
}

/** 请求 PDU：写单个寄存器（FC06） */
export function encodeWriteRegister(address: number, value: number): Buffer {
  checkAddress("寄存器地址", address);
  checkWord("寄存器值", value);
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(ModbusFunction.WriteSingleRegister, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(value, 3);
  return pdu;
}

/** 请求 PDU：写多个寄存器（FC16） */
export function encodeWriteRegisters(address: number, values: number[]): Buffer {
  checkAddress("起始寄存器地址", address);
  checkQuantity("写入数量", values.length, 123);
  const pdu = Buffer.alloc(6 + values.length * 2);
  pdu.writeUInt8(ModbusFunction.WriteMultipleRegisters, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(values.length, 3);
  pdu.writeUInt8(values.length * 2, 5);
  values.forEach((value, index) => {
    checkWord("寄存器值", value);
    pdu.writeUInt16BE(value, 6 + index * 2);
  });
  return pdu;
}

/** 写类请求的响应只是回显，校验功能码与回显值即可 */
export function decodeWriteEcho(pdu: Buffer, functionCode: number): { address: number; value: number } {
  // 异常响应只有 2 字节，必须排在长度校验前面，否则设备拒绝被读成「响应被截断」
  if (isException(pdu)) throw asModbusException(pdu);
  if (pdu.length < 5) throw new ModbusTransportError("写响应被截断");
  if (pdu.readUInt8(0) !== functionCode) throw new ModbusTransportError(`写响应功能码不符：期望 0x${functionCode.toString(16)}，收到 0x${pdu.readUInt8(0).toString(16)}`);
  return { address: pdu.readUInt16BE(1), value: pdu.readUInt16BE(3) };
}

/**
 * 32 位量：现场电表/水表常见把高低 16 位拆在相邻两个寄存器里。
 * 字序由设备手册决定（`high-first` 为 ABCD，`low-first` 为 CDAB），不猜——由接入剖面提供。
 */
export function combineUint32(high: number, low: number): number {
  checkWord("高字", high);
  checkWord("低字", low);
  return high * 0x10000 + low;
}

interface PendingTransaction {
  /** 事务所属连接：断开事件来自旧连接时，不能把已重连的新事务一起拒掉 */
  socket: Socket;
  resolve: (pdu: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 长连接客户端：一个 endpoint 一条 TCP 连接，事务标识递增复用。
 * 从站掉线或超时会断开连接，下一次请求重连——现场设备的常见状态就是偶尔断。
 * 每个待决事务记住自己发在哪条连接上，旧连接的断开事件不会误伤重连后的新事务。
 */
export class ModbusTcpClient {
  private readonly endpoint: Required<ModbusEndpoint>;
  private socket: Socket | null = null;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextTransactionId = 0;
  private readonly pending = new Map<number, PendingTransaction>();

  constructor(endpoint: ModbusEndpoint) {
    this.endpoint = {
      host: endpoint.host,
      port: endpoint.port ?? MODBUS_TCP_DEFAULT_PORT,
      unitId: endpoint.unitId ?? 1,
      timeoutMs: endpoint.timeoutMs ?? MODBUS_TCP_DEFAULT_TIMEOUT_MS,
    };
  }

  /** 发送一个请求 PDU 并等待同事务标识的响应 PDU */
  async request(pdu: Buffer): Promise<Buffer> {
    const socket = await this.connect();
    const transactionId = this.nextTransactionId;
    this.nextTransactionId = (this.nextTransactionId + 1) % 0x10000;
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transactionId);
        // 超时说明对端没回应，这条连接的状态已不可信：断开，让下次请求重连
        this.drop(socket);
        reject(new ModbusTransportError(`Modbus 事务 ${transactionId} 超过 ${this.endpoint.timeoutMs}ms 无响应（${this.endpoint.host}:${this.endpoint.port}）`));
      }, this.endpoint.timeoutMs);
      this.pending.set(transactionId, { socket, resolve, reject, timer });
      socket.write(encodeModbusTcpFrame(transactionId, this.endpoint.unitId, pdu), (error) => {
        if (!error) return;
        const waiting = this.pending.get(transactionId);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(transactionId);
        this.drop(waiting.socket);
        waiting.reject(new ModbusTransportError(`Modbus 请求写入失败：${error.message}`));
      });
    });
  }

  async readCoils(address: number, quantity: number): Promise<boolean[]> {
    return decodeReadBits(await this.request(encodeReadBits(ModbusFunction.ReadCoils, address, quantity)), quantity);
  }

  async readDiscreteInputs(address: number, quantity: number): Promise<boolean[]> {
    return decodeReadBits(await this.request(encodeReadBits(ModbusFunction.ReadDiscreteInputs, address, quantity)), quantity);
  }

  async readHoldingRegisters(address: number, quantity: number): Promise<number[]> {
    return decodeReadRegisters(await this.request(encodeReadRegisters(ModbusFunction.ReadHoldingRegisters, address, quantity)), quantity);
  }

  async readInputRegisters(address: number, quantity: number): Promise<number[]> {
    return decodeReadRegisters(await this.request(encodeReadRegisters(ModbusFunction.ReadInputRegisters, address, quantity)), quantity);
  }

  async writeCoil(address: number, on: boolean): Promise<void> {
    const echo = decodeWriteEcho(await this.request(encodeWriteCoil(address, on)), ModbusFunction.WriteSingleCoil);
    if (echo.address !== address || echo.value !== (on ? 0xff00 : 0)) throw new ModbusTransportError("写线圈响应回显与请求不一致");
  }

  async writeRegister(address: number, value: number): Promise<void> {
    const echo = decodeWriteEcho(await this.request(encodeWriteRegister(address, value)), ModbusFunction.WriteSingleRegister);
    if (echo.address !== address || echo.value !== value) throw new ModbusTransportError("写寄存器响应回显与请求不一致");
  }

  async writeRegisters(address: number, values: number[]): Promise<void> {
    const pdu = await this.request(encodeWriteRegisters(address, values));
    if (isException(pdu)) throw asModbusException(pdu);
    if (pdu.length < 4) throw new ModbusTransportError("写多个寄存器响应被截断");
    if (pdu.readUInt8(0) !== ModbusFunction.WriteMultipleRegisters) throw new ModbusTransportError("写多个寄存器响应功能码不符");
    if (pdu.readUInt16BE(1) !== address || pdu.readUInt16BE(3) !== values.length) throw new ModbusTransportError("写多个寄存器响应回显与请求不一致");
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    for (const [transactionId, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      this.pending.delete(transactionId);
      waiting.reject(new ModbusTransportError("Modbus 客户端已关闭"));
    }
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => socket.end(() => resolve()));
    socket.destroy();
  }

  private connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    const socket = new Socket({ noDelay: true });
    socket.setTimeout(0);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this.onData(socket, chunk));
    socket.on("error", () => { /* 连接失败由 pending 事务的 reject/超时呈现，这里不重复抛 */ });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.failPendingOn(socket, new ModbusTransportError(`与 ${this.endpoint.host}:${this.endpoint.port} 的连接已断开`));
    });
    return new Promise<Socket>((resolve, reject) => {
      // 现场设备常见「IP 通但端口没人听」，SYN 石沉大海：连接也要有超时，不能整轮网关挂住
      const timer = setTimeout(() => {
        this.drop(socket);
        reject(new ModbusTransportError(`连接 ${this.endpoint.host}:${this.endpoint.port} 超过 ${this.endpoint.timeoutMs}ms 未建立`));
      }, this.endpoint.timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new ModbusTransportError(`连接 ${this.endpoint.host}:${this.endpoint.port} 失败：${error.message}`));
      });
      socket.connect({ host: this.endpoint.host, port: this.endpoint.port });
    });
  }

  /** 只在仍持有这条 socket 时断开，避免把刚重连上的新连接误杀 */
  private drop(socket: Socket): void {
    if (this.socket === socket) this.socket = null;
    if (!socket.destroyed) socket.destroy();
  }

  private onData(socket: Socket, chunk: Buffer): void {
    // 重连后旧连接的尾巴数据不进缓冲区，否则新连接会把它当成半帧来定界
    if (this.socket !== socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let taken: ReturnType<typeof takeModbusTcpFrame>;
      try {
        taken = takeModbusTcpFrame(this.buffer);
      } catch (error) {
        // 头都不对（非 Modbus 流量或长度字段坏了）：整条流都不可信，断开重来
        this.drop(socket);
        this.failPendingOn(socket, error instanceof Error ? error : new ModbusTransportError(String(error)));
        return;
      }
      if (!taken) return;
      this.buffer = taken.rest;
      const { transactionId, pdu } = readModbusTcpHeader(taken.frame);
      const waiting = this.pending.get(transactionId);
      // 事务标识撞上但连接不是发出它的那条：这条响应不属于当前任何请求
      if (!waiting || waiting.socket !== socket) continue;
      clearTimeout(waiting.timer);
      this.pending.delete(transactionId);
      waiting.resolve(pdu);
    }
  }

  /** 只拒掉发在这条连接上的待决事务：旧连接断开不能牵连重连后的新事务 */
  private failPendingOn(socket: Socket, error: Error): void {
    for (const [transactionId, waiting] of this.pending) {
      if (waiting.socket !== socket) continue;
      clearTimeout(waiting.timer);
      this.pending.delete(transactionId);
      waiting.reject(error);
    }
  }
}
