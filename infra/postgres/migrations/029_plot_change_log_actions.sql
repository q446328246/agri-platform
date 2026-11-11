-- 029 地块变更历史支持合并/分档动作
--
-- 地块合并（#83）与拆分落地后，留痕除建档/修改/删除外还要记 MERGE（合并生成）、
-- SPLIT（拆分生成）。删除旧 CHECK 再按新枚举重建；历史行全部是旧枚举的子集，
-- 不会因此失效。
ALTER TABLE plot_change_logs DROP CONSTRAINT IF EXISTS plot_change_logs_action_check;
ALTER TABLE plot_change_logs
  ADD CONSTRAINT plot_change_logs_action_check
  CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'MERGE', 'SPLIT'));
