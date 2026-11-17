-- 045：清除历史冒烟残留的悬空地块引用
--
-- 背景：scripts/smoke-events.mjs 早期版本的清理清单漏了消费端联动写入的
-- trace_records / control_commands 两类行，哨兵编码 P-SMOKE-EVENTS 从未真实建档，
-- 迁移 044 重置地块域后这些行成为悬空引用。脚本清理清单已补齐，此处清存量。
DELETE FROM trace_records WHERE plot_code = 'P-SMOKE-EVENTS';
DELETE FROM control_commands WHERE plot_code = 'P-SMOKE-EVENTS';