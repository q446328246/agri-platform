-- TimescaleDB 时序化（A1）：telemetry_readings 转为 hypertable，叠加查询索引、
-- 连续聚合与保留策略，让高频遥测可长期留存、查询不随数据量退化。
--
-- 幂等：迁移机制本就只执行一次，这里再加一层保护，便于在已应用过的库上手工回补。

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- hypertable 唯一索引必须包含分区时间列：原主键 (id) 不含 recorded_at，
-- 先重建为 (id, recorded_at)——id 本就唯一，唯一性语义不变。
ALTER TABLE telemetry_readings DROP CONSTRAINT IF EXISTS telemetry_readings_pkey;
ALTER TABLE telemetry_readings ADD PRIMARY KEY (id, recorded_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'telemetry_readings'
  ) THEN
    PERFORM create_hypertable('telemetry_readings', 'recorded_at',
      chunk_time_interval => INTERVAL '7 day',
      migrate_data => TRUE,
      if_not_exists => TRUE);
  END IF;
END
$$;

-- 设备/指标/深度与地块维度的时间索引：latest 与 history 靠它定位分块
CREATE INDEX IF NOT EXISTS idx_readings_device_metric_time
  ON telemetry_readings (device_id, metric, depth_cm, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_plot_time
  ON telemetry_readings (plot_code, recorded_at DESC);

-- 连续聚合：加速「每设备每指标（含深度）最新干净读数」，供 latest 读取。
-- 分组维度与 SqlReadingRepository.latest 的 ROW_NUMBER PARTITION 完全对齐（device/metric/depth），
-- 避免 plot_code/unit 变化把同一设备拆成多行；value/unit/plot_code/id 都取最新时刻那一行的值，
-- 而不是 max(value)——max(value) 会把历史最大值当成最新读数，语义错误。
-- 连续聚合：按 1 分钟桶聚合，每桶每设备/指标/深度保留最新读数。
-- 分组维度与 SqlReadingRepository.latest 的 ROW_NUMBER PARTITION 对齐（device/metric/depth），
-- 避免 plot_code/unit 变化把同一设备拆成多行；value/unit/plot_code/id 都取最新时刻那一行的值，
-- 而不是 max(value)——max(value) 会把历史最大值当成最新读数，语义错误。
-- materialized_only=false 走实时聚合，覆盖窗口内未刷新的新读数。
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_readings_latest
  WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 minute', recorded_at) AS bucket,
       device_id, metric, depth_cm,
       last(id, recorded_at) AS id,
       max(recorded_at) AS recorded_at,
       last(value, recorded_at) AS value,
       last(unit, recorded_at) AS unit,
       last(plot_code, recorded_at) AS plot_code
  FROM telemetry_readings
 WHERE quality_flags = '[]'::jsonb
 GROUP BY bucket, device_id, metric, depth_cm
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_readings_latest',
  start_offset => INTERVAL '30 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '15 min',
  if_not_exists => TRUE);

-- 保留策略：明细读数保留 90 天，更早的由 TimescaleDB 自动清理
-- （2.32 签名改为 drop_after，旧 (policy_name, interval) 写法已不存在）
SELECT add_retention_policy('telemetry_readings',
  drop_after => INTERVAL '90 days',
  if_not_exists => TRUE);
