-- 050 控制指令类型扩展 + 暂停态 + 定时执行（A7 / A6）
--
-- 开发方案 8.1/8.8 要求指令覆盖「启动、暂停、停靠、切换机具、返航」与「一键断电」，
-- 此前只有农事四类 + 急停五码。本迁移扩到十一码：新增 PAUSE（暂停在途作业）、
-- RESUME（恢复已暂停作业）、RETURN_HOME（一键返航）、POWER_OFF（一键断电）、
-- TOOL_SWITCH（切换机具）、TILLAGE（耕整地）。PAUSE/RESUME 通过 parameters.targetCommandId
-- 指向目标指令，其 DONE 回执联动目标状态（见 control-service 回执处理）。
--
-- 状态机补 PAUSED：SENT/ACKED 可被暂停（设备自主上报或 PAUSE 指令结单联动），
-- PAUSED 可恢复（ACKED）、结单（DONE）或失败收口（FAILED）。PAUSED 仍属在途，
-- 超时收口与待回执看板照常覆盖——暂停不是结单，没人恢复的指令最终仍要有人被告知。
--
-- scheduled_at 支撑定时执行（方案 8.1「定时浇水」）：入队时可选给出未来时刻，
-- 设备网关轮询 /device/pending 只领取已到期的指令，到期自然进入执行队列，
-- 不需要独立定时器。超时起点同步改为 GREATEST(created_at, scheduled_at)，
-- 免得一条预约明早执行的指令今晚就被收口成失败。

ALTER TABLE control_commands DROP CONSTRAINT IF EXISTS control_commands_type_check;
ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_type_check
  CHECK (type IN ('SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION', 'ESTOP',
                  'PAUSE', 'RESUME', 'RETURN_HOME', 'POWER_OFF', 'TOOL_SWITCH', 'TILLAGE'));

ALTER TABLE control_commands DROP CONSTRAINT IF EXISTS control_commands_status_check;
ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_status_check
  CHECK (status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED'));

ALTER TABLE control_commands ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- 部分索引的谓词须与代码 PENDING_STATUSES 同步含 PAUSED，否则暂停行扫不到索引
DROP INDEX IF EXISTS idx_control_commands_open;
CREATE INDEX idx_control_commands_open ON control_commands (created_at DESC, id)
  WHERE status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED');