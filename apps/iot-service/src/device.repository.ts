import type { PrismaClientLike } from "@agri/db";
import { keywordHits, likePattern, toIsoTimestamp, ulid } from "@agri/shared";

import { DEFAULT_DEVICE_PROTOCOL, getDeviceProtocolDriver } from "./device-binding.js";
import type { DeviceProtocol, ModbusBinding } from "./device-binding.js";
import type { PlcDeviceConfig } from "./plc-binding.js";
import type { MqttDeviceConfig } from "./mqtt-config.js";

/**
 * 设备台账仓储。
 *
 * 表结构由迁移 014 管理、迁移 035 补上租户归属、迁移 038 补上现场接入绑定；内存实现装载与迁移同一批演示设备，
 * 供单测与未启用数据库的本地模式使用。
 * 设备 id 保持既有 `device-*` 形态，遥测读数、控制指令与摄像头配置都按这些 id 关联，不能改口径。
 *
 * 台账按租户隔离：读、写、撞号校验都要带 tenantId，跨租户的 id 与编号一律当作不存在，
 * 否则乙农场能列出甲农场的设备绑定，还能照着别家的设备号下指令。
 */

/** 未配置 TENANT_ID 且请求没有可信租户头时的归属租户，与全仓演示租户同字面量 */
export const DEFAULT_TENANT = "tenant-demo";

