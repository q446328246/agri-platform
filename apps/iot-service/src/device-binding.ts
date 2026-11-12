import type { DeviceType } from "./device.repository.js";
import { MODBUS_TCP_DEFAULT_PORT, MODBUS_TCP_DEFAULT_TIMEOUT_MS } from "./modbus-tcp.js";

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

/** 接入协议：HTTP 沿用既有「设备等录回调」，MODBUS_TCP 由 iot-service 现场网关主动轮询下发 */
export const DEVICE_PROTOCOLS = ["HTTP", "MODBUS_TCP"] as const;
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number];

/** 缺省协议：既有台账与存量行都是回调式接入，不因为本迁移改变行为 */
export const DEFAULT_DEVICE_PROTOCOL: DeviceProtocol = "HTTP";

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

/** 按 key 取剖面：未知 key 直接报错，不让网关拿着 undefined 去写线圈 */
export function getModbusProfile(key: string): ModbusProfile {
  const profile = MODBUS_PROFILES[key];
  if (!profile) throw new Error(`现场剖面 ${key} 未定义，可用取值：${MODBUS_PROFILE_KEYS.join("/")}`);
  return profile;
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

/** 把绑定按协议收成待落库的形状；HTTP 设备恒为空 */
export function normalizeBinding(protocol: DeviceProtocol, raw: unknown, deviceType?: DeviceType): ModbusBinding | null {
  if (protocol === "HTTP") {
    if (raw !== undefined && raw !== null) throw new Error("HTTP 回调式接入没有现场绑定，请先把接入协议改成 MODBUS_TCP");
    return null;
  }
  if (raw === undefined || raw === null) throw new Error("MODBUS_TCP 接入必须给出绑定（host / port / unitId / profile）");
  return parseModbusBinding(raw, deviceType);
}

/** 从台账读出的绑定归一化后交给网关使用：库里存的可能是历史手填形状 */
export function readModbusBinding(binding: ModbusBinding | null | undefined, deviceType?: DeviceType): ModbusBinding {
  if (!binding) throw new Error("设备台账缺少现场接入绑定，网关无法下发");
  return parseModbusBinding(binding, deviceType);
}
