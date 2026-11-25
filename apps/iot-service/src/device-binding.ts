import type { DeviceType } from "./device.repository.js";
import { MODBUS_TCP_DEFAULT_PORT, MODBUS_TCP_DEFAULT_TIMEOUT_MS } from "./modbus-tcp.js";
import { plcProfiles } from "./plc-binding.js";
import type { PlcProtocol } from "./plc-binding.js";

/**
 * 设备接入绑定：台账里「这台设备怎么连」的那一段。
 *
 * 平台原本只有一种接法——设备自己把遥测和回执 POST 回来（`/api/v1/telemetry`、
 * `/api/v1/control/device/*`），因此台账只有编号、类型、地块三件事。现场真正在执行动作的
 * 泵、阀、水肥机讲的是 Modbus TCP：主站（平台侧网关）主动连过去写线圈，从站只会应答。
 * 这一侧要能落地，台账必须记住接入地址与寄存器剖面，否则网关不知道该连谁、写哪个点。
 *
 * 剖面（profile）是设备手册里那张寄存器表的代码化：地址、倍率、单位、拼字顺序都只在这里有一份，
 * 网关按 key 取用。不同厂家的点位对不上时新增一个剖面 key，而不是在业务代码里散写地址常量。
 */

/** 接入协议：HTTP 沿用既有「设备等录回调」，MODBUS_TCP 由 iot-service 现场网关主动轮询下发，
 *  MQTT 由设备订阅平台主题直连（遥测上报与指令下发同链路，B2 拖拉机等设备走此协议） */
export const DEVICE_PROTOCOLS = ["HTTP", "MODBUS_TCP", "MQTT", "PLC_MODBUS_TCP", "SIEMENS_S7", "MITSUBISHI_MC", "OPC_UA"] as const;
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number];
export type PlcDeviceProtocol = Extract<DeviceProtocol, PlcProtocol>;

/** 缺省协议：既有台账与存量行都是回调式接入，不因为本迁移改变行为 */
export const DEFAULT_DEVICE_PROTOCOL: DeviceProtocol = "HTTP";

export type DeviceConnectionKind = "NONE" | "MODBUS_TCP" | "MQTT" | "PLC";
export type DeviceDriverRuntime = "DEVICE_CALLBACK" | "FIELD_GATEWAY" | "MQTT_BROKER" | "PLC_DRIVER";
export type DeviceConnectionParameterType = "text" | "password" | "number" | "select" | "certificate";

export interface DeviceConnectionParameter {
  key: string;
  label: string;
  input: DeviceConnectionParameterType;
  required: boolean;
  requiredOnCreate?: boolean;
  requiredWhen?: { key: string; startsWith?: string };
  secret?: boolean;
  defaultValue?: number | string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
}

export interface DeviceProtocolDriver {
  id: string;
  protocol: DeviceProtocol;
  label: string;
  description: string;
  connectionKind: DeviceConnectionKind;
  runtime: DeviceDriverRuntime;
  parameters: DeviceConnectionParameter[];
}


/**
 * 这个协议是否需要现场接入绑定。
 *
 * 回调式（缺省协议）由设备自己把遥测和回执 POST 回来，平台没有要连的地址；
 * 其余协议由平台侧网关主动连过去，必须给出地址与剖面。
 * 建档校验、错误文案与前端表单都问这一个函数，避免「后端要不要绑定」和「界面显示不显示绑定」各判一次。
 */
/** 只有现场总线协议需要 Modbus 绑定；HTTP 回调与 MQTT 直连都不需要 */
export function protocolRequiresBinding(protocol: DeviceProtocol): boolean {
  return protocol === "MODBUS_TCP";
}

export function fieldGatewayProtocols(): DeviceProtocol[] {
  return DEVICE_PROTOCOLS.filter((protocol) => {
    const driver = getDeviceProtocolDriver(protocol);
    return driver.runtime === "FIELD_GATEWAY" || driver.runtime === "PLC_DRIVER";
  });
}

export function isPlcProtocol(protocol: DeviceProtocol): protocol is PlcDeviceProtocol {
  return getDeviceProtocolDriver(protocol).connectionKind === "PLC";
}

/** Modbus 单元标识缺省值：直连从站时手册常写 1，串口网关下挂多台时逐台不同 */
export const MODBUS_DEFAULT_UNIT_ID = 1;

