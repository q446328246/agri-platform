/**
 * 设备台账的类型与状态取值。
 *
 * 与 iot-service 的 DEVICE_TYPES / DEVICE_STATUSES 常量、迁移 014 的 CHECK 约束同口径，
 * 新增类型时三处一起改；这里集中一份，列表筛选、详情展示与新增表单都从这里取，
 * 避免同一个类型在各页面各写一份中文标签。
 */

export const deviceTypeOptions: Array<{ value: string; label: string }> = [
  { value: 'WEATHER_STATION', label: '气象站' },
  { value: 'SOIL_SENSOR', label: '墒情传感器' },
  { value: 'INTEGRATED_STATION', label: '综合监测站' },
  { value: 'REMOTE_SENSE', label: '遥感反演节点' },
  { value: 'INSECT_LAMP', label: '虫情测报灯' },
  { value: 'FERTILIZER_VALVE', label: '水肥阀' },
  { value: 'IRRIGATION_VALVE', label: '灌溉阀门' },
  { value: 'IRRIGATION_PUMP', label: '灌溉泵站' },
  { value: 'AGRICULTURAL_DRONE', label: '植保无人机' },
  { value: 'AUTO_TRACTOR', label: '无人驾驶拖拉机' },
]

/** 新登记设备只能是在线或离线，故障与维护中由上报侧判定，不让手工填 */
export const deviceStatusOptions: Array<{ value: 'ONLINE' | 'OFFLINE'; label: string }> = [
  { value: 'ONLINE', label: '在线' },
  { value: 'OFFLINE', label: '离线' },
]

const typeLabels = new Map(deviceTypeOptions.map((item) => [item.value, item.label]))

/** 台账类型转中文；未收录的取值原样显示，便于发现后端新增而前端未同步的类型 */
export function deviceTypeLabel(type?: string | null): string {
  if (!type) return '-'
  return typeLabels.get(type) ?? type
}
