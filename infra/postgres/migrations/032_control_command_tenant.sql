-- 032 控制指令租户归属
--
-- 005 建表时按「设备域全局台账」处理，014 也照此说明；但指令一旦带上线就多团队共用，
-- 甲农场能看到乙农场的急停记录既不合规也没法按租户做留存与配额。本迁移补 tenant_id，
-- 与 operation_tasks、video_ptz_commands 同一口径。
--
-- 用 DEFAULT 'tenant-demo' 而不是先加可空列再回填：存量行（含 010 演示种子）全部属于
-- 演示租户，Postgres 11+ 对常量默认值不重写表，历史库与应用镜像可以各自独立升级。

ALTER TABLE control_commands
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant-demo';

-- 列表与超时看板都是「某租户 + 按时间倒序」，把租户放在最前
CREATE INDEX IF NOT EXISTS idx_control_commands_tenant_created
  ON control_commands (tenant_id, created_at DESC, id DESC);

-- 031 的在途索引只按时间扫；补上租户前缀后才能服务单租户的待回执看板
DROP INDEX IF EXISTS idx_control_commands_open;
CREATE INDEX IF NOT EXISTS idx_control_commands_open
  ON control_commands (tenant_id, created_at DESC, id)
  WHERE status IN ('QUEUED', 'SENT', 'ACKED');
