-- 040 控制指令支持取消（自动停灌）
--
-- 墒情达到上限自动停灌（开发方案 8.4/9.4）需要把尚未被现场网关领取的灌溉指令
-- 拦在执行之前：QUEUED 是唯一还能安全撤回的状态，领取（SENT）之后只能靠急停。
-- 因此新增终态 CANCELLED，仅允许 QUEUED → CANCELLED（跃迁表在 control.repository.ts）。
-- 旧行都落在新枚举子集内，不需要回填。
ALTER TABLE control_commands DROP CONSTRAINT IF EXISTS control_commands_status_check;
ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_status_check
  CHECK (status IN ('QUEUED', 'SENT', 'ACKED', 'DONE', 'FAILED', 'CANCELLED'));