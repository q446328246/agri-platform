-- 003：事件总线、消息中心与处方效果回流
-- event_log：各服务本地消息表中继后写入的共享主题日志，供跨进程消费。
-- event_log_offsets：消费者组位点，保证重启后从上次位置续读。
-- ops_messages：消息中心记录，页面与事件消费共用；source_event_id 唯一防止重复生成。
-- decision_prescription_outcomes：处方执行后的效果评估与阈值调整建议。

CREATE TABLE IF NOT EXISTS event_log (
  seq BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  version INTEGER NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  producer TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_log_topic_seq ON event_log (topic, seq);
CREATE INDEX IF NOT EXISTS idx_event_log_occurred_at ON event_log (occurred_at DESC);

CREATE TABLE IF NOT EXISTS event_log_offsets (
  consumer_group TEXT NOT NULL,
  topic TEXT NOT NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_group, topic)
);

CREATE TABLE IF NOT EXISTS ops_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ALERT', 'NOTICE')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARNING', 'CRITICAL')),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  plot_code TEXT,
  source_event_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ops_messages_tenant_created ON ops_messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_messages_unread ON ops_messages (is_read, created_at DESC) WHERE is_read = FALSE;

CREATE TABLE IF NOT EXISTS decision_prescription_outcomes (
  id TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL,
  plot_code TEXT NOT NULL,
  rule_id TEXT,
  soil_moisture_before NUMERIC(8, 2) NOT NULL,
  soil_moisture_after NUMERIC(8, 2) NOT NULL,
  target NUMERIC(8, 2) NOT NULL,
  delta NUMERIC(8, 2) NOT NULL,
  effective BOOLEAN NOT NULL,
  suggestion_json JSONB,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT NOT NULL DEFAULT '',
  evaluated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_prescription ON decision_prescription_outcomes (prescription_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_plot ON decision_prescription_outcomes (plot_code, evaluated_at DESC);
