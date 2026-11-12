-- 033：控制指令事件本地消息表
-- 指令状态跃迁要对外发声两处：DONE 回执回流灌溉完成事件，超时收口推「超时未回执」事件。
-- 只写内存消息表的话，跨进程不可靠——HTTP 模式重启即丢，事件日志里查不到这条记录。
-- 建 control_outbox 后，跃迁与待投递事件同事务落库，由中继投递到共享事件日志，
-- 与 plot_outbox / decision_outbox / telemetry_outbox 同构，保证「状态改到位」与「事件发出去」同时成功。

CREATE TABLE IF NOT EXISTS control_outbox (
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
CREATE INDEX IF NOT EXISTS idx_control_outbox_pending ON control_outbox (created_at) WHERE published_at IS NULL;
