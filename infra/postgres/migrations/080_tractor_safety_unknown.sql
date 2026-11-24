-- 080：恢复结果未知的拖拉机作业进入 SAFETY_UNKNOWN，必须急停确认后才能终态化。
ALTER TABLE tractor_jobs DROP CONSTRAINT IF EXISTS tractor_jobs_status_check;
ALTER TABLE tractor_jobs
  ADD CONSTRAINT tractor_jobs_status_check
  CHECK (status IN ('PLANNED', 'RUNNING', 'PAUSED', 'SAFETY_UNKNOWN', 'COMPLETED', 'FAILED', 'ESTOPPED'));
