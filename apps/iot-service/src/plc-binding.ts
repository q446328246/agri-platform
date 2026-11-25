import type { DeviceType } from "./device.repository.js";
import type { MqttConfigCipher } from "./mqtt-config.js";

export const PLC_PROTOCOLS = ["PLC_MODBUS_TCP", "SIEMENS_S7", "MITSUBISHI_MC", "OPC_UA"] as const;
export type PlcProtocol = (typeof PLC_PROTOCOLS)[number];
export type PlcPoint = number | string;
export type PlcMeterType = "UINT32" | "REAL";
export type PlcMeterUnit = "m³" | "L";
export type PlcWordOrder = "HIGH_FIRST" | "LOW_FIRST";

export interface PlcMeter {
  dataType: PlcMeterType;
  wordOrder: PlcWordOrder;
  scale: number;
  unit: PlcMeterUnit;
}

export interface PlcProfile {
  key: string;
  label: string;
  protocol: PlcProtocol;
  applicableTypes: DeviceType[];
  pointHint: string;
  meterPointHint: string;
  meter: PlcMeter | null;
}

export interface PlcEndpoint {
  host: string;
  port: number;
  timeoutMs: number;
  profile: string;
  switchPoint: PlcPoint;
  runFeedbackPoint: PlcPoint;
  faultPoint: PlcPoint;
  meterPoint?: PlcPoint;
}

export interface PlcModbusConfig extends PlcEndpoint {
  driverId: "PLC_MODBUS_TCP_GATEWAY";
  unitId: number;
}

export interface SiemensS7Config extends PlcEndpoint {
  driverId: "SIEMENS_S7_DRIVER";
  rack: number;
  slot: number;
}

export interface MitsubishiMcConfig extends PlcEndpoint {
  driverId: "MITSUBISHI_MC_DRIVER";
  ascii: boolean;
}

export interface OpcUaConfig {
  driverId: "OPC_UA_CLIENT";
  endpointUrl: string;
  timeoutMs: number;
  authMode: "ANONYMOUS" | "USERNAME";
  username?: string;
  passwordCiphertext?: string;
  profile: string;
  switchPoint: string;
  runFeedbackPoint: string;
  faultPoint: string;
  meterPoint?: string;
}

export type PlcDeviceConfig = PlcModbusConfig | SiemensS7Config | MitsubishiMcConfig | OpcUaConfig;

export interface ParsedPlcConfig {
  config: PlcDeviceConfig;
  password?: string;
}

const EXECUTOR_TYPES: DeviceType[] = ["PLC", "IRRIGATION_PUMP", "IRRIGATION_VALVE", "FERTILIZER_VALVE", "INSECT_LAMP", "AUTO_TRACTOR"];

function profile(protocol: PlcProtocol, meter: PlcMeter | null, pointHint: string, meterPointHint: string): PlcProfile[] {
  const suffix = meter === null ? "SWITCH_ONLY" : meter.unit === "L" ? "FERTILIZER_L" : "WATER_M3";
  return [{
    key: `${protocol}_${suffix}`,
    label: meter === null ? "启停与反馈（无计量）" : meter.unit === "L" ? "启停 + 累计出液 L" : "启停 + 累计流量 m³",
    protocol,
    applicableTypes: EXECUTOR_TYPES,
    pointHint,
    meterPointHint,
    meter,
  }];
}

export const PLC_PROFILES: PlcProfile[] = [
  ...profile("PLC_MODBUS_TCP", null, "Modbus 线圈地址，0~65535", "保持寄存器起始地址"),
  ...profile("PLC_MODBUS_TCP", { dataType: "UINT32", wordOrder: "HIGH_FIRST", scale: 0.001, unit: "m³" }, "Modbus 线圈地址，0~65535", "两个 16 位保持寄存器，高字在前"),
  ...profile("PLC_MODBUS_TCP", { dataType: "UINT32", wordOrder: "LOW_FIRST", scale: 0.1, unit: "L" }, "Modbus 线圈地址，0~65535", "两个 16 位保持寄存器，低字在前"),
  ...profile("SIEMENS_S7", null, "BOOL 点位，如 DB1,X0.0 或 M0.0", "无需计量点位"),
  ...profile("SIEMENS_S7", { dataType: "UINT32", wordOrder: "HIGH_FIRST", scale: 0.001, unit: "m³" }, "BOOL 点位，如 DB1,X0.0", "起始 INT 字，如 DB1,INT0；自动读取相邻下一字"),
  ...profile("SIEMENS_S7", { dataType: "REAL", wordOrder: "HIGH_FIRST", scale: 1, unit: "L" }, "BOOL 点位，如 DB1,X0.0", "REAL 字点位，如 DB1,REAL0"),
  ...profile("MITSUBISHI_MC", null, "位软元件，如 M0 或 D0.0", "无需计量点位"),
  ...profile("MITSUBISHI_MC", { dataType: "UINT32", wordOrder: "HIGH_FIRST", scale: 0.001, unit: "m³" }, "位软元件，如 M0", "起始 D/R 字，如 D0；自动读取相邻下一字"),
  ...profile("MITSUBISHI_MC", { dataType: "REAL", wordOrder: "HIGH_FIRST", scale: 1, unit: "L" }, "位软元件，如 M0", "浮点软元件，如 DFLOAT0"),
  ...profile("OPC_UA", null, "BOOL 节点，如 ns=2;i=1001", "无需计量节点"),
  ...profile("OPC_UA", { dataType: "UINT32", wordOrder: "HIGH_FIRST", scale: 0.001, unit: "m³" }, "BOOL 节点，如 ns=2;i=1001", "UInt32 节点，如 ns=2;i=1003"),
  ...profile("OPC_UA", { dataType: "REAL", wordOrder: "HIGH_FIRST", scale: 1, unit: "L" }, "BOOL 节点，如 ns=2;i=1001", "Float/Double 节点，如 ns=2;i=1003"),
];