/** 台账类型白名单，与迁移 014 的 CHECK、前端 apps/web/src/utils/device.ts 的选项三处同口径 */
export const DEVICE_TYPES = [
  "PLC",
  "WEATHER_STATION",
  "SOIL_SENSOR",
  "INTEGRATED_STATION",
  "REMOTE_SENSE",
  "INSECT_LAMP",
  "FERTILIZER_VALVE",
  "IRRIGATION_VALVE",
  "IRRIGATION_PUMP",
  "AGRICULTURAL_DRONE",
  "AUTO_TRACTOR",
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_STATUSES = ["ONLINE", "OFFLINE"] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export interface Device {
  id: string;
  /** 台账归属租户（迁移 035），设备编号只在本租户内唯一 */
  tenantId: string;
  /** 设备出厂编号，同租户台账内唯一 */
  deviceNo: string;
  name: string;
  type: DeviceType;
  status: DeviceStatus;
  /** 绑定地块编码，未绑定时省略 */
  plotCode?: string | undefined;
  /** 接入协议（迁移 038）：HTTP 为设备回调，MODBUS_TCP 由 iot-service 现场网关主动下发 */
  protocol: DeviceProtocol;
  /** 协议驱动标识；与 protocol 配套，新增协议时扩展驱动目录而不是改台账结构 */
  driverId: string;
  /** 现场接入绑定（地址 + 剖面）；协议为 HTTP 时省略 */
  binding?: ModbusBinding | undefined;
  /** MQTT 设备自带连接配置；密码仅以密文保存，HTTP 响应不返回密文或证书正文 */
  mqtt?: MqttDeviceConfig | undefined;
  /** PLC 协议独立连接配置；不同驱动的字段由 plc-binding 按协议校验，不共用 Modbus binding */
  plc?: PlcDeviceConfig | undefined;
  /** 最后一次上报时间；新登记但尚未上报的设备为 null，不拿当前时刻冒充 */
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 新增设备的入参，id 与时间戳由仓储生成 */
export interface CreateDeviceInput {
  deviceNo: string;
  name: string;
  type: DeviceType;
  status: DeviceStatus;
  plotCode?: string | undefined;
  /** 省略即按缺省协议（HTTP 回调）建档 */
  protocol?: DeviceProtocol | undefined;
  /** 省略时按协议取默认驱动；显式值必须与协议匹配 */
  driverId?: string | undefined;
  binding?: ModbusBinding | undefined;
  mqtt?: MqttDeviceConfig | undefined;
  plc?: PlcDeviceConfig | undefined;
}

/**
 * 台账配置编辑入参：字段缺省表示保持原值。
 *
 * deviceNo 是出厂标识，遥测读数与控制指令都按它关联，不提供修改；
 * lastSeenAt 只能由上报侧写入，配置编辑不碰，避免手工把离线设备「点亮」。
 * 协议与绑定的配套关系（HTTP 不留绑定、现场协议必给绑定）由 HTTP 层校验后再进来，
 * 这里只负责按字段合并。
 */
export interface UpdateDeviceInput {
  name?: string;
  type?: DeviceType;
  status?: DeviceStatus;
  /** 传空串表示解绑地块，省略表示不改绑定 */
  plotCode?: string;
  /** 接入协议：与 driverId/binding 配套改，协议与连接同生同灭 */
  protocol?: DeviceProtocol;
  /** 协议驱动：与 protocol 配套改，省略时按协议取默认驱动 */
  driverId?: string;
  /** 传 null 表示清空绑定（改回 HTTP 回调时用），省略表示不改绑定 */
  binding?: ModbusBinding | null;
  /** MQTT 连接配置；传 null 表示切换协议时清空 */
  mqtt?: MqttDeviceConfig | null;
  /** PLC 连接配置；传 null 表示切换协议时清空 */
  plc?: PlcDeviceConfig | null;
}

/** 台账筛选条件，全部为精确或子串匹配，缺省不过滤 */
export interface DeviceFilter {
  /** 命中名称或设备编号 */
  keyword?: string | undefined;
  type?: string | undefined;
  status?: string | undefined;
  plotCode?: string | undefined;
  /** 接入协议：现场网关只取非 HTTP 的设备，不用把整本台账拉过去再筛 */
  protocol?: string | undefined;
  /** 多协议执行器按驱动运行时批量取设备；与 protocol 同时使用时取交集 */
  protocols?: string[] | undefined;
}

export interface DeviceRepository {
  /** 按筛选条件返回升序排列的完整命中集，分页由调用侧裁剪；只返回该租户的台账 */
  list(tenantId: string, filter?: DeviceFilter): Promise<Device[]>;
  /** 跨租户的 id 一律当作不存在 */
  find(tenantId: string, id: string): Promise<Device | null>;
  /** 撞号校验按租户查：别家农场同型号设备的编号不算重复 */
  findByDeviceNo(tenantId: string, deviceNo: string): Promise<Device | null>;
  create(tenantId: string, input: CreateDeviceInput): Promise<Device>;
  /** 更新台账配置；设备不存在或不属于该租户返回 null */
  update(tenantId: string, id: string, input: UpdateDeviceInput): Promise<Device | null>;
}

function matchesFilter(device: Device, filter: DeviceFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.type && device.type !== filter.type) return false;
  if (filter.status && device.status !== filter.status) return false;
  if (filter.plotCode && device.plotCode !== filter.plotCode) return false;
  if (filter.protocol && device.protocol !== filter.protocol) return false;
  if (filter.protocols && !filter.protocols.includes(device.protocol)) return false;
  if (filter.keyword) {
    if (!keywordHits(filter.keyword, [device.name, device.deviceNo])) return false;
  }
  return true;
}

/** 按编号排序，保证内存与 SQL 两种模式的列表顺序一致 */
function byDeviceNo(a: Device, b: Device): number {
  return a.deviceNo.localeCompare(b.deviceNo);
}

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3600000).toISOString();

/**
 * 演示台账：与迁移 014 注入的 12 台设备逐字段对齐，
 * 地块编码取自迁移 010 的示范田，气象站挂在首部而不落具体地块。
 * 迁移 035 之后这批设备归演示租户，跨租户部署时按调用方给的租户落位。
 */
