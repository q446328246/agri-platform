-- 020：地块分级阈值（开发方案 6.1）
--
-- 原规则按 metric 全局唯一（uq_telemetry_rules_metric）。为支持「每个地块分级阈值三级
-- （提示—预警—告警）」，给规则增加 plot_code 维度：空串表示全局默认，地块编码表示专属。
-- 唯一键改为 (metric, plot_code, level)：同一指标在同一地块上每一级各一条规则。
-- 上报时地块专属规则优先，未配置则回落全局；命中多级只按最严重一级生成一条告警。

ALTER TABLE telemetry_rules ADD COLUMN IF NOT EXISTS plot_code TEXT NOT NULL DEFAULT '';

-- 旧索引仅按 metric，无法容纳同指标的多地块/多级规则，替换为三维唯一键
DROP INDEX IF EXISTS uq_telemetry_rules_metric;
CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_rules_metric_plot_level
  ON telemetry_rules (metric, plot_code, level);

-- 按地块查规则（含全局兜底）的支撑索引
CREATE INDEX IF NOT EXISTS idx_telemetry_rules_plot ON telemetry_rules (plot_code, metric) WHERE enabled = TRUE;