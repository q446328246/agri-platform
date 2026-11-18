-- 048: 视频 AI 事件类型扩展（A12）+ 消息派单处置（A3 伴随小项）。
-- 两者同属「识别告警 → 消息处置」链路，登记在同一迁移里，避免 P2 批外再占编号。
--
-- A12：AI 事件从虫情一类扩到七类（PEST/PERSON_INTRUSION/MACHINE_STATUS/FLOOD/LODGING/FIRE/SMOKE）。
-- event_type 缺省 PEST 兼容存量行；pest_type 放宽为「PEST 时必填、其余可空」，
-- 条件必填用 CHECK 表达，与 @agri/contracts 的 AiEventType 白名单同步。
--
-- A3：消息中心补派单处置字段。忽略（041）是「确认无需处置」，派单是「转交线下处置」，
-- 两者互斥使用；派单顺带标已读，与忽略同一口径。

ALTER TABLE video_ai_events ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'PEST';
ALTER TABLE video_ai_events DROP CONSTRAINT IF EXISTS video_ai_events_event_type_check;
ALTER TABLE video_ai_events ADD CONSTRAINT video_ai_events_event_type_check
  CHECK (event_type IN ('PEST', 'PERSON_INTRUSION', 'MACHINE_STATUS', 'FLOOD', 'LODGING', 'FIRE', 'SMOKE'));

-- 存量 pest_type 是 NOT NULL + 非空 CHECK；先放宽列约束再换条件 CHECK，顺序不能反
ALTER TABLE video_ai_events ALTER COLUMN pest_type SET DEFAULT '';
ALTER TABLE video_ai_events DROP CONSTRAINT IF EXISTS video_ai_events_pest_type_check;
ALTER TABLE video_ai_events ADD CONSTRAINT video_ai_events_pest_type_check
  CHECK (event_type <> 'PEST' OR length(trim(pest_type)) > 0);

CREATE INDEX IF NOT EXISTS idx_video_ai_events_type ON video_ai_events (tenant_id, event_type, received_at DESC);

ALTER TABLE ops_messages ADD COLUMN IF NOT EXISTS dispatched BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ops_messages ADD COLUMN IF NOT EXISTS dispatched_by TEXT NOT NULL DEFAULT '';
ALTER TABLE ops_messages ADD COLUMN IF NOT EXISTS dispatch_note TEXT NOT NULL DEFAULT '';
ALTER TABLE ops_messages ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;