export function demoDevices(tenantId: string = DEFAULT_TENANT): Device[] {
  const EAST_1 = "511723-000001-01-00001-0000-5";
  const EAST_2 = "511723-000001-01-00002-0000-Z";
  const EAST_3 = "511723-000001-01-00003-0000-T";
  const WEST_1 = "511723-000001-02-00005-0000-C";
  const LINK_1 = "511723-000001-03-00008-0000-P";
  const LINK_2 = "511723-000001-03-00009-0000-J";
  const LINK_3 = "511723-000001-03-00010-0000-U";
  const now = new Date().toISOString();
  const rows: Array<[string, string, string, DeviceType, DeviceStatus, string, string | null]> = [
    ["device-weather-001", "DZ-W-001", "达州气象站 A01", "WEATHER_STATION", "ONLINE", "", now],
    ["device-soil-003", "DZ-S-003", "东区一号田墒情站 S03", "SOIL_SENSOR", "ONLINE", EAST_1, now],
    ["device-station-002", "DZ-C-002", "东区二号田综合监测站 C02", "INTEGRATED_STATION", "ONLINE", EAST_2, now],
    ["device-soil-004", "DZ-S-004", "西区一号田墒情站 S04", "SOIL_SENSOR", "ONLINE", WEST_1, now],
    ["device-ndvi-001", "DZ-R-001", "苗情遥感反演节点 R01", "REMOTE_SENSE", "ONLINE", EAST_3, hoursAgo(2)],
    ["device-lamp-001", "DZ-L-001", "东区虫情测报灯 L01", "INSECT_LAMP", "ONLINE", EAST_3, now],
    ["device-lamp-002", "DZ-L-002", "联片虫情测报灯 L02", "INSECT_LAMP", "OFFLINE", LINK_2, hoursAgo(14)],
    ["device-valve-001", "DZ-V-001", "首部水肥泵阀 V01", "FERTILIZER_VALVE", "ONLINE", EAST_1, now],
    ["device-valve-002", "DZ-V-002", "西区灌溉阀门 V02", "IRRIGATION_VALVE", "ONLINE", WEST_1, now],
    ["device-pump-001", "DZ-P-001", "联片灌溉泵站 P01", "IRRIGATION_PUMP", "ONLINE", LINK_1, hoursAgo(1)],
    ["device-drone-001", "DZ-D-001", "植保无人机 U01", "AGRICULTURAL_DRONE", "ONLINE", EAST_3, hoursAgo(3)],
    ["device-tractor-001", "DZ-T-001", "无人驾驶拖拉机 T01", "AUTO_TRACTOR", "OFFLINE", LINK_3, hoursAgo(6)],
  ];
  return rows.map(([id, deviceNo, name, type, status, plotCode, lastSeenAt]) => ({
    id,
    tenantId,
    deviceNo,
    name,
    type,
    status,
    ...(plotCode ? { plotCode } : {}),
    // 演示拖拉机与迁移 074 一致，走 MQTT 直连；其余设备保持 HTTP 回调。
    protocol: id === "device-tractor-001" ? "MQTT" : DEFAULT_DEVICE_PROTOCOL,
    driverId: getDeviceProtocolDriver(id === "device-tractor-001" ? "MQTT" : DEFAULT_DEVICE_PROTOCOL).id,
    lastSeenAt,
    createdAt: lastSeenAt ?? now,
    updatedAt: lastSeenAt ?? now,
  }));
}

export class InMemoryDeviceRepository implements DeviceRepository {
  private readonly devices: Device[];

  constructor(seed: Device[] = demoDevices()) {
    // 进出都拷贝：SQL 模式每次读的都是新对象，调用方改返回值改不动库；
    // 内存模式若把演示种子的引用留在数组里，一个调用方就能把整套台账改掉。
    this.devices = structuredClone(seed);
  }

  async list(tenantId: string, filter?: DeviceFilter): Promise<Device[]> {
    return this.devices
      .filter((device) => device.tenantId === tenantId && matchesFilter(device, filter))
      .sort(byDeviceNo)
      .map((device) => structuredClone(device));
  }

  async find(tenantId: string, id: string): Promise<Device | null> {
    const device = this.devices.find((item) => item.tenantId === tenantId && item.id === id);
    return device ? structuredClone(device) : null;
  }

  async findByDeviceNo(tenantId: string, deviceNo: string): Promise<Device | null> {
    const device = this.devices.find((item) => item.tenantId === tenantId && item.deviceNo === deviceNo);
    return device ? structuredClone(device) : null;
  }

