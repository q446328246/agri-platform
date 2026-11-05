-- 005：控制指令表
--
-- 控制指令有两条来源：操作人在页面上二次确认后人工下达，以及事件消费
-- 依据越限/处方事件自动生成。自动指令以来源事件唯一，重复投递会命中
-- 唯一索引而不产生第二条指令。

CREATE TABLE IF NOT EXISTS control_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  plot_code TEXT NOT NULL DEFAULT '',
  operator_id TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ,
  type TEXT NOT NULL CHECK (type IN ('SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION')),
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENT', 'FAILED')),
  origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL', 'EVENT')),
  source_event_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_control_commands_plot_created ON control_commands (plot_code, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_control_commands_source_event ON control_commands (source_event_id) WHERE source_event_id IS NOT NULL;
