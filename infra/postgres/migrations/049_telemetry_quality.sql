-- 049: 遥测数据质量治理（A11，P2 台账与契约批）。
-- 上报链路补三类可疑标记：超量程 OUT_OF_RANGE / 连续不变 STUCK_VALUE / 时间戳异常 TIMESTAMP_ANOMALY。
-- 标记只标注不拒收（拒收会丢现场原始值）；曲线与汇总默认剔除带标记读数，
-- 原始历史查询仍返回全量并携带标记，供审计回查。异常同时落 telemetry_quality_logs 留痕。
-- quality_flags 用 JSONB 字符串数组，与库内其它复杂配置字段同一约定。

ALTER TABLE telemetry_readings ADD COLUMN IF NOT EXISTS quality_flags JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 曲线/汇总剔除可疑读数是热路径，部分索引只覆盖干净行
CREATE INDEX IF NOT EXISTS idx_telemetry_readings_clean ON telemetry_readings (device_id, metric, recorded_at DESC)
  WHERE quality_flags = '[]'::jsonb;

CREATE TABLE IF NOT EXISTS telemetry_quality_logs (
  id TEXT PRIMARY KEY,
  reading_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  plot_code TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,
  value NUMERIC(16, 4) NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  recorded_at TIMESTAMPTZ NOT NULL,
  flags JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_quality_logs_time ON telemetry_quality_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_quality_logs_device ON telemetry_quality_logs (device_id, metric, created_at DESC);