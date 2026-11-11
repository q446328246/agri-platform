-- 019：分层土壤墒情（开发方案 6.1）
--
-- 土壤传感器按浅层/中层/深层分层埋设，同一指标在多个深度分别采集。
-- 给读数增加 depth_cm 深度维度（厘米）：NULL 表示气象/苗情等非分层指标，
-- 土壤指标按深度区分，latest 与 history 据此分组/筛选，前端按深度展示与回看曲线。

ALTER TABLE telemetry_readings ADD COLUMN IF NOT EXISTS depth_cm SMALLINT;

-- 地块 + 指标 + 深度 + 时间：支撑「按地块按深度回看历史曲线」
CREATE INDEX IF NOT EXISTS idx_telemetry_readings_plot_metric_depth
  ON telemetry_readings (plot_code, metric, depth_cm, recorded_at DESC);