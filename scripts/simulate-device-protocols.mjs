#!/usr/bin/env node

import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simulatorFixtures from "../apps/iot-service/src/device-simulator.config.json" with { type: "json" };
import { historyTimestamps, meterM3At, telemetryReadings } from "./device-telemetry.mjs";

const PROTOCOLS = ["HTTP", "MODBUS_TCP", "MQTT", "PLC_MODBUS_TCP", "SIEMENS_S7", "MITSUBISHI_MC", "OPC_UA"];
const MODBUS_WATER_POINTS = Object.freeze({ switchCoil: 0, runFeedbackInput: 0, faultInput: 1, meter: { address: 0, scale: 0.001 } });
const PLC_METER_SCALES = Object.freeze({
  PLC_MODBUS_TCP_WATER_M3: 0.001,
  SIEMENS_S7_WATER_M3: 0.001,
  MITSUBISHI_MC_WATER_M3: 0.001,
  OPC_UA_WATER_M3: 0.001,
});

function usage() {
  console.log(`真机协议模拟客户端\n\n用法: node scripts/simulate-device-protocols.mjs [选项]\n\n选项:\n  --protocol=all|${PROTOCOLS.join("|")}  选择协议，默认 all\n  --host=<地址>       协议服务监听地址，默认 DEVICE_SIM_HOST 或 0.0.0.0\n  --duration=<秒>     运行指定时间后自动退出，默认持续运行\n  --interval=<毫秒>   回调设备取指令间隔，默认 1000\n  --telemetry-interval=<毫秒> 实时遥测上报间隔，默认 10000\n  --history-hours=<小时> 启动时补发最近多少小时遥测，默认 24；0 表示不补发\n  --history-interval=<分钟> 历史遥测采样间隔，默认 15\n  --speed=<倍率>      仅加速 HTTP/MQTT 模拟执行，默认 1\n  --fault-after=<毫秒> 任意设备启动后注入锁定故障，默认不注入\n  --mqtt-url=<URL>    默认 MQTT_URL 或 mqtt://127.0.0.1:1883\n  --help              显示帮助\n\n服务地址与凭据只从环境变量读取，不写入源码:\n  IOT_SERVICE_URL、CONTROL_SERVICE_URL、TELEMETRY_SERVICE_URL\n  TENANT_ID、DEVICE_CALLBACK_TOKEN\n  MQTT_URL、MQTT_DEVICE_USERNAME、MQTT_DEVICE_PASSWORD、MQTT_CA_PATH、MQTT_TOPIC_PREFIX\n  DEVICE_SIM_FLOW_M3H（模拟泵流量，默认 10 m³/h）\n\nDocker app 访问宿主模拟器时，--host 请用 0.0.0.0，设备连接地址改成 host.docker.internal。\n五类现场服务分别监听夹具中的 15020~15024 端口。`);
}

function parseArgs(argv) {
  const options = {
    protocols: PROTOCOLS,
    host: process.env.DEVICE_SIM_HOST?.trim() || "0.0.0.0",
    durationMs: 0,
    intervalMs: 1000,
    telemetryIntervalMs: 10_000,
    historyHours: 24,
    historyIntervalMinutes: 15,
    speed: 1,
    faultAfterMs: 0,
    mqttUrl: process.env.MQTT_URL?.trim() || "mqtt://127.0.0.1:1883",
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) throw new Error(`无法识别参数 ${arg}`);
    const separator = arg.indexOf("=");
    const key = separator < 0 ? arg.slice(2) : arg.slice(2, separator);
    const value = separator < 0 ? "" : arg.slice(separator + 1);
    if (key === "protocol") {
      const selected = value.toUpperCase();
      if (selected !== "ALL" && !PROTOCOLS.includes(selected)) throw new Error(`未知协议 ${value}`);
      options.protocols = selected === "ALL" ? [...PROTOCOLS] : [selected];
    } else if (key === "host") options.host = value.trim();
    else if (key === "duration") options.durationMs = positiveNumber(key, value) * 1000;
    else if (key === "interval") options.intervalMs = positiveNumber(key, value);
    else if (key === "telemetry-interval") options.telemetryIntervalMs = positiveNumber(key, value);
    else if (key === "history-hours") options.historyHours = nonNegativeNumber(key, value);
    else if (key === "history-interval") options.historyIntervalMinutes = positiveNumber(key, value);
    else if (key === "speed") options.speed = positiveNumber(key, value);
    else if (key === "fault-after") options.faultAfterMs = positiveNumber(key, value);
    else if (key === "mqtt-url") options.mqttUrl = value.trim();
    else throw new Error(`未知参数 --${key}`);
  }
  if (!options.host) throw new Error("--host 不能为空");
  if (!options.mqttUrl) throw new Error("--mqtt-url 不能为空");
  return options;
}

function positiveNumber(key, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${key} 必须为正数`);
  return number;
}

function nonNegativeNumber(key, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${key} 必须为非负数`);
  return number;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function endpointAddress(endpoint, fallbackHost) {
  const url = new URL(endpoint.includes("://") ? endpoint : `opc.tcp://${endpoint}`);
  return { host: url.hostname || fallbackHost, port: Number(url.port) };
}

function jsonEnvelope(data) {
  return data && typeof data === "object" && "code" in data && "data" in data ? data.data : data;
}

