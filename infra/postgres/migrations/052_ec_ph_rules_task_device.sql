-- 052 EC/pH 偏离规则种子（A18）+ 农事任务执行设备（A5）
--
-- 开发方案 9.2/9.4：「肥液 EC 值或 pH 值超限 → 自动调整配比并推送提示，必要时暂停输送」。
-- 这里只种三条全局默认阈值规则（WARNING 级），越限后：
--   1) 遥测上报链路照常生成越限告警，消息中心按既有模板推送提示；
--   2) 决策服务消费 telemetry.threshold.breached，对 soilEc/soilPh 生成保守的
--      配比调整处方（RECOMMENDED），经 decision.prescription.issued 转成水肥指令，
--      走既有 envelopeBlocked 路径由人工确认作业量后执行——不自动开阀。
-- 阈值口径：EC 上限 2500 μS/cm（多数作物肥液适宜区间上沿），pH 适宜 5.5–8.5。
-- 种子走 ON CONFLICT DO NOTHING：不改 DEFAULT_TELEMETRY_RULES 数组（测试断言恰 7 条），
-- 也不覆盖运维已在阈值规则页调过的同档规则。

INSERT INTO telemetry_rules (id, metric, plot_code, direction, threshold, level, message, enabled, updated_at)
VALUES
  ('rule-soil-ec-high', 'soilEc', '', 'above', 2500, 'WARNING', '肥液EC超出上限，需稀释注水并核对加肥量', TRUE, now()),
  ('rule-soil-ph-high', 'soilPh', '', 'above', 8.5, 'WARNING', '肥液pH偏碱超出上限，需酸化调理并核对配比', TRUE, now()),
  ('rule-soil-ph-low', 'soilPh', '', 'below', 5.5, 'WARNING', '肥液pH偏酸低于下限，需碱化调理并核对配比', TRUE, now())
ON CONFLICT (metric, plot_code, level) DO NOTHING;

-- A5 自动排队（方案 8.7「同一设备被分配多个任务时自动排队」）：
-- 任务可选绑定执行设备，队列端点按 优先级 → 计划开始 → 建档时间 给出位次。
-- 可空：存量任务与人工任务不强制绑设备，排队视图只对绑了设备的任务生效。
ALTER TABLE operation_tasks ADD COLUMN IF NOT EXISTS device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_operation_tasks_device
  ON operation_tasks (tenant_id, device_id, scheduled_at)
  WHERE device_id IS NOT NULL;