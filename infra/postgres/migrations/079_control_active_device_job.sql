-- 079：设备级作业互锁
--
-- 应用层“先查在途再建单”无法挡住并发请求；由数据库对同一租户、设备的
-- 作业类在途指令建部分唯一索引。控制类 PAUSE/RESUME/ESTOP 不受此约束。

DO $$
BEGIN
    IF EXISTS (
        SELECT tenant_id, device_id
        FROM control_commands
        WHERE type IN ('SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION', 'TOOL_SWITCH', 'RETURN_HOME', 'TILLAGE')
          AND status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED')
        GROUP BY tenant_id, device_id
        HAVING COUNT(*) FILTER (WHERE status <> 'QUEUED') > 1
    ) THEN
        RAISE EXCEPTION '同一设备存在多条已执行中的作业指令，请先人工收口或急停后再应用设备级作业互锁';
    END IF;
END
$$;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY tenant_id, device_id
               ORDER BY CASE WHEN status <> 'QUEUED' THEN 0 ELSE 1 END, created_at DESC, id DESC
           ) AS keep_rank
    FROM control_commands
    WHERE type IN ('SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION', 'TOOL_SWITCH', 'RETURN_HOME', 'TILLAGE')
      AND status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED')
)
UPDATE control_commands AS command
SET status = 'CANCELLED',
    version = command.version + 1,
    finished_at = COALESCE(command.finished_at, now()),
    receipt_message = CONCAT_WS('；', NULLIF(command.receipt_message, ''), '设备级作业互锁启用：保留最新作业指令，取消未执行的重复指令')
FROM ranked
WHERE command.id = ranked.id
  AND ranked.keep_rank > 1
  AND command.status = 'QUEUED';

CREATE UNIQUE INDEX IF NOT EXISTS uq_control_commands_active_device_job
    ON control_commands (tenant_id, device_id)
    WHERE type IN (
        'SEEDING', 'IRRIGATION', 'WEEDING', 'FERTILIZATION',
        'TOOL_SWITCH', 'RETURN_HOME', 'TILLAGE'
    )
    AND status IN ('QUEUED', 'SENT', 'ACKED', 'PAUSED');