async function requestJson(baseUrl, path, body, token = process.env.DEVICE_CALLBACK_TOKEN?.trim() || "") {
  const response = await fetch(new URL(path, baseUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(process.env.TENANT_ID?.trim() ? { "x-tenant-id": process.env.TENANT_ID.trim() } : {}),
      ...(token ? { "x-device-token": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== "OK") {
    throw new Error(payload?.message || `HTTP ${response.status} ${response.statusText}`);
  }
  return jsonEnvelope(payload);
}

function normalizeCommand(command) {
  return { ...command, commandId: command.commandId ?? command.id };
}

function commandType(command) {
  return String(command.commandType || command.type || "IRRIGATION").toUpperCase();
}

function planOf(command) {
  const plan = command?.parameters?.plan && typeof command.parameters.plan === "object" ? command.parameters.plan : {};
  return { durationMs: Math.max(0, Number(plan.totalDurationMin || 0) * 60_000) };
}

function meterScale(fixture) {
  if (fixture.protocol === "MODBUS_TCP") return MODBUS_WATER_POINTS.meter.scale;
  if (fixture.protocol === "PLC_MODBUS_TCP" || fixture.protocol === "SIEMENS_S7" || fixture.protocol === "MITSUBISHI_MC" || fixture.protocol === "OPC_UA") {
    return PLC_METER_SCALES[fixture.plc.profile];
  }
  return 1;
}

function createState(fixture, options) {
  const flow = Number(process.env.DEVICE_SIM_FLOW_M3H?.trim() || 10);
  if (!Number.isFinite(flow) || flow <= 0) throw new Error("DEVICE_SIM_FLOW_M3H 必须为正数");
  const startedAt = Date.now();
  const state = {
    fixture,
    scale: meterScale(fixture),
    flowM3h: flow,
    startedAt,
    switchOn: false,
    faulted: false,
    faultedMessage: "",
    counts: 0,
    lastMeterAt: startedAt,
    jobs: new Map(),
    completedCommands: new Map(),
    faultTimer: null,
    mqttClient: null,
    mqttTelemetryTopic: "",
    mqttCommandTimer: null,
    opcSwitchRequested: false,
  };
  state.counts = Math.min(0xffffffff, meterM3At(state, startedAt) / state.scale);
  if (options.faultAfterMs > 0) {
    state.faultTimer = setTimeout(() => {
      stateFault(state, `模拟器在 ${options.faultAfterMs}ms 后注入锁定故障`);
    }, options.faultAfterMs);
  }
  return state;
}

function stateFault(state, message) {
  state.faulted = true;
  state.faultedMessage = message;
  clearTimeout(state.faultTimer);
  state.faultTimer = null;
  log(`${state.fixture.deviceNo} 故障: ${message}`);
}

function advanceMeter(state) {
  const now = Date.now();
  const elapsed = Math.max(0, now - state.lastMeterAt) / 1000;
  state.lastMeterAt = now;
  if (!state.switchOn || state.faulted || elapsed === 0) return;
  state.counts = Math.min(0xffffffff, state.counts + elapsed * state.flowM3h / 3600 / state.scale);
}

function applySwitch(state, on) {
  advanceMeter(state);
  const effective = on && !state.faulted;
  if (state.switchOn === effective) return;
  state.switchOn = effective;
  log(`${state.fixture.deviceNo} 硬件开关 -> ${effective ? "ON" : "OFF"}${state.faulted ? "（保持锁定故障）" : ""}`);
  if (on && state.faulted) log(`${state.fixture.deviceNo} 已阻止在故障状态启动`);
}

function callbackReceipt(state, command, status, message = "", result = {}) {
  return {
    commandId: command.commandId,
    deviceId: state.fixture.deviceId,
    status,
    ...(message ? { message } : {}),
    ...(Object.keys(result).length > 0 ? { result } : {}),
    at: new Date().toISOString(),
  };
}

async function postReceipt(state, receipt) {
  await requestJson(process.env.CONTROL_SERVICE_URL?.trim() || "http://127.0.0.1:3008", "/api/v1/control/device/receipt", receipt);
}

function createCallbackJob(state, command, paused = false) {
  const plan = command?.parameters?.plan && typeof command.parameters.plan === "object" ? command.parameters.plan : {};
  const target = Number(command?.parameters?.targetWaterVolume ?? plan.totalWaterVolume ?? 0);
  const baseline = state.counts;
  return {
    command,
    baseline,
    targetCounts: Number.isFinite(target) && target > 0 ? target / state.scale : 0,
    startedAt: Date.now(),
    paused,
    pausedAt: paused ? Date.now() : 0,
    pausedMs: 0,
    initialSwitch: state.switchOn,
  };
}

function stopOtherJobs(state, commandId) {
  for (const id of state.jobs.keys()) {
    if (id !== commandId) state.jobs.delete(id);
  }
}

function callbackDone(state, job) {
  const command = job.command;
  const plan = planOf(command);
  advanceMeter(state);
  const counts = Math.max(0, state.counts - job.baseline);
  const result = {
    deviceId: state.fixture.deviceId,
    meterValue: state.counts * state.scale,
    waterVolumeM3: counts * state.scale,
    durationMin: Number((Math.max(0, Date.now() - job.startedAt - job.pausedMs) / 60_000).toFixed(2)),
  };
  if (["ESTOP", "POWER_OFF"].includes(commandType(command))) {
    state.switchOn = false;
    result.confirmed = !state.switchOn;
  }
  state.jobs.delete(command.commandId);
  return result;
}

async function tickCallback(state, options) {
  advanceMeter(state);
  if (state.jobs.size > 0) {
    for (const job of state.jobs.values()) {
      const command = job.command;
      const type = commandType(command);
      if (type === "PAUSE" || type === "RESUME") {
        await postReceipt(state, callbackReceipt(state, command, "DONE"));
        state.jobs.delete(command.commandId);
      } else if (state.faulted) {
        state.switchOn = false;
        await postReceipt(state, callbackReceipt(state, command, "FAILED", state.faultedMessage || "模拟设备报告硬件故障", callbackDone(state, job)));
      } else if (type === "IRRIGATION" || type === "FERTILIZATION") {
        const elapsed = Date.now() - job.startedAt - job.pausedMs;
        const targetReached = job.targetCounts > 0 && state.counts - job.baseline >= job.targetCounts;
        if (targetReached || (job.targetCounts === 0 && elapsed >= planOf(command).durationMs / options.speed)) {
          state.switchOn = false;
          await postReceipt(state, callbackReceipt(state, command, "DONE", "", callbackDone(state, job)));
        }
      }
    }
  }

  const controlUrl = process.env.CONTROL_SERVICE_URL?.trim() || "http://127.0.0.1:3008";
  const page = await requestJson(controlUrl, `/api/v1/control/device/pending?deviceId=${encodeURIComponent(state.fixture.deviceId)}`);
  for (const rawCommand of page.items ?? []) {
    const command = normalizeCommand(rawCommand);
    if (state.jobs.has(command.commandId)) continue;
    const type = commandType(command);
    await requestJson(controlUrl, "/api/v1/control/device/dispatch", { commandId: command.id, deviceId: state.fixture.deviceId });
    if (type === "PAUSE") {
      const target = state.jobs.get(command.parameters?.targetCommandId);
      if (!target) {
        await postReceipt(state, callbackReceipt(state, command, "FAILED", "目标指令不存在或已结束，无法暂停"));
        continue;
      }
      target.paused = true;
      target.pausedAt = Date.now();
      state.switchOn = false;
      state.jobs.set(command.commandId, createCallbackJob(state, command, true));
      await postReceipt(state, callbackReceipt(state, command, "ACKED"));
    } else if (type === "RESUME") {
      const target = state.jobs.get(command.parameters?.targetCommandId);
      if (!target || !target.paused) {
        await postReceipt(state, callbackReceipt(state, command, "FAILED", "目标指令不存在或未暂停，无法恢复"));
        continue;
      }
      if (state.faulted) {
        await postReceipt(state, callbackReceipt(state, command, "FAILED", state.faultedMessage || "模拟设备报告硬件故障"));
        continue;
      }
      target.pausedMs += Date.now() - target.pausedAt;
      target.paused = false;
      applySwitch(state, true);
      state.jobs.set(command.commandId, createCallbackJob(state, command));
      await postReceipt(state, callbackReceipt(state, command, "ACKED"));
    } else {
      if (state.faulted) {
        await postReceipt(state, callbackReceipt(state, command, "FAILED", state.faultedMessage || "模拟设备报告硬件故障"));
        continue;
      }
      const job = createCallbackJob(state, command);
      state.jobs.set(command.commandId, job);
      if (type === "ESTOP" || type === "POWER_OFF") {
        state.switchOn = false;
        stopOtherJobs(state, command.commandId);
        const result = callbackDone(state, job);
        await postReceipt(state, callbackReceipt(state, command, "DONE", "", result));
      } else if (type !== "IRRIGATION" && type !== "FERTILIZATION") {
        const result = callbackDone(state, job);
        await postReceipt(state, callbackReceipt(state, command, "DONE", "", result));
      } else {
        applySwitch(state, true);
        await postReceipt(state, callbackReceipt(state, command, "ACKED"));
      }
    }
  }
}

function listen(server, port, host, label) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function destroySockets(sockets) {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}

function tcpServer(label, handler) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => log(`${label} 连接异常: ${error.message}`));
    handler(socket);
  });
  return { server, sockets };
}

