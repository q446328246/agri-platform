-- 028：地块建档事件本地消息表
-- 此前地块服务只在单进程演示里把 PlotCreated 写进内存消息表，跨进程不可靠。
-- 建 plot_outbox 后，建档与待投递事件同事务落库，HTTP 模式由中继投递到共享事件日志，
-- 与 decision_outbox / telemetry_outbox 同构，保证「留痕落库」与「事件发布」要么同时成功要么同时回滚。

CREATE TABLE IF NOT EXISTS plot_outbox (
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
CREATE INDEX IF NOT EXISTS idx_plot_outbox_pending ON plot_outbox (created_at) WHERE published_at IS NULL;