/** 剖面里的累计量寄存器字序：高字在前（ABCD）或低字在前（CDAB），由设备手册决定 */
export const MODBUS_WORD_ORDERS = ["HIGH_FIRST", "LOW_FIRST"] as const;
export type ModbusWordOrder = (typeof MODBUS_WORD_ORDERS)[number];

export interface ModbusMeter {
  /** 累计量起始寄存器地址，占相邻两个 16 位寄存器拼出 32 位 */
  register: number;
  wordOrder: ModbusWordOrder;
  /** 寄存器计数 → 业务量的倍率：每计数 1 等于多少单位 */
  scale: number;
  /** 计量单位，直接进回执与作业量口径 */
  unit: "m³" | "L";
}

export interface ModbusProfile {
  /** 面板上的可读名字 */
  label: string;
  /** 启停线圈（FC05）：开写 0xFF00，关写 0x0000 */
  switchCoil: number;
  /**
   * 运行反馈（FC02 离散输入）：为真才认为设备真的动了。
   * 反馈位与故障位刻意不走线圈地址空间：现场控制柜的线圈镜像跟着输出映像走，
   * 用 FC01 读回来等于把自己刚写的值当反馈，急停会「立刻到位」。
   */
  runFeedbackInput: number;
  /** 故障输入（FC02）：为真时指令收口成 FAILED */
  faultInput: number;
  /** 累计计量（FC03 保持寄存器，占两个寄存器）；无计量设备为 null，回执只报到位不报作业量 */
  meter: ModbusMeter | null;
  /** 允许配用的台账类型：只有执行类设备能被网关写线圈，传感器配剖面等于对着表计下令 */
  applicableTypes: DeviceType[];
}

/**
 * 现场剖面表。
 *
 * 点位取自常见灌溉/水肥控制柜的接法，出厂手册对不上时按本表的 key 增设剖面，
 * 业务代码一律经 `getModbusProfile` 取用，不散写地址字面量。
 */
export const MODBUS_PROFILES: Record<string, ModbusProfile> = {
  SWITCH_ONLY: {
    label: "启停型（只有开关，无计量）",
    switchCoil: 0x0000,
    runFeedbackInput: 0x0000,
    faultInput: 0x0001,
    meter: null,
    applicableTypes: ["IRRIGATION_PUMP", "IRRIGATION_VALVE", "FERTILIZER_VALVE", "INSECT_LAMP", "AGRICULTURAL_DRONE", "AUTO_TRACTOR"],
  },
  WATER_M3: {
    label: "灌溉计量（启停 + 累计流量 m³）",
    switchCoil: 0x0000,
    runFeedbackInput: 0x0000,
    faultInput: 0x0001,
    meter: { register: 0x0000, wordOrder: "HIGH_FIRST", scale: 0.001, unit: "m³" },
    applicableTypes: ["IRRIGATION_PUMP", "IRRIGATION_VALVE"],
  },
  FERTILIZER_L: {
    label: "水肥计量（启停 + 累计出液 L）",
    switchCoil: 0x0010,
    runFeedbackInput: 0x0000,
    faultInput: 0x0001,
    meter: { register: 0x0020, wordOrder: "LOW_FIRST", scale: 0.1, unit: "L" },
    applicableTypes: ["FERTILIZER_VALVE"],
  },
};

export const MODBUS_PROFILE_KEYS = Object.keys(MODBUS_PROFILES);

