-- 041 消息中心支持忽略处置
--
-- 告警处置（开发方案 5.4）要求消息除了标已读还能「忽略」：确认无需处置的告警
-- 从待办里拿掉，但记录保留可回查。is_read 记「看没看过」，ignored 记「处不处置」，
-- 两列各管各的；未读角标与缺省列表都不再计入已忽略的消息。
ALTER TABLE ops_messages ADD COLUMN IF NOT EXISTS ignored BOOLEAN NOT NULL DEFAULT FALSE;