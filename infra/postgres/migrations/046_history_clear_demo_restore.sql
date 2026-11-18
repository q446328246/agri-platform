-- 046：清业务历史七表 + 恢复演示账号种子态（2026-11-18 用户点名）
--
-- 背景：迁移 044 重置地块域时八张业务表历史行仅改挂未删；用户点名「业务历史也清」。
-- 口径（用户确认）：devices 属资产台账而非业务历史，11 台设备与新地块绑定保留；
-- 其余七表（农事任务/财务/溯源/遥测读数/遥测告警/控制指令/决策处方）历史行整体清空，
-- 各业务页历史列表自此为空列表可用态，待新业务产生或另行补种子。
-- 连带清各表的 outbox 队列 / 执行 / 结局 / 变更留痕辅表，防主表清空后辅表悬空或队列空转。
-- 不动：devices / decision_rules / telemetry_rules / telemetry_pest_events / telemetry_disasters /
--       video_ai_events / ops_messages / event_log / weather_* / crop_seasons / plot_growth_stages /
--       plot_records / infra_lines / plot_zones / platform_audit_logs（审计留存独立策略）。

-- ---------- 农事任务域 ----------
DELETE FROM operation_task_change_logs;
DELETE FROM operation_outbox;
DELETE FROM operation_tasks;

-- ---------- 财务 / 溯源 ----------
DELETE FROM finance_entries;
DELETE FROM trace_records;

-- ---------- 遥测域（读数与告警；虫情/灾情属监测事件保留） ----------
DELETE FROM telemetry_outbox;
DELETE FROM telemetry_readings;
DELETE FROM telemetry_alerts;

-- ---------- 控制指令域 ----------
DELETE FROM control_outbox;
DELETE FROM control_commands;

-- ---------- 决策处方域（规则保留） ----------
DELETE FROM decision_prescription_executions;
DELETE FROM decision_prescription_outcomes;
DELETE FROM decision_outbox;
DELETE FROM decision_prescriptions;

-- ---------- 演示账号恢复种子态（迁移 010 口径） ----------
-- 2026-11-12 页面改密致种子口令 demo123 失效、temp01 被启用；此处恢复 010 种子散列与停用态。
-- password_hash 为开发期兼容散列 sha256('agri:demo123')（与 010 同常量），登录成功后服务按 needsRehash 自动升级 scrypt。
UPDATE auth_users
   SET password_hash = '074a7427b47de6450a81dc3cf8e1823770225e2533540b4213b87eaec74a052a',
       updated_at = now()
 WHERE tenant_id = 'tenant-demo'
   AND username IN ('agronomist', 'operator01', 'viewer01', 'temp01');

UPDATE auth_users
   SET status = 'DISABLED',
       updated_at = now()
 WHERE tenant_id = 'tenant-demo'
   AND username = 'temp01';