  async create(tenantId: string, input: CreateDeviceInput): Promise<Device> {
    const timestamp = new Date().toISOString();
    const device: Device = {
      id: `device-${ulid()}`,
      tenantId,
      deviceNo: input.deviceNo,
      name: input.name,
      type: input.type,
      status: input.status,
      ...(input.plotCode ? { plotCode: input.plotCode } : {}),
      protocol: input.protocol ?? DEFAULT_DEVICE_PROTOCOL,
      driverId: input.driverId ?? getDeviceProtocolDriver(input.protocol ?? DEFAULT_DEVICE_PROTOCOL).id,
      ...(input.binding ? { binding: structuredClone(input.binding) } : {}),
      ...(input.mqtt ? { mqtt: structuredClone(input.mqtt) } : {}),
      ...(input.plc ? { plc: structuredClone(input.plc) } : {}),
      lastSeenAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.devices.push(device);
    return structuredClone(device);
  }

  async update(tenantId: string, id: string, input: UpdateDeviceInput): Promise<Device | null> {
    const index = this.devices.findIndex((device) => device.tenantId === tenantId && device.id === id);
    if (index < 0) return null;
    const updated = mergeDevice(this.devices[index]!, input, new Date().toISOString());
    this.devices.splice(index, 1, updated);
    return structuredClone(updated);
  }
}

/**
 * 把编辑入参合入当前台账：省略的字段保持原值，plotCode 传空串表示解绑地块。
 * 内存与 SQL 两种实现共用，避免「不传就不改」的语义在两处各写一遍。
 * tenantId 与 id 一样不可编辑——台账不能靠改配置在租户之间搬家。
 */
function mergeDevice(current: Device, input: UpdateDeviceInput, updatedAt: string): Device {
  const merged: Device = {
    ...current,
    name: input.name ?? current.name,
    type: input.type ?? current.type,
    status: input.status ?? current.status,
    protocol: input.protocol ?? current.protocol,
    driverId: input.driverId ?? getDeviceProtocolDriver(input.protocol ?? current.protocol).id,
    updatedAt,
  };
  if (input.plotCode === "") delete merged.plotCode;
  else if (input.plotCode !== undefined) merged.plotCode = input.plotCode;
  if (input.binding === null) delete merged.binding;
  else if (input.binding !== undefined) merged.binding = structuredClone(input.binding);
  if (input.mqtt === null) delete merged.mqtt;
  else if (input.mqtt !== undefined) merged.mqtt = structuredClone(input.mqtt);
  if (input.plc === null) delete merged.plc;
  else if (input.plc !== undefined) merged.plc = structuredClone(input.plc);
  return merged;
}

const DEVICE_COLUMNS = "id, tenant_id, device_no, name, type, status, plot_code, protocol, driver_id, binding_json, mqtt_config_json, plc_config_json, last_seen_at, created_at, updated_at";

/** JSONB 列在不同驱动下可能是对象也可能是文本，两种都收成绑定对象；空值返回 undefined 而不是 null */
function toBinding(row: Record<string, unknown>): ModbusBinding | undefined {
  const raw = row.binding_json;
  if (raw === null || raw === undefined || raw === "") return undefined;
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as ModbusBinding;
}

function toMqttConfig(row: Record<string, unknown>): MqttDeviceConfig | undefined {
  const raw = row.mqtt_config_json;
  if (raw === null || raw === undefined || raw === "") return undefined;
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as MqttDeviceConfig;
}

function toPlcConfig(row: Record<string, unknown>): PlcDeviceConfig | undefined {
  const raw = row.plc_config_json;
  if (raw === null || raw === undefined || raw === "") return undefined;
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as PlcDeviceConfig;
}

export class SqlDeviceRepository implements DeviceRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private toDevice(row: Record<string, unknown>): Device {
    const plotCode = String(row.plot_code ?? "");
    const binding = toBinding(row);
    const mqtt = toMqttConfig(row);
    const plc = toPlcConfig(row);
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      deviceNo: String(row.device_no),
      name: String(row.name),
      type: String(row.type) as DeviceType,
      status: String(row.status) as DeviceStatus,
      ...(plotCode ? { plotCode } : {}),
      protocol: String(row.protocol) as DeviceProtocol,
      driverId: String(row.driver_id || getDeviceProtocolDriver(String(row.protocol)).id),
      ...(binding ? { binding } : {}),
      ...(mqtt ? { mqtt } : {}),
      ...(plc ? { plc } : {}),
      lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? null : toIsoTimestamp(row.last_seen_at),
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: toIsoTimestamp(row.updated_at),
    };
  }

  async list(tenantId: string, filter?: DeviceFilter): Promise<Device[]> {
    const conditions: string[] = [];
    const values: unknown[] = [tenantId];
    if (filter?.type) {
      values.push(filter.type);
      conditions.push(`type = $${values.length}`);
    }
    if (filter?.status) {
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }
    if (filter?.plotCode) {
      values.push(filter.plotCode);
      conditions.push(`plot_code = $${values.length}`);
    }
    if (filter?.protocol) {
      values.push(filter.protocol);
      conditions.push(`protocol = $${values.length}`);
    }
    if (filter?.protocols?.length) {
      values.push(...filter.protocols);
      conditions.push(`protocol IN (${filter.protocols.map((_, index) => `$${values.length - filter.protocols!.length + index + 1}`).join(", ")})`);
    }
    if (filter?.keyword) {
      // 转义 LIKE 通配符，否则关键词里的 % 和 _ 会当通配符用，和内存模式的字面包含对不上
      values.push(likePattern(filter.keyword));
      conditions.push(`(name ILIKE $${values.length} OR device_no ILIKE $${values.length})`);
    }
    const where = `WHERE tenant_id = $1${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""}`;
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${DEVICE_COLUMNS} FROM devices ${where} ORDER BY device_no`,
      ...values,
    );
    return rows.map((row) => this.toDevice(row));
  }

  async find(tenantId: string, id: string): Promise<Device | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE tenant_id = $1 AND id = $2`,
      tenantId,
      id,
    );
    const row = rows[0];
    return row ? this.toDevice(row) : null;
  }

  async findByDeviceNo(tenantId: string, deviceNo: string): Promise<Device | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE tenant_id = $1 AND device_no = $2`,
      tenantId,
      deviceNo,
    );
    const row = rows[0];
    return row ? this.toDevice(row) : null;
  }

  async create(tenantId: string, input: CreateDeviceInput): Promise<Device> {
    const timestamp = new Date().toISOString();
    const device: Device = {
      id: `device-${ulid()}`,
      tenantId,
      deviceNo: input.deviceNo,
      name: input.name,
      type: input.type,
      status: input.status,
      ...(input.plotCode ? { plotCode: input.plotCode } : {}),
      protocol: input.protocol ?? DEFAULT_DEVICE_PROTOCOL,
      driverId: input.driverId ?? getDeviceProtocolDriver(input.protocol ?? DEFAULT_DEVICE_PROTOCOL).id,
      ...(input.binding ? { binding: input.binding } : {}),
      ...(input.mqtt ? { mqtt: input.mqtt } : {}),
      ...(input.plc ? { plc: input.plc } : {}),
      lastSeenAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.client.$executeRawUnsafe(
      `INSERT INTO devices (id, tenant_id, device_no, name, type, status, plot_code, protocol, driver_id, binding_json, mqtt_config_json, plc_config_json, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, NULL, $13::timestamptz, $14::timestamptz)`,
      device.id,
      device.tenantId,
      device.deviceNo,
      device.name,
      device.type,
      device.status,
      input.plotCode ?? "",
      device.protocol,
      device.driverId,
      device.binding ? JSON.stringify(device.binding) : null,
      device.mqtt ? JSON.stringify(device.mqtt) : null,
      device.plc ? JSON.stringify(device.plc) : null,
      device.createdAt,
      device.updatedAt,
    );
    return device;
  }

  async update(tenantId: string, id: string, input: UpdateDeviceInput): Promise<Device | null> {
    const current = await this.find(tenantId, id);
    if (!current) return null;
    const next = mergeDevice(current, input, new Date().toISOString());
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE devices SET name = $1, type = $2, status = $3, plot_code = $4, protocol = $5, driver_id = $6, binding_json = $7::jsonb, mqtt_config_json = $8::jsonb, plc_config_json = $9::jsonb, updated_at = $10::timestamptz
       WHERE tenant_id = $11 AND id = $12
       RETURNING ${DEVICE_COLUMNS}`,
      next.name,
      next.type,
      next.status,
      next.plotCode ?? "",
      next.protocol,
      next.driverId,
      next.binding ? JSON.stringify(next.binding) : null,
      next.mqtt ? JSON.stringify(next.mqtt) : null,
      next.plc ? JSON.stringify(next.plc) : null,
      next.updatedAt,
      tenantId,
      id,
    );
    const row = rows[0];
    return row ? this.toDevice(row) : null;
  }
}
