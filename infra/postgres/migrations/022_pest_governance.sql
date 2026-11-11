-- 022：虫情治理流程（开发方案 6.3）
--
-- 在识别记录上补一套治理字段，覆盖「定位地块 → 药剂方案 → 派单 → 归档」的处置留痕：
--   governance_status：pending 待处置 / planned 已定方案 / dispatched 已派单 / archived 已归档
--   measure/pesticide/dosage：防治措施与药剂方案；dispatch_note：派单/归档说明（航线为人工填写）
--   task_id：一键派单生成的植保农事任务 id（由前端调用作业服务创建后回填，服务间不直连，保持解耦）
--   governed_by/governed_at：处置人与最近处置时间
-- 真实的航线规划与无人机派遣依赖硬件，本系统只记录决策与派单，不伪造执行回执。
-- 与既有单租户遥测库口径一致，不带 tenant_id。

ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS governance_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (governance_status IN ('pending', 'planned', 'dispatched', 'archived'));
ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS measure TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS pesticide TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS dosage TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS dispatch_note TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS governed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS governed_at TIMESTAMPTZ;
ALTER TABLE telemetry_pest_events ADD COLUMN IF NOT EXISTS task_id TEXT;

-- 治理看板：按状态 + 识别时间检索待处置/已派单记录
CREATE INDEX IF NOT EXISTS idx_pest_events_governance ON telemetry_pest_events (governance_status, detected_at DESC);