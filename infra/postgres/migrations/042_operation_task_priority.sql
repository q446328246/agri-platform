-- 042 农事任务优先级
--
-- 任务调度（开发方案 8.7）要求任务可设优先级，供排程与冲突提示时区分轻重缓急。
-- 三档枚举：HIGH 紧急 / NORMAL 常规（缺省）/ LOW 可延后；存量任务一律按常规处理。
-- 冲突检测（同地块/同负责人计划时间重叠）在 operation-service 内现算，不落库。
ALTER TABLE operation_tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE operation_tasks DROP CONSTRAINT IF EXISTS operation_tasks_priority_check;
ALTER TABLE operation_tasks
  ADD CONSTRAINT operation_tasks_priority_check
  CHECK (priority IN ('HIGH', 'NORMAL', 'LOW'));