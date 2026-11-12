-- 037 农事任务软删除
--
-- 016 建表时没留归档列，而地块（001）、片区（009）、管线（024）、种植季（026）都有 deleted_at：
-- 同一个平台里「删除」有两种含义。地块删掉是归档，变更历史（plot_change_log）还能回查；
-- 任务则压根没有删除接口，任何清理只能直连库 `DELETE FROM operation_tasks`，行连同
-- 计划窗口、作业结果一起消失，事后无从辨别这条任务曾经存在过。本迁移补齐 deleted_at，
-- 让任务的删除语义与地块/片区同一口径。
--
-- 只加一列，不做别的：
-- - 不加 deleted_by。平台里还没有任何表用过这一列（地块/片区/管线都只记 deleted_at），
--   操作人当前只在带留痕的地块变更历史里体现；任务侧没有留痕表，单独立一列只会造出
--   「有列但没人写」的下一处口径分裂。
-- - 归档不改 status、不 bump version。deleted_at 是「这条记录还在不在册」，
--   status 是「这次作业走到哪一步」，两件事各记各的；历史行的状态仍按归档前最后一次跃迁读。
-- - operation_outbox.task_id 的外键指向 operation_tasks(id)，软删的行仍在表里，
--   已入队但未投递的完成事件不受影响，中继照常投递。

ALTER TABLE operation_tasks
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 在册列表是任务页唯一的读路径（列表、详情、状态流转都先按租户取未归档行），
-- 沿用 001 给 plot_records 建的部分索引口径：租户 + 时间倒序，且只覆盖未归档行。
-- 016 那条全局索引留着不动，历史行统计与其他按租户扫描的查询仍走它。
CREATE INDEX IF NOT EXISTS idx_operation_tasks_tenant_active
  ON operation_tasks (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
