-- 081：记录控制指令暂停/恢复时序，拒绝跨恢复周期到达的陈旧回执。
ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ;
