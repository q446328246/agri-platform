-- 006：消息订阅偏好与去重键
--
-- dedupe_key：事件消费生成的消息按模板给出的聚合键去重（越限告警按小时聚合），
-- 与 source_event_id 的「同一事件只落一条」互补：前者抑制告警风暴，后者防止重放。
-- ops_message_preferences：按租户 + 来源主题保存订阅开关与最低级别，
-- 消费时先查偏好再决定是否落库；没有记录视为全部启用、最低 INFO。

ALTER TABLE ops_messages ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_messages_dedupe ON ops_messages (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops_message_preferences (
  tenant_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  min_level TEXT NOT NULL DEFAULT 'INFO' CHECK (min_level IN ('INFO', 'WARNING', 'CRITICAL')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, topic)
);