function modbusAddress(fixture) {
  const endpoint = new URL(`modbus://${fixture.binding.host}:${fixture.binding.port}`);
  return { host: endpoint.hostname, port: Number(endpoint.port) };
}

async function startModbus(state, options) {
  const fixture = state.fixture;
  const plc = fixture.protocol === "PLC_MODBUS_TCP";
  const points = plc
    ? { switchCoil: fixture.plc.switchPoint, runFeedbackInput: fixture.plc.runFeedbackPoint, faultInput: fixture.plc.faultPoint, meter: { address: fixture.plc.meterPoint } }
    : MODBUS_WATER_POINTS;
  const endpoint = plc
    ? { host: fixture.plc.host, port: fixture.plc.port }
    : modbusAddress(fixture);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => log(`${fixture.deviceNo} Modbus 异常: ${error.message}`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const length = buffer.readUInt16BE(4);
        if (length < 6 || buffer.length < length + 6) break;
        const packet = buffer.subarray(0, length + 6);
        buffer = buffer.subarray(length + 6);
        if (packet[6] !== (fixture.binding?.unitId ?? fixture.plc?.unitId ?? 1)) continue;
        const response = handleModbus(packet, state, points);
        if (response) socket.write(response);
      }
    });
  });
  await listen(server, endpoint.port, options.host, fixture.deviceNo);
  log(`${fixture.deviceNo} Modbus TCP 监听 ${options.host}:${endpoint.port}`);
  return async () => {
    destroySockets(sockets);
    await closeServer(server);
  };
}

