-- 053 阈值规则唯一键并入方向 + 补种 pH 下限规则（P3 部署核验修复）
--
-- 052 种子的三条 EC/pH 规则里，pH 上限（above 8.5）与下限（below 5.5）同为 WARNING 级，
-- 而 020 的唯一键 (metric, plot_code, level) 不含方向——两条 pH 规则冲突键相同，
-- ON CONFLICT DO NOTHING 把第二条（rule-soil-ph-low）静默吞掉，碱化调理处方链路缺了触发规则。
--
-- 修复：唯一键扩为 (metric, plot_code, level, direction)，上下限双边界指标可在同一级各放一条；
-- 分级语义不变——同一指标同一地块同一方向仍按「提示—预警—告警」每级一条。
-- 仓储 upsert（SqlRuleRepository.save / InMemoryRuleRepository.save）已同步改为四元组冲突键。

CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_rules_metric_plot_level_dir
  ON telemetry_rules (metric, plot_code, level, direction);
DROP INDEX IF EXISTS uq_telemetry_rules_metric_plot_level;

-- 补种被吞掉的 pH 下限规则；EC 上限与 pH 上限已在 052 落库，DO NOTHING 不覆盖运维调过的阈值
INSERT INTO telemetry_rules (id, metric, plot_code, direction, threshold, level, message, enabled, updated_at)
VALUES
  ('rule-soil-ec-high', 'soilEc', '', 'above', 2500, 'WARNING', '肥液EC超出上限，需稀释注水并核对加肥量', TRUE, now()),
  ('rule-soil-ph-high', 'soilPh', '', 'above', 8.5, 'WARNING', '肥液pH偏碱超出上限，需酸化调理并核对配比', TRUE, now()),
  ('rule-soil-ph-low', 'soilPh', '', 'below', 5.5, 'WARNING', '肥液pH偏酸低于下限，需碱化调理并核对配比', TRUE, now())
ON CONFLICT (metric, plot_code, level, direction) DO NOTHING;