-- A2 幂等去重（平台侧兜底）：遥测按 (deviceId, metric, depthCm, recordedAt) 去重。
-- 设备侧 MQTT QoS 1/2 与断网补传都会重复投递，重复上报不能产生第二条读数、也不能重复告警。
--
-- 分层与非分层各建一个部分唯一索引：Postgres 唯一索引把 NULL 视为互不相同，
-- 非分层读数 depth_cm 为 NULL，必须单列才能去重。两列都带 recorded_at，
-- 满足 hypertable 唯一索引必须包含分区时间列的要求。
-- 建索引前先清理历史完全重复键（保留 id 最小的一条），避免存量脏数据阻断索引。

DELETE FROM telemetry_readings a
USING telemetry_readings b
WHERE a.id > b.id
  AND a.device_id = b.device_id
  AND a.metric = b.metric
  AND a.recorded_at = b.recorded_at
  AND ((a.depth_cm IS NULL AND b.depth_cm IS NULL) OR (a.depth_cm = b.depth_cm));

CREATE UNIQUE INDEX IF NOT EXISTS uq_readings_dedup_no_depth
  ON telemetry_readings (device_id, metric, recorded_at)
  WHERE depth_cm IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_readings_dedup_with_depth
  ON telemetry_readings (device_id, metric, depth_cm, recorded_at)
  WHERE depth_cm IS NOT NULL;