function handleModbus(packet, state, points) {
  const functionCode = packet[7];
  const header = packet.subarray(0, 7);
  const unit = packet[6];
  if (functionCode === 2) {
    const address = packet.readUInt16BE(8);
    const count = packet.readUInt16BE(10);
    const bits = Buffer.alloc(Math.ceil(count / 8));
    for (let index = 0; index < count; index++) {
      const value = address + index === points.runFeedbackInput ? state.switchOn : address + index === points.faultInput ? state.faulted : false;
      if (value) bits[index >> 3] |= 1 << (index & 7);
    }
    const data = Buffer.concat([Buffer.from([functionCode, bits.length]), bits]);
    const response = Buffer.alloc(7 + data.length);
    header.copy(response);
    response.writeUInt16BE(data.length + 1, 4);
    unit && response.writeUInt8(unit, 6);
    data.copy(response, 7);
    return response;
  }
  if (functionCode === 3) {
    const address = packet.readUInt16BE(8);
    const count = packet.readUInt16BE(10);
    advanceMeter(state);
    const value = state.counts;
    const bytes = Buffer.alloc(count * 2);
    for (let index = 0; index < count; index++) bytes.writeUInt16BE(Math.floor(value / 2 ** (16 * (count - index - 1))) & 0xffff, index * 2);
    const data = Buffer.concat([Buffer.from([functionCode, bytes.length]), bytes]);
    const response = Buffer.alloc(7 + data.length);
    header.copy(response);
    response.writeUInt16BE(data.length + 1, 4);
    data.copy(response, 7);
    return response;
  }
  if (functionCode === 5) {
    const address = packet.readUInt16BE(8);
    if (address !== points.switchCoil) return null;
    const raw = packet.readUInt16BE(10);
    if (raw !== 0xff00 && raw !== 0x0000) return null;
    applySwitch(state, raw === 0xff00);
    const response = Buffer.from(packet.subarray(0, 12));
    response.writeUInt16BE(6, 4);
    return response;
  }
  return null;
}

function s7Storage(state) {
  state.s7Storage ??= new Map();
  return state.s7Storage;
}

function s7Block(state, area, db) {
  const storage = s7Storage(state);
  const key = `${area}:${db}`;
  if (!storage.has(key)) storage.set(key, Buffer.alloc(4096));
  return storage.get(key);
}

function s7BooleanPoint(value) {
  const match = /^(DB\d+|M),X(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) throw new Error(`不支持的 S7 BOOL 点位 ${value}`);
  const bit = Number(match[3] ?? 0);
  const byte = Number(match[2]);
  return { area: match[1] === "M" ? "M" : "DB", db: match[1] === "M" ? 0 : Number(match[1].slice(2)), byte, bit, address: byte * 8 + bit };
}

function s7MeterPoint(value) {
  const match = /^(DB\d+),INT(\d+)$/.exec(String(value));
  if (!match) throw new Error(`不支持的 S7 UINT32 计量点位 ${value}`);
  return { area: "DB", db: Number(match[1].slice(2)), byte: Number(match[2]) * 2 };
}

function s7Read(state, area, db, address, length) {
  const start = Math.floor(address / 8);
  const result = Buffer.alloc(length);
  s7Block(state, area, db).copy(result, 0, start, start + length);
  for (const [key, value] of [["switchPoint", state.switchOn], ["runFeedbackPoint", state.switchOn], ["faultPoint", state.faulted]]) {
    const point = s7BooleanPoint(state.fixture.plc[key]);
    const index = point.byte - start;
    if (point.area === area && point.db === db && index >= 0 && index < length) {
      result[index] = value ? result[index] | (1 << point.bit) : result[index] & ~(1 << point.bit);
    }
  }
  const meter = s7MeterPoint(state.fixture.plc.meterPoint);
  if (meter.area === area && meter.db === db && address >= meter.byte * 8 && address + length * 8 <= meter.byte * 8 + 32) {
    advanceMeter(state);
    const firstWord = (address - meter.byte * 8) / 16;
    for (let index = 0; index < length / 2; index++) result.writeUInt16BE(Math.floor(state.counts / 2 ** (16 * (1 - firstWord - index))) & 0xffff, index * 2);
  }
  return result;
}

function s7Write(state, area, db, address, transport, payload) {
  const point = s7BooleanPoint(state.fixture.plc.switchPoint);
  if (transport !== 1 || payload.length !== 1 || point.area !== area || point.db !== db || point.address !== address) return false;
  applySwitch(state, Boolean(payload[0] & (1 << point.bit)));
  return true;
}

function s7Response(request, state, write) {
  const count = request[18];
  const items = [];
  let requestDataOffset = 19 + count * 12;
  if (requestDataOffset % 2) requestDataOffset += 1;
  for (let index = 0; index < count; index++) {
    const offset = 19 + index * 12;
    const specification = request.subarray(offset, offset + 12);
    const area = ({ 0x04: "DB", 0x01: "I", 0x02: "Q", 0x03: "M" })[specification[8] & 0x1f];
    const db = specification.readUInt16BE(6);
    const address = specification.readUInt32BE(8) & 0x03ffffff;
    const length = specification.readUInt16BE(4);
    if (write) {
      const transport = specification[3];
      const payloadLength = transport === 1 ? Math.ceil(length / 8) : length;
      const payload = request.subarray(requestDataOffset + 3, requestDataOffset + 3 + payloadLength);
      items.push({ ok: s7Write(state, area, db, address, transport, payload) });
      requestDataOffset += 3 + payloadLength;
      if (requestDataOffset % 2) requestDataOffset += 1;
    } else {
      const bytes = Buffer.from(s7Read(state, area, db, address, length));
      const item = Buffer.alloc(5 + bytes.length + (bytes.length % 2));
      item[0] = 0xff;
      item[1] = 4;
      item.writeUInt16BE(bytes.length * 8, 2);
      bytes.copy(item, 4);
      items.push(item);
    }
  }
  const dataLength = write ? count : items.reduce((total, item) => total + item.length, 0);
  const response = Buffer.alloc(21 + dataLength);
  response[0] = 3;
  response[4] = 2;
  response[5] = 0xf0;
  response[6] = 0x80;
  response[7] = 0x32;
  response[8] = 3;
  request.copy(response, 11, 11, 13);
  response.writeUInt16BE(2, 13);
  response.writeUInt16BE(dataLength, 15);
  response[18] = write ? 5 : 4;
  response[19] = count;
  let offset = 21;
  for (const item of items) {
    if (write) response[offset++] = item.ok ? 0xff : 0x00;
    else {
      item.copy(response, offset);
      offset += item.length;
    }
  }
  response.writeUInt16BE(response.length, 2);
  return response;
}

