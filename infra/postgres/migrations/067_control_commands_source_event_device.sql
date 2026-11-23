-- 067：控制指令来源事件去重键升级为（事件 + 设备）
--
-- 起因：自动指令（处方/越限）按地块解析真实水肥设备后需逐台建单，原唯一索引
-- `uq_control_commands_source_event (source_event_id)` 强制「一事件一指令」，
-- 同一事件的第二台设备建单被 ON CONFLICT DO NOTHING 静默吞掉，自动指令只剩一台。
-- 重放防护的正确粒度是「同一事件对同一设备只建一条」，与设备维度的逐台建单兼容。
--
-- 约定：
-- 1. 旧索引是部分唯一索引（source_event_id IS NOT NULL），新索引同口径保持部分唯一；
-- 2. 既有数据不存在同（事件, 设备）重复（旧索引下更严格），直接重建索引安全；
-- 3. 可重复执行（IF EXISTS / IF NOT EXISTS）。

DROP INDEX IF EXISTS uq_control_commands_source_event;

CREATE UNIQUE INDEX IF NOT EXISTS uq_control_commands_source_event_device
  ON control_commands (source_event_id, device_id)
  WHERE source_event_id IS NOT NULL;
