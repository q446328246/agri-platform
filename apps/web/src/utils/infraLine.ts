import type { Ref } from 'vue'
import type { InfraLine, InfraLineType } from '@/api'

/** 一张图把后端管线类型归入参考图的三类，机耕道单独常显 */
export type LineCat = 'WATER' | 'ELECTRIC' | 'NET'

export const lineCategories: Array<{ key: LineCat; label: string }> = [
  { key: 'WATER', label: '水线' },
  { key: 'ELECTRIC', label: '电线' },
  { key: 'NET', label: '网线' },
]

export const lineCatColors: Record<LineCat, string> = { WATER: '#00d4ff', ELECTRIC: '#f3c969', NET: '#7fe7ff' }
export const roadColor = '#b0bec5'

export const lineTypeOptions: Array<{ value: InfraLineType; label: string }> = [
  { value: 'IRRIGATION_PIPE', label: '灌水管（水线）' },
  { value: 'FERTILIZATION_PIPE', label: '施肥管（水线）' },
  { value: 'ELECTRIC_LINE', label: '电力线（电线）' },
  { value: 'TELECOM', label: '通信网线（网线）' },
  { value: 'ROAD', label: '机耕道' },
]

export const defaultTypeOfCat: Record<LineCat, InfraLineType> = { WATER: 'IRRIGATION_PIPE', ELECTRIC: 'ELECTRIC_LINE', NET: 'TELECOM' }

/** 灌溉/施肥管→水线，电力线→电线，通信线→网线，机耕道自成一类 */
export function categorize(type: InfraLineType): LineCat | 'ROAD' {
  if (type === 'IRRIGATION_PIPE' || type === 'FERTILIZATION_PIPE') return 'WATER'
  if (type === 'ELECTRIC_LINE') return 'ELECTRIC'
  if (type === 'ROAD') return 'ROAD'
  return 'NET'
}

export function catColor(cat: LineCat): string {
  return lineCatColors[cat]
}

export function lineColorOf(type: InfraLineType): string {
  const cat = categorize(type)
  return cat === 'ROAD' ? roadColor : lineCatColors[cat]
}

export function lineTypeLabel(type: InfraLineType): string {
  return lineTypeOptions.find((opt) => opt.value === type)?.label ?? type
}

export function catLabel(cat: LineCat | 'ROAD'): string {
  return cat === 'ROAD' ? '机耕道' : lineCategories.find((item) => item.key === cat)?.label ?? cat
}

/** 管线列表的筛选口径：一个分类含两种线型（如水线含灌水管与施肥管），故在前端按分类过滤 */
export type LineFilter = LineCat | 'ROAD' | 'ALL'
export const lineFilterOptions: Array<{ value: LineFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'WATER', label: '水线' },
  { value: 'ELECTRIC', label: '电线' },
  { value: 'NET', label: '网线' },
  { value: 'ROAD', label: '机耕道' },
]

/** 一张图注入给管线列表面板的地图入口：列表只管查询，改删都在地图上完成 */
export interface LinePanelBridge {
  /** 地图侧每次重新加载管线后自增，列表据此刷新，避免编辑后停留在旧数据 */
  revision: Ref<number>
  locate(line: InfraLine): void
  edit(line: InfraLine): void
  /** 含二次确认与地图图层刷新，返回后列表自行重查 */
  remove(line: InfraLine): Promise<void>
}
export const LINE_PANEL_BRIDGE = 'cockpit-line-panel-bridge'