-- 002：智能决策与遥测持久化
-- decision：规则以数据形式存储（支持热更新），处方留存输入数据与命中规则（决策留痕）。
-- telemetry：读数与告警落库，支撑按设备与时间窗的历史查询。

CREATE TABLE IF NOT EXISTS decision_rules (
  id TEXT PRIMARY KEY,
  rule_name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('IRRIGATION', 'FERTILIZATION', 'PEST_WARNING')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  expression TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json JSONB NOT NULL,
  action_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_decision_rules_enabled ON decision_rules (enabled, priority) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS decision_prescriptions (
  id TEXT PRIMARY KEY,
  plot_code TEXT NOT NULL,
  plot_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('RECOMMENDED', 'NO_ACTION')),
  soil_moisture NUMERIC(8, 2),
  rain_probability NUMERIC(8, 2),
  growth_stage TEXT NOT NULL DEFAULT '',
  inputs_json JSONB NOT NULL,
  matched_rules_json JSONB NOT NULL,
  actions_json JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_decision_prescriptions_plot ON decision_prescriptions (plot_code, generated_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_readings (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  plot_code TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,
  value NUMERIC(16, 4) NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_readings_device_time ON telemetry_readings (device_id, metric, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_readings_time ON telemetry_readings (recorded_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_alerts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL DEFAULT '',
  plot_code TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL,
  metric TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  handled BOOLEAN NOT NULL DEFAULT FALSE,
  handled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_telemetry_alerts_pending ON telemetry_alerts (handled, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  tenant_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_outbox_pending ON decision_outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS telemetry_outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  tenant_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_telemetry_outbox_pending ON telemetry_outbox (created_at) WHERE published_at IS NULL;