async function startS7(state, options) {
  const endpoint = { host: state.fixture.plc.host, port: state.fixture.plc.port };
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let connected = false;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => log(`${state.fixture.deviceNo} S7 异常: ${error.message}`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt16BE(2);
        if (length < 4 || buffer.length < length) break;
        const packet = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        if (!connected) {
          if (packet[5] !== 0xe0 || length < 22) return socket.destroy();
          const confirmation = Buffer.from(packet.subarray(0, 22));
          confirmation[5] = 0xd0;
          confirmation.writeUInt16BE(packet.readUInt16BE(8), 6);
          confirmation.writeUInt16BE(packet.readUInt16BE(6), 8);
          socket.write(confirmation);
          connected = true;
        } else if (packet[5] === 0xf0 && packet[7] === 0x32 && packet[18] === 0) {
          const confirmation = Buffer.from([0x03, 0x00, 0x00, 0x1b, 0x02, 0xf0, 0x80, 0x32, 0x03, 0x00, 0x00, packet[11], packet[12], 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xf0]);
          socket.write(confirmation);
        } else if (packet[7] === 0x32 && packet.length >= 31) {
          socket.write(s7Response(packet, state, packet.readUInt16BE(15) > 0));
        }
      }
    });
  });
  await listen(server, endpoint.port, options.host, state.fixture.deviceNo);
  log(`${state.fixture.deviceNo} Siemens S7comm 监听 ${options.host}:${endpoint.port}`);
  return async () => {
    destroySockets(sockets);
    await closeServer(server);
  };
}

function mcState(state, area) {
  state.mc ??= { D: new Map(), M: new Map() };
  state.mc[area] ??= new Map();
  return state.mc[area];
}

function mcWord(state, area, offset) {
  const meter = /^([DR])(\d+)$/.exec(state.fixture.plc.meterPoint);
  if (meter && area === meter[1]) {
    const wordOffset = offset - Number(meter[2]);
    if (wordOffset === 0 || wordOffset === 1) {
      advanceMeter(state);
      return Math.floor(state.counts / 2 ** (16 * (1 - wordOffset))) & 0xffff;
    }
  }
  return mcState(state, area).get(offset) || 0;
}

function mcRead(state, area, offset, count) {
  if (!area) return null;
  const buffer = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++) buffer.writeUInt16LE(mcWord(state, area, offset + index), index * 2);
  for (const [key, value] of [["runFeedbackPoint", state.switchOn], ["faultPoint", state.faulted]]) {
    const match = /^([A-Z]+)(\d+)$/.exec(state.fixture.plc[key]);
    if (!match || area !== match[1] || offset > Number(match[2]) || offset + count * 16 <= Number(match[2])) continue;
    const bit = Number(match[2]) - offset;
    if (value) buffer[Math.floor(bit / 8)] |= 1 << (bit % 8);
    else buffer[Math.floor(bit / 8)] &= ~(1 << (bit % 8));
  }
  return Buffer.concat([Buffer.from([0x81, 0x00]), buffer]);
}

function mcWrite(state, packet) {
  const functionCode = packet[0];
  const areaCode = packet.readUInt16LE(8);
  const area = ({ 0x4420: "D", 0x4d20: "M" })[areaCode];
  const offset = packet.readUInt32LE(4);
  const count = packet[10];
  if (!area) return null;
  if (functionCode === 2) {
    const switchPoint = /^([A-Z]+)(\d+)$/.exec(state.fixture.plc.switchPoint);
    if (!switchPoint || area !== switchPoint[1] || offset !== Number(switchPoint[2])) return null;
    applySwitch(state, packet[12] === 0x10);
    const response = Buffer.alloc(10);
    response[0] = 0x82;
    return response;
  }
  if (functionCode === 3) {
    for (let index = 0; index < count; index++) mcState(state, area).set(offset + index, packet.readUInt16LE(12 + index * 2));
    const response = Buffer.alloc(10);
    response[0] = 0x83;
    return response;
  }
  return null;
}

function mcFrameSize(packet) {
  if (packet[0] === 1) return 12;
  if (packet[0] === 2) return 13;
  return 12 + packet[10] * 2;
}