function plcParameters(protocol: PlcProtocol): DeviceConnectionParameter[] {
  const profiles = plcProfiles(protocol);
  const first = profiles[0]!;
  const parameters: DeviceConnectionParameter[] = [
    { key: "profile", label: "点位剖面", input: "select", required: true, options: profiles.map((item) => ({ value: item.key, label: item.label })) },
    { key: "switchPoint", label: "启停点位", input: protocol === "PLC_MODBUS_TCP" ? "number" : "text", required: true, ...(protocol === "PLC_MODBUS_TCP" ? { min: 0, max: 65535, step: 1 } : { maxLength: 128 }), placeholder: first.pointHint },
    { key: "runFeedbackPoint", label: "运行反馈点位", input: protocol === "PLC_MODBUS_TCP" ? "number" : "text", required: true, ...(protocol === "PLC_MODBUS_TCP" ? { min: 0, max: 65535, step: 1 } : { maxLength: 128 }), placeholder: first.pointHint, hint: "急停必须读到反馈为假才确认到位" },
    { key: "faultPoint", label: "故障点位", input: protocol === "PLC_MODBUS_TCP" ? "number" : "text", required: true, ...(protocol === "PLC_MODBUS_TCP" ? { min: 0, max: 65535, step: 1 } : { maxLength: 128 }), placeholder: first.pointHint },
    { key: "meterPoint", label: "累计计量点位", input: protocol === "PLC_MODBUS_TCP" ? "number" : "text", required: false, ...(protocol === "PLC_MODBUS_TCP" ? { min: 0, max: 65535, step: 1 } : { maxLength: 128 }), placeholder: first.meterPointHint, hint: "选择计量剖面时必填；无计量剖面留空" },
  ];
  if (protocol === "PLC_MODBUS_TCP") return [
    { key: "host", label: "PLC 接入地址", input: "text", required: true, maxLength: 255, placeholder: "PLC 或现场网关 IPv4/IPv6/域名" },
    { key: "port", label: "端口", input: "number", required: false, defaultValue: 502, min: 1, max: 65535, step: 1 },
    { key: "unitId", label: "单元标识", input: "number", required: false, defaultValue: 1, min: 0, max: 255, step: 1 },
    ...parameters,
    { key: "timeoutMs", label: "事务超时", input: "number", required: false, defaultValue: 5000, min: 100, max: 60000, step: 100 },
  ];
  if (protocol === "SIEMENS_S7") return [
    { key: "host", label: "PLC 接入地址", input: "text", required: true, maxLength: 255, placeholder: "S7 PLC IPv4/IPv6/域名" },
    { key: "port", label: "S7comm 端口", input: "number", required: false, defaultValue: 102, min: 1, max: 65535, step: 1 },
    { key: "rack", label: "机架", input: "number", required: false, defaultValue: 0, min: 0, max: 255, step: 1 },
    { key: "slot", label: "插槽", input: "number", required: false, defaultValue: 1, min: 0, max: 255, step: 1, hint: "S7-1200/1500 通常为 1；S7-300/400 以实际配置为准" },
    ...parameters,
    { key: "timeoutMs", label: "事务超时", input: "number", required: false, defaultValue: 5000, min: 100, max: 60000, step: 100, hint: "S7-1200/1500 需启用 GET/PUT，并使用非优化 DB 绝对地址" },
  ];
  if (protocol === "MITSUBISHI_MC") return [
    { key: "host", label: "PLC 接入地址", input: "text", required: true, maxLength: 255, placeholder: "三菱 PLC IPv4/IPv6/域名" },
    { key: "port", label: "MC 协议端口", input: "number", required: false, defaultValue: 1281, min: 1, max: 65535, step: 1 },
    { key: "ascii", label: "帧格式", input: "select", required: false, defaultValue: "BINARY", options: [{ value: "BINARY", label: "二进制 1E 帧" }, { value: "ASCII", label: "ASCII 1E 帧" }] },
    ...parameters,
    { key: "timeoutMs", label: "事务超时", input: "number", required: false, defaultValue: 5000, min: 100, max: 60000, step: 100 },
  ];
  return [
    { key: "endpointUrl", label: "OPC UA Endpoint", input: "text", required: true, maxLength: 512, placeholder: "opc.tcp://plc.example.test:4840", hint: "当前驱动使用 None 安全模式，请仅在可信工业网络或通过安全网关部署" },
    { key: "authMode", label: "身份认证", input: "select", required: false, defaultValue: "ANONYMOUS", options: [{ value: "ANONYMOUS", label: "匿名" }, { value: "USERNAME", label: "账号密码" }] },
    { key: "username", label: "OPC UA 账号", input: "text", required: false, requiredWhen: { key: "authMode", startsWith: "USERNAME" }, maxLength: 128 },
    { key: "password", label: "OPC UA 密码", input: "password", required: false, requiredOnCreate: true, requiredWhen: { key: "authMode", startsWith: "USERNAME" }, secret: true, maxLength: 128, placeholder: "首次配置必填，编辑时留空保持不变", hint: "密码加密保存，平台不回显" },
    ...parameters,
    { key: "timeoutMs", label: "会话超时", input: "number", required: false, defaultValue: 10000, min: 100, max: 60000, step: 100 },
  ];
}

