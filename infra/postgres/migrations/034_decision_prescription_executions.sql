-- 034：处方执行回流表
-- 处方生成（decision.prescription.issued）之后，控制服务会把处方下发成灌溉/施肥指令，
-- 指令 DONE 回执再发出 control.irrigation.finished / control.fertilization.finished。
-- 在此之前，决策侧只知道「处方发出去了」，不知道「处方到底被执行成什么样」：
-- 执行用了多少水肥、作业多久、由哪台设备完成全都断在控制服务里，
-- 效果评估（decision_prescription_outcomes）只能靠调用方手工喂参数，闭环缺一环。
-- 这张表把结单事件里可核对的执行事实按处方留痕，command_id 唯一索引保证事件重放不重复记账。

CREATE TABLE IF NOT EXISTS decision_prescription_executions (
  id TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL,
  -- 结单的指令标识：同一条指令只会结单一次，重放事件按它去重
  command_id TEXT NOT NULL UNIQUE,
  plot_code TEXT NOT NULL DEFAULT '',
  -- 处方动作类型，与 PrescriptionIssuedPayload.planType 同一口径
  plan_type TEXT NOT NULL CHECK (plan_type IN ('irrigation', 'fertilization')),
  device_id TEXT NOT NULL DEFAULT '',
  -- 用水量（立方米）与施肥量（千克）：来源标记为 DEVICE 时是设备实测，PLAN 时按指令参数现算；
  -- 两列可空——设备没报且参数推不出方案总量时留空，不编一个数。
  water_volume NUMERIC(12, 3),
  water_volume_source TEXT CHECK (water_volume_source IN ('DEVICE', 'PLAN')),
  fertilizer_kg NUMERIC(12, 3),
  fertilizer_source TEXT CHECK (fertilizer_source IN ('DEVICE', 'PLAN')),
  duration_min INTEGER NOT NULL,
  duration_source TEXT NOT NULL CHECK (duration_source IN ('DEVICE', 'RUNTIME')),
  finished_at TIMESTAMPTZ NOT NULL,
  -- 事件标识留档，便于从执行记录回溯到事件日志原始行
  event_id TEXT NOT NULL DEFAULT '',
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_executions_prescription ON decision_prescription_executions (prescription_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_executions_plot ON decision_prescription_executions (plot_code, finished_at DESC);
