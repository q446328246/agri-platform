-- 063：决策预测台账（C3）
--
-- 动机：方案第十章要求墒情/虫害/产量的预测能力，原决策侧只有规则式即时判定，
-- 没有「按预测时点前瞻」的留痕。本迁移为 platform 决策预测建立台账，供预测页
-- 展示、预警事件追溯与后续模型替换时对比口径。
--
-- 约定：
-- 1. 预测只留痕、不驱动执行：预警/严重级经 decision.prediction.alert 事件进消息
--    中心提示提前处置，处方与控制链路仍由人确认，不因预测自动下发作业；
-- 2. predicted_at 是预测时点（= 预测起点 + 时距），唯一索引保证同一预测窗口
--    扫描器重跑只落一条，ON CONFLICT DO NOTHING 幂等；
-- 3. 指标三码与契约 PredictionMetric 同源；level 四码含 INSUFFICIENT_DATA——
--    无足够依据时不编预测值，明确留痕为数据不足；
-- 4. inputs 记录推算依据（样本数、斜率、降雨概率、风险分构成等），保证可追溯；
-- 5. 全部可重复执行（IF NOT EXISTS），时间列统一 TIMESTAMPTZ。

CREATE TABLE IF NOT EXISTS decision_predictions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  plot_code     TEXT NOT NULL,
  season_id     TEXT NOT NULL DEFAULT '',
  metric        TEXT NOT NULL CHECK (metric IN ('SOIL_MOISTURE', 'PEST_RISK', 'YIELD')),
  predicted_at  TIMESTAMPTZ NOT NULL,
  horizon_hours SMALLINT NOT NULL CHECK (horizon_hours > 0),
  predicted_value NUMERIC(10, 2) NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('NORMAL', 'WARNING', 'CRITICAL', 'INSUFFICIENT_DATA')),
  unit          TEXT NOT NULL DEFAULT '',
  threshold     NUMERIC(10, 2),
  direction     TEXT CHECK (direction IN ('above', 'below')),
  basis         TEXT NOT NULL DEFAULT '',
  inputs        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一地块同一指标同一预测时点只保留一条：扫描器重跑不产生重复预测
CREATE UNIQUE INDEX IF NOT EXISTS uq_decision_predictions_target
  ON decision_predictions (tenant_id, plot_code, metric, predicted_at);

CREATE INDEX IF NOT EXISTS idx_decision_predictions_plot
  ON decision_predictions (plot_code, metric, predicted_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_predictions_created
  ON decision_predictions (created_at DESC);
