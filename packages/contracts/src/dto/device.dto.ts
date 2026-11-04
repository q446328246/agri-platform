/** 设备在线状态 */
export type DeviceStatus = "ONLINE" | "OFFLINE" | "UNKNOWN";

/** 设备简要信息 */
export interface DeviceBrief {
  deviceId: string;
  deviceCode: string;
  /** 设备类别，取值来自 DeviceCategory */
  category: string;
  /** 在线状态：true 在线、false 离线 */
  online: boolean;
  /** 最近一次通信时间，ISO 8601 UTC */
  lastSeenAt: string;
}