async function startMitsubishi(state, options) {
  const endpoint = { host: state.fixture.plc.host, port: state.fixture.plc.port };
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let ascii = false;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => log(`${state.fixture.deviceNo} MC 异常: ${error.message}`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 2 && buffer[0] === 0x30 && buffer[1] === 0x31) ascii = true;
      while (buffer.length >= 2) {
        if (ascii) {
          if (buffer.length < 24 || !/^[0-9a-f]+$/i.test(buffer.toString("ascii", 0, 24))) return;
          const packet = Buffer.from(buffer.toString("ascii", 0, 24), "hex");
          const size = mcFrameSize(packet);
          if (buffer.length < size * 2) return;
          const asciiRequest = Buffer.from(buffer.toString("ascii", 0, size * 2), "hex");
          buffer = buffer.subarray(size * 2);
          const raw = Buffer.from(asciiRequest);
          raw.writeUInt16LE(asciiRequest.readUInt16BE(4), 8);
          raw.writeUInt32LE(asciiRequest.readUInt32BE(6), 4);
          const area = ({ 0x4420: "D", 0x4d20: "M" })[raw.readUInt16LE(8)];
          const response = raw[0] === 1 ? mcRead(state, area, raw.readUInt32LE(4), raw[10]) : mcWrite(state, raw);
          if (response) socket.write(response.toString("hex").toUpperCase());
        } else {
          if (buffer.length < 12) return;
          const size = mcFrameSize(buffer);
          if (buffer.length < size) return;
          const raw = Buffer.from(buffer.subarray(0, size));
          buffer = buffer.subarray(size);
          const area = ({ 0x4420: "D", 0x4d20: "M" })[raw.readUInt16LE(8)];
          const offset = raw.readUInt32LE(4);
          const response = raw[0] === 1 ? mcRead(state, area, offset, raw[10]) : mcWrite(state, raw);
          if (response) socket.write(response);
        }
      }
    });
  });
  await listen(server, endpoint.port, options.host, state.fixture.deviceNo);
  log(`${state.fixture.deviceNo} Mitsubishi MC 监听 ${options.host}:${endpoint.port}`);
  return async () => {
    destroySockets(sockets);
    await closeServer(server);
  };
}

