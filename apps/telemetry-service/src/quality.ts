/**
 * 遥测数据质量判定（A11，迁移 049）。
 *
 * 上报链路补三类可疑标记：超量程 OUT_OF_RANGE / 连续不变 STUCK_VALUE / 时间戳异常 TIMESTAMP_ANOMALY。
 * 标记只标注不拒收——拒收会丢现场原始值；曲线与汇总默认剔除带标记读数，
 * 原始历史查询仍返回全量并携带标记，供审计回查。判定是纯函数，不依赖仓储与 HTTP。
 */

/** 质量标记白名单，与 telemetry_quality_logs.flags 的取值同步 */
export const QUALITY_FLAGS = ["OUT_OF_RANGE", "STUCK_VALUE", "TIMESTAMP_ANOMALY"] as const;

export type QualityFlag = (typeof QUALITY_FLAGS)[number];

/**
 * 指标物理量程（闭区间）。量程外的读数大概率是传感器故障或单位错报；
 * 未登记的指标不做量程判定，避免把新指标误伤成可疑。
 */
export const METRIC_RANGES: Record<string, [number, number]> = {
  soilMoisture: [0, 100],
  airTemperature: [-40, 60],
  airHumidity: [0, 100],
  windSpeed: [0, 75],
  rainfall: [0, 500],
  canopyCoverage: [0, 100],
  pestCount: [0, 100_000],
  diseaseIndex: [0, 100],
  soilPh: [0, 14],
  lightIntensity: [0, 200_000],
  co2Concentration: [0, 5000],
};

/** 连续同值判定阈值：含本次共 5 次一致视为传感器卡死 */
export const STUCK_WINDOW = 5;

/** 时间戳异常窗口：超前 5 分钟以上或陈旧 30 天以上视为异常 */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;
export const STALE_LIMIT_MS = 30 * 24 * 3600_000;

/**
 * 判定一条读数的质量标记。
 * @param input 本次上报的指标、数值与时间
 * @param recentValues 同设备同指标（同深度）最近的历史数值，按时间倒序，不含本次
 * @param nowMs 判定基准时间，测试可注入
 */
export function detectQualityFlags(
  input: { metric: string; value: number; recordedAt: string },
  recentValues: number[],
  nowMs: number = Date.now(),
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const range = METRIC_RANGES[input.metric];
  if (!Number.isFinite(input.value) || (range && (input.value < range[0] || input.value > range[1]))) {
    flags.push("OUT_OF_RANGE");
  }
  // 含本次连续 STUCK_WINDOW 次同值：历史需凑满窗口减一条且全部与本次相等
  const window = recentValues.slice(0, STUCK_WINDOW - 1);
  if (window.length >= STUCK_WINDOW - 1 && window.every((value) => value === input.value)) {
    flags.push("STUCK_VALUE");
  }
  const recordedMs = new Date(input.recordedAt).getTime();
  if (Number.isNaN(recordedMs) || recordedMs - nowMs > FUTURE_TOLERANCE_MS || nowMs - recordedMs > STALE_LIMIT_MS) {
    flags.push("TIMESTAMP_ANOMALY");
  }
  return flags;
}