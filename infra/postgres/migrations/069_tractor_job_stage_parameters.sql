-- 069：拖拉机作业分步表补下发参数列（补丁）
--
-- 起因：执行器改造后，分步指令需各自持久化下发参数（换具带机具编码、作业带面积
-- 与时长、返航不带参数），下发时原样带上，SQL 建单按列写入 `parameters`。065 已同步
-- 加上该列，但 065 在部分库已经应用——迁移只执行未应用文件，已应用库不会重跑 065，
-- 列不会凭空出现，tractor-service 的 INSERT 会直接报「column parameters does not exist」。
-- 本迁移为已应用库补列。
--
-- 约定：
-- 1. 全新库以修正后的 065 为准（065 已含该列），`IF NOT EXISTS` 保证重复执行与全新库
--    均不报错，与 066 的补丁口径一致；
-- 2. 列的可空性与缺省值与 065 一致（NOT NULL DEFAULT '{}'），既有行补默认空对象，
--    不猜历史分步的参数；
-- 3. 可重复执行。

ALTER TABLE tractor_job_stages
  ADD COLUMN IF NOT EXISTS parameters JSONB NOT NULL DEFAULT '{}'::jsonb;