async function startOpcUa(state, options) {
  const require = createRequire(new URL("../apps/iot-service/package.json", import.meta.url));
  const { OPCUAServer, OPCUACertificateManager, DataType, AccessLevelFlag, Variant, StatusCodes, MessageSecurityMode, SecurityPolicy, UserTokenType } = require("node-opcua");
  const endpoint = endpointAddress(state.fixture.plc.endpointUrl, options.host);
  const directory = await mkdtemp(join(tmpdir(), "agri-opcua-sim-"));
  const manager = new OPCUACertificateManager({ rootFolder: join(directory, "PKI") });
  const server = new OPCUAServer({
    port: endpoint.port,
    host: options.host,
    resourcePath: "/",
    buildInfo: { productName: "Agri Device Protocol Simulator", buildNumber: "1", buildDate: new Date() },
    serverInfo: { applicationUri: `urn:agri:simulator:${state.fixture.deviceId}`, productUri: "urn:agri:device-simulator", applicationName: { text: "Agri Device Protocol Simulator" } },
    allowAnonymous: true,
    userTokenTypes: [UserTokenType.Anonymous],
    securityModes: [MessageSecurityMode.None],
    securityPolicies: [SecurityPolicy.None],
    endpoints: [{ port: endpoint.port, host: options.host, resourcePath: "/", securityMode: MessageSecurityMode.None, securityPolicy: SecurityPolicy.None, userTokenTypes: [UserTokenType.Anonymous] }],
    serverCertificateManager: manager,
  });
  try {
    await server.initialize();
    const namespace = server.engine.addressSpace.registerNamespace("urn:agri:device-simulator");
    const device = namespace.addObject({ browseName: "IrrigationPump", displayName: state.fixture.name });
    const common = { componentOf: device, minimumSamplingInterval: 100 };
    const writable = { ...common, accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite, userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite };
    const readable = { ...common, accessLevel: AccessLevelFlag.CurrentRead, userAccessLevel: AccessLevelFlag.CurrentRead };
    const switchNode = namespace.addVariable({ ...writable, nodeId: state.fixture.plc.switchPoint, browseName: "Switch", dataType: DataType.Boolean, value: {
      get: () => new Variant({ dataType: DataType.Boolean, value: state.opcSwitchRequested }),
      set: (variant) => {
        state.opcSwitchRequested = typeof variant === "boolean" ? variant : Boolean(variant.value);
        return StatusCodes.Good;
      },
    } });
    const runNode = namespace.addVariable({ ...readable, nodeId: state.fixture.plc.runFeedbackPoint, browseName: "RunFeedback", dataType: DataType.Boolean, value: { get: () => new Variant({ dataType: DataType.Boolean, value: state.switchOn }) } });
    const faultNode = namespace.addVariable({ ...readable, nodeId: state.fixture.plc.faultPoint, browseName: "Fault", dataType: DataType.Boolean, value: { get: () => new Variant({ dataType: DataType.Boolean, value: state.faulted }) } });
    const meterNode = namespace.addVariable({ ...readable, nodeId: state.fixture.plc.meterPoint, browseName: "WaterMeter", dataType: DataType.UInt32, value: { get: () => {
      advanceMeter(state);
      return new Variant({ dataType: DataType.UInt32, value: Math.floor(state.counts) });
    } } });
    state.opcSyncTimer = setInterval(() => {
      if (state.opcSwitchRequested !== state.switchOn) applySwitch(state, state.opcSwitchRequested);
      state.opcSwitchRequested = state.switchOn;
      runNode.setValueFromSource(new Variant({ dataType: DataType.Boolean, value: state.switchOn }), StatusCodes.Good);
      faultNode.setValueFromSource(new Variant({ dataType: DataType.Boolean, value: state.faulted }), StatusCodes.Good);
      advanceMeter(state);
      meterNode.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: Math.floor(state.counts) }), StatusCodes.Good);
    }, 100);
    await server.start();
    log(`${state.fixture.deviceNo} OPC UA 监听 ${state.fixture.plc.endpointUrl}`);
    return async () => {
      clearInterval(state.opcSyncTimer);
      state.opcSyncTimer = null;
      await server.shutdown();
      await rm(directory, { recursive: true, force: true });
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function publishMqttReceipt(state, client, topic, receipt) {
  const payload = JSON.stringify(receipt);
  if (["DONE", "FAILED", "CANCELLED"].includes(receipt.status)) {
    state.completedCommands.set(receipt.commandId, payload);
    if (state.completedCommands.size > 1000) state.completedCommands.delete(state.completedCommands.keys().next().value);
  }
  client.publish(topic, payload, { qos: 1 });
}

async function startMqtt(state, options) {
  const require = createRequire(new URL("../apps/iot-service/package.json", import.meta.url));
  const mqtt = require("mqtt");
  const fixture = state.fixture;
  const username = process.env.MQTT_DEVICE_USERNAME?.trim();
  const password = process.env.MQTT_DEVICE_PASSWORD;
  if (!username || !password) {
    throw new Error("MQTT 模拟器需配置独立设备账号 MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD，不能复用服务账号");
  }
  if (username === process.env.MQTT_USERNAME?.trim()) {
    throw new Error("MQTT 模拟器不能复用服务账号 MQTT_USERNAME");
  }
  const tenantId = process.env.TENANT_ID?.trim() || "tenant-demo";
  const prefix = process.env.MQTT_TOPIC_PREFIX?.trim() || "agri";
  const commandTopic = `${prefix}/${tenantId}/${fixture.deviceNo}/command`;
  const telemetryTopic = `${prefix}/${tenantId}/${fixture.deviceNo}/telemetry`;
  const receiptTopic = `${prefix}/${tenantId}/${fixture.deviceNo}/receipt`;
  const client = mqtt.connect(options.mqttUrl, {
    clientId: `agri-sim-${fixture.deviceId}-${process.pid}`,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 5000,
    username,
    password,
    ...(process.env.MQTT_CA_PATH?.trim() ? { ca: [await (await import("node:fs/promises")).readFile(process.env.MQTT_CA_PATH.trim())], rejectUnauthorized: true } : {}),
  });
  client.on("error", (error) => log(`${fixture.deviceNo} MQTT 异常: ${error.message}`));
  client.on("message", async (topic, payload) => {
    if (topic !== commandTopic) return;
    try {
      const command = normalizeCommand(JSON.parse(payload.toString("utf8")));
      const completed = state.completedCommands.get(command.commandId);
      if (completed !== undefined) {
        client.publish(receiptTopic, completed, { qos: 1 });
        return;
      }
      const type = commandType(command);
      if (type === "PAUSE") {
        const target = state.jobs.get(command.parameters?.targetCommandId);
        if (!target) {
          publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "FAILED", "目标指令不存在或已结束，无法暂停"));
          return;
        }
        target.paused = true;
        target.pausedAt = Date.now();
        state.switchOn = false;
        state.jobs.set(command.commandId, createCallbackJob(state, command, true));
        publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "ACKED"));
      } else if (type === "RESUME") {
        const target = state.jobs.get(command.parameters?.targetCommandId);
        if (!target || !target.paused) {
          publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "FAILED", "目标指令不存在或未暂停，无法恢复"));
          return;
        }
        if (state.faulted) {
          publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "FAILED", state.faultedMessage || "模拟设备报告硬件故障"));
          return;
        }
        target.pausedMs += Date.now() - target.pausedAt;
        target.paused = false;
        applySwitch(state, true);
        state.jobs.set(command.commandId, createCallbackJob(state, command));
        publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "ACKED"));
      } else if (state.faulted) {
        publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "FAILED", state.faultedMessage || "模拟设备报告硬件故障"));
      } else {
        const job = createCallbackJob(state, command);
        state.jobs.set(command.commandId, job);
        if (type === "ESTOP" || type === "POWER_OFF" || (type !== "IRRIGATION" && type !== "FERTILIZATION")) {
          if (type === "ESTOP" || type === "POWER_OFF") {
            state.switchOn = false;
            stopOtherJobs(state, command.commandId);
          }
          publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "DONE", "", callbackDone(state, job)));
        } else {
          applySwitch(state, true);
          publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "ACKED"));
        }
      }
    } catch (error) {
      log(`${fixture.deviceNo} MQTT 指令处理失败: ${error.message}`);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MQTT 连接超时")), 10_000);
    client.once("connect", () => {
      clearTimeout(timer);
      client.subscribe(commandTopic, { qos: 1 }, (error) => error ? reject(error) : resolve());
    });
    client.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  log(`${fixture.deviceNo} MQTT 已连接 ${options.mqttUrl}，订阅 ${commandTopic}`);
  state.mqttClient = client;
  state.mqttTelemetryTopic = telemetryTopic;
  state.mqttCommandTimer = setInterval(() => {
    advanceMeter(state);
    for (const job of state.jobs.values()) {
      const command = job.command;
      const type = commandType(command);
      if (type === "PAUSE" || type === "RESUME") {
        publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "DONE"));
        state.jobs.delete(command.commandId);
      } else if (state.faulted) {
        state.switchOn = false;
        publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "FAILED", state.faultedMessage || "模拟设备报告硬件故障", callbackDone(state, job)));
      } else if (type === "IRRIGATION" || type === "FERTILIZATION") {
        const elapsed = Date.now() - job.startedAt - job.pausedMs;
        if ((job.targetCounts > 0 && state.counts - job.baseline >= job.targetCounts) || (job.targetCounts === 0 && elapsed >= planOf(command).durationMs / options.speed)) {
          state.switchOn = false;
          publishMqttReceipt(state, client, receiptTopic, callbackReceipt(state, command, "DONE", "", callbackDone(state, job)));
        }
      }
    }
  }, options.intervalMs);
  return async () => {
    clearInterval(state.mqttCommandTimer);
    state.mqttCommandTimer = null;
    state.mqttClient = null;
    state.mqttTelemetryTopic = "";
    await new Promise((resolve) => client.end(false, {}, resolve));
  };
}

