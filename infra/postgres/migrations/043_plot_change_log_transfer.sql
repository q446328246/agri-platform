-- 043 地块变更历史支持流转动作
--
-- 地块流转（开发方案 4.1）指权属/负责人变更：平台以 TRANSFER 动作单独留痕，
-- 摘要记录「原负责人 → 新负责人」与流转事由，和普通档案修改（UPDATE）区分开。
-- 删除旧 CHECK 再按新枚举重建；历史行全部是旧枚举的子集，不会因此失效。
ALTER TABLE plot_change_logs DROP CONSTRAINT IF EXISTS plot_change_logs_action_check;
ALTER TABLE plot_change_logs
  ADD CONSTRAINT plot_change_logs_action_check
  CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'MERGE', 'SPLIT', 'TRANSFER'));