/** 协议驱动是单一真相源：台账校验、目录接口与前端连接表单都按它生成。 */
export const DEVICE_PROTOCOL_DRIVERS: Record<DeviceProtocol, DeviceProtocolDriver> = {
  HTTP: {
    id: "HTTP_CALLBACK",
    protocol: "HTTP",
    label: "HTTP 回调驱动",
    description: "设备主动把遥测与回执回调到平台，无需设备连接参数。",
    connectionKind: "NONE",
    runtime: "DEVICE_CALLBACK",
    parameters: [],
  },
  MODBUS_TCP: {
    id: "MODBUS_TCP_GATEWAY",
    protocol: "MODBUS_TCP",
    label: "Modbus TCP 现场网关驱动",
    description: "平台侧网关按设备地址与寄存器剖面主动连接、轮询和下发。",
    connectionKind: "MODBUS_TCP",
    runtime: "FIELD_GATEWAY",
    parameters: [
      { key: "host", label: "接入地址", input: "text", required: true, maxLength: 64, placeholder: "从站或现场网关地址，如 10.0.0.9" },
      { key: "port", label: "端口", input: "number", required: false, defaultValue: MODBUS_TCP_DEFAULT_PORT, min: 1, max: 65535, step: 1 },
      { key: "unitId", label: "单元标识", input: "number", required: false, defaultValue: MODBUS_DEFAULT_UNIT_ID, min: 0, max: 255, step: 1 },
      { key: "profile", label: "寄存器剖面", input: "select", required: true, options: MODBUS_PROFILE_KEYS.map((key) => ({ value: key, label: MODBUS_PROFILES[key]!.label })) },
      { key: "timeoutMs", label: "事务超时", input: "number", required: false, defaultValue: MODBUS_TCP_DEFAULT_TIMEOUT_MS, min: 100, max: 60000, step: 100, hint: "单次 Modbus 事务的等待毫秒数" },
    ],
  },
  MQTT: {
    id: "MQTT_DIRECT",
    protocol: "MQTT",
    label: "MQTT 直连驱动",
    description: "保存设备自有 Broker 账号与连接参数；默认不调用 EMQX 开户。",
    connectionKind: "MQTT",
    runtime: "MQTT_BROKER",
    parameters: [
      { key: "username", label: "MQTT 账号", input: "text", required: true, maxLength: 64, placeholder: "设备在 Broker 中已有的账号" },
      { key: "password", label: "MQTT 密码", input: "password", required: false, requiredOnCreate: true, secret: true, maxLength: 128, placeholder: "首次配置必填，编辑时留空保持不变", hint: "密码加密保存，平台不回显" },
      { key: "brokerUrl", label: "Broker 地址", input: "text", required: true, defaultValue: "mqtts://", maxLength: 256, placeholder: "mqtts://broker.example.com:8883" },
      { key: "caCertificate", label: "CA 证书", input: "certificate", required: false, requiredWhen: { key: "brokerUrl", startsWith: "mqtts://" }, hint: "mqtts 连接必填；已配置证书支持下载" },
    ],
  },
  PLC_MODBUS_TCP: {
    id: "PLC_MODBUS_TCP_GATEWAY",
    protocol: "PLC_MODBUS_TCP",
    label: "PLC over Modbus TCP",
    description: "通过 Modbus TCP 读写 PLC 线圈、离散输入与保持寄存器。",
    connectionKind: "PLC",
    runtime: "PLC_DRIVER",
    parameters: plcParameters("PLC_MODBUS_TCP"),
  },
  SIEMENS_S7: {
    id: "SIEMENS_S7_DRIVER",
    protocol: "SIEMENS_S7",
    label: "Siemens S7comm 驱动",
    description: "通过 S7comm/RFC1006 读写西门子 PLC 的 BOOL 与字地址。",
    connectionKind: "PLC",
    runtime: "PLC_DRIVER",
    parameters: plcParameters("SIEMENS_S7"),
  },
  MITSUBISHI_MC: {
    id: "MITSUBISHI_MC_DRIVER",
    protocol: "MITSUBISHI_MC",
    label: "Mitsubishi MC Protocol 驱动",
    description: "通过 MC 兼容 1E 帧读写三菱 FX 系列 PLC 的位与字软元件。",
    connectionKind: "PLC",
    runtime: "PLC_DRIVER",
    parameters: plcParameters("MITSUBISHI_MC"),
  },
  OPC_UA: {
    id: "OPC_UA_CLIENT",
    protocol: "OPC_UA",
    label: "OPC UA 客户端驱动",
    description: "通过 OPC UA 会话读写 PLC 暴露的 BOOL、UInt32 与浮点节点。",
    connectionKind: "PLC",
    runtime: "PLC_DRIVER",
    parameters: plcParameters("OPC_UA"),
  },
};