export function plcProfiles(protocol: PlcProtocol): PlcProfile[] {
  return PLC_PROFILES.filter((item) => item.protocol === protocol);
}

export function getPlcProfile(protocol: PlcProtocol, key: string): PlcProfile {
  const found = plcProfiles(protocol).find((item) => item.key === key);
  if (!found) throw new Error(`${protocol} 点位剖面 ${key} 未定义`);
  return found;
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("PLC 连接配置需为 JSON 对象");
  return raw as Record<string, unknown>;
}

function text(raw: Record<string, unknown>, key: string, maxLength = 256): string {
  const value = typeof raw[key] === "string" ? raw[key].trim() : "";
  if (!value) throw new Error(`${key} 不能为空`);
  if (value.length > maxLength) throw new Error(`${key} 长度不能超过 ${maxLength}`);
  return value;
}

function integer(raw: Record<string, unknown>, key: string, min: number, max: number, fallback?: number): number {
  const value = raw[key] === undefined || raw[key] === null || raw[key] === "" ? fallback : Number(raw[key]);
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 需为 ${min}~${max} 的整数`);
  return value;
}

function boolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (key === "ascii" && (value === "BINARY" || value === "ASCII")) return value === "ASCII";
  if (typeof value !== "boolean") throw new Error(`${key} 需为布尔值`);
  return value;
}

function host(raw: Record<string, unknown>): string {
  const value = text(raw, "host", 255);
  if (/\s/.test(value)) throw new Error("host 不能包含空白字符");
  return value;
}

function profileKey(raw: Record<string, unknown>, protocol: PlcProtocol, deviceType: DeviceType): string {
  const key = text(raw, "profile", 80);
  const selected = getPlcProfile(protocol, key);
  if (!selected.applicableTypes.includes(deviceType)) throw new Error(`剖面 ${key} 不适用于设备类型 ${deviceType}`);
  return key;
}

function validatePoint(point: unknown, protocol: PlcProtocol, key: string, meter: PlcMeter | null): PlcPoint {
  if (protocol === "PLC_MODBUS_TCP") return integer({ [key]: point }, key, 0, 65535);
  const value = String(point).trim();
  if (!value) throw new Error(`${key} 不能为空`);
  if (protocol === "OPC_UA") {
    if (!/^ns=\d+;(?:i=\d+|s=.+|g=[0-9a-fA-F-]+|b=[A-Za-z0-9+/=_-]+)$/.test(value)) throw new Error(`${key} 需为 OPC UA NodeId`);
    return value;
  }
  if (protocol === "SIEMENS_S7") {
    const wordType = meter?.dataType === "REAL" ? "REAL" : "INT";
    const valid = meter
      ? new RegExp(`^(?:DB[1-9]\\d*|M),${wordType}\\d+$`).test(value)
      : /^(?:(?:DB[1-9]\d*),X|M|I|Q)\d+\.[0-7]$/.test(value);
    if (!valid) throw new Error(`${key} 格式不符合 Siemens S7 点位规范`);
    return value;
  }
  const valid = meter
    ? meter.dataType === "REAL"
      ? /^(?:DFLOAT|RFLOAT)\d+$/.test(value)
      : /^[DR]\d+$/.test(value)
    : /^(?:M|D)\d+(?:\.[0-7])?$|^(?:X|Y)\d+$/.test(value);
  if (!valid) throw new Error(`${key} 格式不符合 Mitsubishi MC 点位规范`);
  return value;
}

function endpoint(raw: unknown, protocol: PlcProtocol, deviceType: DeviceType, current?: PlcDeviceConfig): PlcEndpoint {
  const merged = current && typeof raw === "object" ? { ...current, ...raw } : raw;
  const value = record(merged);
  const selected = getPlcProfile(protocol, profileKey(value, protocol, deviceType));
  const base = {
    host: host(value),
    port: integer(value, "port", 1, 65535, protocol === "PLC_MODBUS_TCP" ? 502 : protocol === "SIEMENS_S7" ? 102 : 1281),
    timeoutMs: integer(value, "timeoutMs", 100, 60000, 5000),
    profile: selected.key,
    switchPoint: validatePoint(value.switchPoint, protocol, "switchPoint", null),
    runFeedbackPoint: validatePoint(value.runFeedbackPoint, protocol, "runFeedbackPoint", null),
    faultPoint: validatePoint(value.faultPoint, protocol, "faultPoint", null),
  };
  if (selected.meter) {
    return { ...base, meterPoint: validatePoint(value.meterPoint, protocol, "meterPoint", selected.meter) };
  }
  if (value.meterPoint !== undefined && value.meterPoint !== "") throw new Error("无计量剖面不能配置 meterPoint");
  return base;
}

export function normalizePlcConfig(protocol: PlcProtocol, raw: unknown, deviceType: DeviceType, current?: PlcDeviceConfig, cipher?: MqttConfigCipher): ParsedPlcConfig {
  if (protocol === "PLC_MODBUS_TCP") {
    const value = record(current ? { ...current, ...record(raw) } : raw);
    return { config: { driverId: "PLC_MODBUS_TCP_GATEWAY", ...endpoint(value, protocol, deviceType, current), unitId: integer(value, "unitId", 0, 255, 1) } };
  }
  if (protocol === "SIEMENS_S7") {
    const value = record(current ? { ...current, ...record(raw) } : raw);
    return { config: { driverId: "SIEMENS_S7_DRIVER", ...endpoint(value, protocol, deviceType, current), rack: integer(value, "rack", 0, 255, 0), slot: integer(value, "slot", 0, 255, 1) } };
  }
  if (protocol === "MITSUBISHI_MC") {
    const value = record(current ? { ...current, ...record(raw) } : raw);
    return { config: { driverId: "MITSUBISHI_MC_DRIVER", ...endpoint(value, protocol, deviceType, current), ascii: boolean(value, "ascii", false) } };
  }
  const value = record(current ? { ...current, ...record(raw) } : raw);
  const requestedAuthMode = value.authMode === undefined && current?.driverId === "OPC_UA_CLIENT" ? current.authMode : text(value, "authMode", 16);
  if (requestedAuthMode !== "ANONYMOUS" && requestedAuthMode !== "USERNAME") throw new Error("authMode 需为 ANONYMOUS/USERNAME");
  const authMode: "ANONYMOUS" | "USERNAME" = requestedAuthMode;
  const endpointUrl = text(value, "endpointUrl", 512);
  let parsedUrl: URL;
  try { parsedUrl = new URL(endpointUrl); } catch { throw new Error("endpointUrl 格式无效"); }
  if (parsedUrl.protocol !== "opc.tcp:" || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password || parsedUrl.hash || parsedUrl.search) throw new Error("endpointUrl 需为不含账号密码与查询参数的 opc.tcp:// 地址");
  const selected = getPlcProfile(protocol, profileKey(value, protocol, deviceType));
  const base = {
    driverId: "OPC_UA_CLIENT" as const,
    endpointUrl,
    timeoutMs: integer(value, "timeoutMs", 100, 60000, 10000),
    authMode,
    profile: selected.key,
    switchPoint: String(validatePoint(value.switchPoint, protocol, "switchPoint", null)),
    runFeedbackPoint: String(validatePoint(value.runFeedbackPoint, protocol, "runFeedbackPoint", null)),
    faultPoint: String(validatePoint(value.faultPoint, protocol, "faultPoint", null)),
  };
  if (selected.meter) Object.assign(base, { meterPoint: String(validatePoint(value.meterPoint, protocol, "meterPoint", selected.meter)) });
  else if (value.meterPoint !== undefined && value.meterPoint !== "") throw new Error("无计量剖面不能配置 meterPoint");
  if (authMode === "ANONYMOUS") return { config: base };
  const username = text(value, "username", 128);
  const suppliedPassword = value.password;
  if (suppliedPassword !== undefined && (typeof suppliedPassword !== "string" || suppliedPassword.length > 128 || /[\u0000-\u001f\u007f]/.test(suppliedPassword))) throw new Error("OPC UA 密码格式无效");
  const password = suppliedPassword === "" ? undefined : suppliedPassword as string | undefined;
  const previous = current?.driverId === "OPC_UA_CLIENT" ? current : undefined;
  if (!password && !previous?.passwordCiphertext) {
    if (!cipher) throw new Error("OPC UA 配置加密密钥未配置");
    throw new Error("首次配置 OPC UA 账号必须填写密码");
  }
  if (!cipher) throw new Error("OPC UA 配置加密密钥未配置");
  return {
    config: { ...base, username, passwordCiphertext: password ? cipher.encrypt(password) : previous!.passwordCiphertext! },
    ...(password ? { password } : {}),
  };
}

export function readPlcConfig(protocol: PlcProtocol, config: PlcDeviceConfig | undefined, deviceType: DeviceType, cipher?: MqttConfigCipher): PlcDeviceConfig {
  if (!config) throw new Error("PLC 设备台账缺少连接配置");
  return normalizePlcConfig(protocol, config, deviceType, config, cipher).config;
}

export function publicPlcConfig(config: PlcDeviceConfig): Record<string, unknown> {
  if (config.driverId !== "OPC_UA_CLIENT") return { ...config };
  const { passwordCiphertext, ...safe } = config;
  return { ...safe, hasPassword: Boolean(passwordCiphertext) };
}
