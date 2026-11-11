-- 023：灾情档案上报与处置（开发方案 6.4）
--
-- 记录干旱/洪涝/低温冻害/大风倒伏/冰雹/病虫害六类田间灾情：
--   disaster_type：六类编码，取自灾情字典
--   affected_area_mu：受灾面积（亩），由上报人按田块实测填报，与地块边界面积独立
--   severity：1 轻度 / 2 中度 / 3 重度 / 4 特别重大，与虫情三级分开，因灾害分级国标四级
--   suggested_measure：处置建议，随状态推进由农技/管理员补录
--   status：REPORTED 已上报 → ASSESSED 已核查 → HANDLED 已处置 → ARCHIVED 已归档
--   loss_assessment：损失评估说明，处置人补充
--   image_file_ids：JSONB 数组字符串，图片由文件服务持有，本表只存引用
--   reported_by：上报人（田间巡查员或系统自动接入）
-- 真实卫星遥感/保险理赔对接仍依赖外部系统，本表只记录人工上报与处置留痕。
-- 与既有单租户遥测库口径一致，不带 tenant_id。

CREATE TABLE IF NOT EXISTS telemetry_disasters (
  id TEXT PRIMARY KEY,
  disaster_type TEXT NOT NULL CHECK (disaster_type IN ('drought', 'flood', 'frost', 'wind', 'hail', 'pest')),
  plot_code TEXT NOT NULL DEFAULT '',
  affected_area_mu NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (affected_area_mu >= 0),
  severity SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 4),
  occurred_at TIMESTAMPTZ NOT NULL,
  suggestion TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED', 'ASSESSED', 'HANDLED', 'ARCHIVED')),
  loss_assessment TEXT NOT NULL DEFAULT '',
  image_file_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reported_by TEXT NOT NULL DEFAULT '',
  handled_by TEXT NOT NULL DEFAULT '',
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 灾情看板按状态/地块/时间检索
CREATE INDEX IF NOT EXISTS idx_disasters_status_time ON telemetry_disasters (status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_disasters_plot ON telemetry_disasters (plot_code, occurred_at DESC);