export function getDeviceProtocolDriver(protocol: string): DeviceProtocolDriver {
  const driver = DEVICE_PROTOCOL_DRIVERS[protocol as DeviceProtocol];
  if (!driver) throw new Error(`接入协议需为 ${DEVICE_PROTOCOLS.join("/")}`);
  return driver;
}

export function resolveDeviceProtocolDriver(protocol: string, driverId?: string): DeviceProtocolDriver {
  const driver = getDeviceProtocolDriver(protocol);
  if (driverId && driverId !== driver.id) throw new Error(`协议 ${protocol} 必须使用驱动 ${driver.id}`);
  return driver;
}

/** 接入协议的可读名字：配置弹窗与网关日志说同一套话，不在前端再抄一份清单 */
export const DEVICE_PROTOCOL_LABELS: Record<DeviceProtocol, string> = {
  HTTP: "设备回调（设备自己上报）",
  MODBUS_TCP: "现场总线 Modbus TCP（平台主动轮询）",
  MQTT: "MQTT 直连（设备订阅平台主题）",
  PLC_MODBUS_TCP: "PLC over Modbus TCP",
  SIEMENS_S7: "西门子 S7comm",
  MITSUBISHI_MC: "三菱 MC Protocol",
  OPC_UA: "OPC UA",
};

/** 字序的可读名字：剖面里的计数拼法只有两种，但选错会把用量读成完全不相干的数 */
export const MODBUS_WORD_ORDER_LABELS: Record<ModbusWordOrder, string> = {
  HIGH_FIRST: "高字在前（ABCD）",
  LOW_FIRST: "低字在前（CDAB）",
};

/** 按 key 取剖面：未知 key 直接报错，不让网关拿着 undefined 去写线圈 */
export function getModbusProfile(key: string): ModbusProfile {
  const profile = MODBUS_PROFILES[key];
  if (!profile) throw new Error(`现场剖面 ${key} 未定义，可用取值：${MODBUS_PROFILE_KEYS.join("/")}`);
  return profile;
}

/**
 * 现场接入目录：表单要渲染的协议、剖面与缺省值全部由这里给。
 *
 * 端口、单元标识、超时、剖面点位都只有服务端一份权威定义，前端写死就等于允许界面
 * 与网关按两套口径连设备；新增剖面时前端不用改。
 */
export function fieldAccessCatalogue(): FieldAccessCatalogue {
  return {
    protocols: DEVICE_PROTOCOLS.map((value) => {
      const driver = getDeviceProtocolDriver(value);
      return {
        value,
        label: DEVICE_PROTOCOL_LABELS[value],
        driverId: driver.id,
        driverLabel: driver.label,
        description: driver.description,
        connectionKind: driver.connectionKind,
        runtime: driver.runtime,
        requiresBinding: protocolRequiresBinding(value),
        parameters: driver.parameters,
      };
    }),
    defaultProtocol: DEFAULT_DEVICE_PROTOCOL,
    profiles: MODBUS_PROFILE_KEYS.map((key) => {
      const profile = getModbusProfile(key);
      return {
        key,
        label: profile.label,
        protocol: "MODBUS_TCP",
        applicableTypes: profile.applicableTypes,
        meter: profile.meter === null ? null : { ...profile.meter, wordOrderLabel: MODBUS_WORD_ORDER_LABELS[profile.meter.wordOrder] },
      };
    }),
    plcProfiles: (["PLC_MODBUS_TCP", "SIEMENS_S7", "MITSUBISHI_MC", "OPC_UA"] as const).flatMap((protocol) => plcProfiles(protocol).map((profile) => ({
      key: profile.key,
      label: profile.label,
      protocol,
      applicableTypes: profile.applicableTypes,
      pointHint: profile.pointHint,
      meterPointHint: profile.meterPointHint,
      meter: profile.meter === null ? null : { ...profile.meter, wordOrderLabel: profile.meter.wordOrder === "HIGH_FIRST" ? "高字在前（ABCD）" : "低字在前（CDAB）" },
    }))),
    defaults: { port: MODBUS_TCP_DEFAULT_PORT, unitId: MODBUS_DEFAULT_UNIT_ID, timeoutMs: MODBUS_TCP_DEFAULT_TIMEOUT_MS },
  };
}

