-- 047: 线路台账属性扩展（A10，P2 台账与契约批）。
-- 宽度/限速/适用机型/启用停用/模板复用五组属性一次补齐：
-- 宽度与限速选填（NULL 表示未登记），CHECK 只约束「填了就必须为正」；
-- 适用机型是字符串数组（白名单见 @agri/contracts 的 MachineType），JSONB 存；
-- 模板复用 = is_template 标记 + 服务端「从模板建档」复制几何与属性，不另建模板表。
-- 迁移只追加不改旧文件；约束先删后加保证幂等。

ALTER TABLE infra_lines ADD COLUMN IF NOT EXISTS width_m NUMERIC(8, 2);
ALTER TABLE infra_lines ADD COLUMN IF NOT EXISTS speed_limit_kmh NUMERIC(6, 2);
ALTER TABLE infra_lines ADD COLUMN IF NOT EXISTS applicable_machines JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE infra_lines ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE infra_lines ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE infra_lines DROP CONSTRAINT IF EXISTS infra_lines_width_m_check;
ALTER TABLE infra_lines ADD CONSTRAINT infra_lines_width_m_check CHECK (width_m IS NULL OR width_m > 0);
ALTER TABLE infra_lines DROP CONSTRAINT IF EXISTS infra_lines_speed_limit_kmh_check;
ALTER TABLE infra_lines ADD CONSTRAINT infra_lines_speed_limit_kmh_check CHECK (speed_limit_kmh IS NULL OR speed_limit_kmh > 0);
ALTER TABLE infra_lines DROP CONSTRAINT IF EXISTS infra_lines_applicable_machines_check;
ALTER TABLE infra_lines ADD CONSTRAINT infra_lines_applicable_machines_check CHECK (jsonb_typeof(applicable_machines) = 'array');

-- 台账按启用状态过滤是高频查询；模板列表量小不单独建索引
CREATE INDEX IF NOT EXISTS idx_infra_lines_enabled ON infra_lines (tenant_id, enabled) WHERE deleted_at IS NULL;