-- 031 控制指令回执状态机
--
-- 指令此前只有 QUEUED/SENT/FAILED 三态，且全仓没有任何代码把 QUEUED 推进到 SENT：
-- 入队即终点，设备是否接收、是否执行到位、失败在哪一步都无从复盘。本迁移把生命周期
-- 补全为 QUEUED → SENT → ACKED → DONE，任一非终态都能被 FAILED 收口，并补上下发/
-- 接收/结束时间、结果快照与乐观锁版本。旧行都落在新枚举子集内，不需要回填。

ALTER TABLE control_commands DROP CONSTRAINT IF EXISTS control_commands_status_check;
ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_status_check
  CHECK (status IN ('QUEUED', 'SENT', 'ACKED', 'DONE', 'FAILED'));

-- 急停指令：与农事四类同用一条回执链路，执行完成必须带到位确认（见 control-service 回执校验）
ALTER TABLE control_commands DROP CONSTRAINT IF EXISTS control_commands_type_check;
ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_type_check
  CHECK (type IN ('SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION', 'ESTOP'));

ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ;
ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS receipt_message TEXT;
ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS result_json JSONB;
ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 回执时间只能顺着生命周期走：先下发、再接收、后结束。乱序写入多为对接方拼错时间字段，
-- 让它在这里报错比事后对不上台账好排查。历史行这些列全为 NULL，不受约束影响。
ALTER TABLE control_commands DROP CONSTRAINT IF EXISTS control_commands_receipt_order_check;
ALTER TABLE control_commands ADD CONSTRAINT control_commands_receipt_order_check CHECK (
  (sent_at IS NULL OR acked_at IS NULL OR acked_at >= sent_at)
  AND (acked_at IS NULL OR finished_at IS NULL OR finished_at >= acked_at)
  AND (sent_at IS NULL OR finished_at IS NULL OR finished_at >= sent_at)
);

-- 待回执看板与超时筛查只扫非终态；终态行随时间增长，用部分索引避开它们
CREATE INDEX IF NOT EXISTS idx_control_commands_open ON control_commands (created_at DESC, id)
  WHERE status IN ('QUEUED', 'SENT', 'ACKED');