async function reportReadings(state, readings) {
  if (state.fixture.protocol === "MQTT") {
    for (const reading of readings) {
      state.mqttClient.publish(state.mqttTelemetryTopic, JSON.stringify(reading), { qos: 1 });
    }
    return;
  }
  const telemetryUrl = process.env.TELEMETRY_SERVICE_URL?.trim() || "http://127.0.0.1:3004";
  await Promise.all(readings.map((reading) => requestJson(telemetryUrl, "/api/v1/telemetry/report", reading)));
}

async function backfillTelemetry(states, options) {
  const timestamps = historyTimestamps(Date.now(), options.historyHours, options.historyIntervalMinutes);
  const tasks = [];
  for (const state of states) {
    const samples = timestamps.map((at) => telemetryReadings(state, at));
    for (let index = 0; index < (samples[0]?.length ?? 0); index += 1) {
      tasks.push(async () => {
        for (const sample of samples) await reportReadings(state, [sample[index]]);
      });
    }
  }
  let cursor = 0;
  let completed = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && cursor < tasks.length) {
      const task = tasks[cursor++];
      try {
        await task();
        completed += 1;
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, () => worker()));
  if (failure) {
    log(`历史遥测补发中断: ${failure.message}`);
    return false;
  }
  log(`历史遥测补发完成: ${states.length} 台设备，${timestamps.length} 个采样点，${completed} 条指标序列`);
  return true;
}

async function startTelemetryReporter(states, options) {
  let reporting = false;
  const report = async () => {
    if (reporting) return;
    reporting = true;
    try {
      const at = Date.now();
      for (const state of states) {
        try {
          advanceMeter(state);
          await reportReadings(state, telemetryReadings(state, at));
        } catch (error) {
          log(`${state.fixture.deviceNo} 实时遥测上报失败: ${error.message}`);
        }
      }
    } finally {
      reporting = false;
    }
  };
  await report();
  const timer = setInterval(() => void report(), options.telemetryIntervalMs);
  return async () => clearInterval(timer);
}

async function heartbeat(state, status) {
  try {
    await requestJson(process.env.IOT_SERVICE_URL?.trim() || "http://127.0.0.1:3003", "/api/v1/device/heartbeat", { deviceId: state.fixture.deviceId, status });
    log(`${state.fixture.deviceNo} 心跳 -> ${status}`);
  } catch (error) {
    log(`${state.fixture.deviceNo} 心跳失败: ${error.message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const selected = simulatorFixtures.filter((fixture) => options.protocols.includes(fixture.protocol));
  const states = selected.map((fixture) => createState(fixture, options));
  const stops = [];
  let stopping = false;
  let timer = null;

  const shutdown = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    for (const state of states) {
      clearTimeout(state.faultTimer);
      if (state.mqttCommandTimer) clearInterval(state.mqttCommandTimer);
      if (state.opcSyncTimer) clearInterval(state.opcSyncTimer);
    }
    for (const stop of stops.reverse()) await stop().catch((error) => log(`停止失败: ${error.message}`));
    for (const state of states) await heartbeat(state, "OFFLINE");
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  try {
    for (const state of states) {
      switch (state.fixture.protocol) {
        case "MODBUS_TCP":
        case "PLC_MODBUS_TCP":
          stops.push(await startModbus(state, options));
          break;
        case "SIEMENS_S7":
          stops.push(await startS7(state, options));
          break;
        case "MITSUBISHI_MC":
          stops.push(await startMitsubishi(state, options));
          break;
        case "OPC_UA":
          stops.push(await startOpcUa(state, options));
          break;
        case "HTTP":
          stops.push(async () => {});
          break;
        case "MQTT":
          stops.push(await startMqtt(state, options));
          break;
      }
      await heartbeat(state, "ONLINE");
    }

    if (options.historyHours > 0) await backfillTelemetry(states, options);
    stops.push(await startTelemetryReporter(states, options));

    const httpStates = states.filter((state) => state.fixture.protocol === "HTTP");
    if (httpStates.length > 0) {
      let running = false;
      let httpTimer = null;
      stops.push(async () => {});
      const tick = async () => {
        if (stopping || running) return;
        running = true;
        try {
          for (const state of httpStates) await tickCallback(state, options);
        } catch (error) {
          log(`HTTP 模拟链路异常: ${error.message}`);
        } finally {
          running = false;
        }
      };
      await tick();
      httpTimer = setInterval(tick, options.intervalMs);
      stops.push(async () => clearInterval(httpTimer));
    }

    log(`已启动 ${states.length} 个协议模拟设备；Ctrl+C 安全退出`);
    if (options.durationMs > 0) timer = setTimeout(() => void shutdown(), options.durationMs);
  } catch (error) {
    log(`启动失败: ${error.stack || error.message}`);
    await shutdown(1);
  }
}

await main();