/** 现场接入目录的形状 */
export interface FieldAccessCatalogue {
  protocols: Array<{
    value: DeviceProtocol;
    label: string;
    driverId: string;
    driverLabel: string;
    description: string;
    connectionKind: DeviceConnectionKind;
    runtime: DeviceDriverRuntime;
    requiresBinding: boolean;
    parameters: DeviceConnectionParameter[];
  }>;
  defaultProtocol: DeviceProtocol;
  profiles: Array<{ key: string; label: string; protocol: "MODBUS_TCP"; applicableTypes: DeviceType[]; meter: (ModbusMeter & { wordOrderLabel: string }) | null }>;
  plcProfiles: Array<{
    key: string;
    label: string;
    protocol: PlcProtocol;
    applicableTypes: DeviceType[];
    pointHint: string;
    meterPointHint: string;
    meter: ({ dataType: "UINT32" | "REAL"; wordOrder: "HIGH_FIRST" | "LOW_FIRST"; scale: number; unit: "m³" | "L"; wordOrderLabel: string }) | null;
  }>;
  defaults: { port: number; unitId: number; timeoutMs: number };
}

/** MODBUS_TCP 设备的接入绑定 */
export interface ModbusBinding {
  host: string;
  port: number;
  unitId: number;
  profile: string;
  timeoutMs: number;
}

/**
 * 校验并归一化 Modbus 接入绑定（HTTP 回调式设备没有绑定）。
 *
 * 这是台账写入前的唯一口径：地址、端口、单元标识、剖面都要能被网关直接用。
 * 缺省端口取 Modbus 规范值，缺省单元标识取直连从站的常见写法，缺省超时取网关口径常量。
 * `deviceType` 传入时顺带校验剖面与设备类型匹配——给墒情站配启停剖面等于对着表计下令。
 */
export function parseModbusBinding(raw: unknown, deviceType?: DeviceType): ModbusBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("现场接入绑定需为 JSON 对象");
  const value = raw as Record<string, unknown>;

  const host = typeof value.host === "string" ? value.host.trim() : "";
  // IPv6 也允许带方括号，这里只要求非空且不含空格：真正的可达性由网关连接结果反映
  if (!host || /\s/.test(host)) throw new Error("接入地址（host）需为设备或现场网关的 IPv4/IPv6 或域名");

  const port = value.port === undefined || value.port === null ? MODBUS_TCP_DEFAULT_PORT : Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("接入端口需为 1~65535 的整数");

  const unitId = value.unitId === undefined || value.unitId === null ? MODBUS_DEFAULT_UNIT_ID : Number(value.unitId);
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) throw new Error("单元标识（unitId）需为 0~255 的整数");

  const timeoutMs = value.timeoutMs === undefined || value.timeoutMs === null ? MODBUS_TCP_DEFAULT_TIMEOUT_MS : Number(value.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("单次事务超时需为 100~60000 毫秒");

  const profile = typeof value.profile === "string" ? value.profile.trim() : "";
  if (!profile) throw new Error(`现场剖面（profile）不能为空，可用取值：${MODBUS_PROFILE_KEYS.join("/")}`);
  const resolved = getModbusProfile(profile);
  if (deviceType && !resolved.applicableTypes.includes(deviceType)) {
    throw new Error(`剖面 ${profile} 适用于 ${resolved.applicableTypes.join("/")}，与设备类型 ${deviceType} 不匹配`);
  }

  return { host, port, unitId, profile, timeoutMs };
}

/** 把绑定按协议收成待落库的形状；回调式接入恒为空 */
export function normalizeBinding(protocol: DeviceProtocol, raw: unknown, deviceType?: DeviceType): ModbusBinding | null {
  if (!protocolRequiresBinding(protocol)) {
    if (raw !== undefined && raw !== null) throw new Error(`${protocol} 回调式接入没有现场绑定，请先把接入协议改成 ${DEVICE_PROTOCOLS.filter(protocolRequiresBinding).join("/")}`);
    return null;
  }
  if (raw === undefined || raw === null) throw new Error(`${protocol} 接入必须给出绑定（host / port / unitId / profile）`);
  return parseModbusBinding(raw, deviceType);
}

/** 从台账读出的绑定归一化后交给网关使用：库里存的可能是历史手填形状 */
export function readModbusBinding(binding: ModbusBinding | null | undefined, deviceType?: DeviceType): ModbusBinding {
  if (!binding) throw new Error("设备台账缺少现场接入绑定，网关无法下发");
  return parseModbusBinding(binding, deviceType);
}
