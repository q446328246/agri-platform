/** 业务文案映射：与桌面端/后端白名单同口径，新增枚举只改这里 */

export const TASK_TYPE_LABELS: Record<string, string> = {
  TILLAGE: '耕整地', SEEDING: '播种', IRRIGATION: '灌溉', WEEDING: '除草', SPRAYING: '喷防', FERTILIZATION: '施肥'
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  PENDING: '待执行', RUNNING: '进行中', COMPLETED: '已完成', CANCELLED: '已取消'
}

/** 生产档案事件：与桌面端 TRACE_EVENT_LABELS 一致 */
export const TRACE_EVENT_LABELS: Record<string, string> = {
  PRESCRIPTION_ISSUED: '处方生成',
  IRRIGATION_FINISHED: '灌溉完成',
  FERTILIZATION_FINISHED: '施肥完成',
  FARM_OPERATION: '农事作业',
  OPERATION_COMPLETED: '作业完成',
  INPUT_MATERIAL: '投入品领用',
  SOWING: '播种',
  HARVEST: '采收'
}

/** 人工补录可选事件：灌溉/施肥完成只认设备结单，移动端同样不提供 */
export const MANUAL_TRACE_EVENTS = Object.keys(TRACE_EVENT_LABELS).filter((event) => event !== 'IRRIGATION_FINISHED' && event !== 'FERTILIZATION_FINISHED')

export const ALERT_LEVEL_LABELS: Record<string, string> = { CRITICAL: '严重', WARNING: '警告', INFO: '提示' }