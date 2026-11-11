-- 021：苗情生育期档案（开发方案 6.2）
--
-- 记录每个地块作物生育期的「计划节点」与「实际节点」，支撑苗情时间轴回看：
-- 出苗/分蘖/拔节/抽穗/灌浆/成熟等阶段以 stage 编码存储（前端目录给出中文名与顺序），
-- planned_* 为农事计划节点，actual_* 为田间实测节点，两者对比即可看出提前/滞后。
-- 与 telemetry_pest_events 一致不带 tenant_id：地块编码本身已隔离归属，遥测库单租户部署。

CREATE TABLE IF NOT EXISTS plot_growth_stages (
  id TEXT PRIMARY KEY,
  plot_code TEXT NOT NULL,
  stage TEXT NOT NULL,
  planned_start_at TIMESTAMPTZ,
  planned_end_at TIMESTAMPTZ,
  actual_start_at TIMESTAMPTZ,
  actual_end_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一地块同一生育期只保留一条档案，登记时幂等更新
CREATE UNIQUE INDEX IF NOT EXISTS uq_plot_growth_stages_plot_stage ON plot_growth_stages (plot_code, stage);
CREATE INDEX IF NOT EXISTS idx_plot_growth_stages_plot ON plot_growth_stages (plot_code, planned_start_at);