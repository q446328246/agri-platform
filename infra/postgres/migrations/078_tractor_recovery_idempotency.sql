-- 078：拖拉机分步指令幂等与作业执行租约
--
-- 控制服务先建单成功、拖拉机尚未回写 commandId 时崩溃，重试必须复用同一指令；
-- 多实例恢复或人工重复触发执行时，用可续租的 owner/until 保证同一作业只有一个执行者。

ALTER TABLE control_commands
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_control_commands_idempotency
    ON control_commands (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE tractor_jobs
    ADD COLUMN IF NOT EXISTS execution_owner text,
    ADD COLUMN IF NOT EXISTS execution_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_tractor_jobs_recovery
    ON tractor_jobs (tenant_id, status, created_at)
    WHERE status IN ('PLANNED', 'RUNNING');
