/** 地图测量模式：distance 测距（米/公里）、area 测面（亩，与地块台账同一套面积公式）。
 *  类型独立成文件：Vue <script setup> 不支持 export type，组件与驾驶舱共用此定义。 */
export type MeasureMode = 'distance' | 'area'