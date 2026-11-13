-- 039 农事任务变更历史（追加式留痕）
--
-- 037 给任务补了 deleted_at，让「删除」的语义与地块/片区对齐，但任务侧此前没有任何
-- 留痕表：建档、状态跃迁、归档删除在行上只留下一个时间戳，没有「谁动的」。归档之后，
-- 连 deleted_at 也说不清是谁、在什么时候、因哪次动作盖的。本迁移补齐与
-- plot_change_logs 同一口径的变更历史，让任务详情页能回看完整操作轨迹。
--
-- 与 plot_change_logs 一致的三条口径：
-- - 只追加、不更新、不删除：日志本身是审计对象，改它应当再留痕；
-- - task_id 为纯文本引用，不建外键：任务归档后历史仍需留存在案，物理清理任务行时
--   留痕不受影响（与 plot_change_logs.parcel_code 同一处理，避免外键把历史一起带走）；
-- - actor 取网关注入的 x-user-id，系统内部触发时记为 system。
--
-- 动作口径：CREATE 建档、TRANSITION 状态跃迁、ARCHIVE 归档删除。历史从本迁移起记录，
-- 启用前的存量任务不回补——过去的操作轨迹无从追溯，伪造会污染审计。
CREATE TABLE IF NOT EXISTS operation_task_change_logs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  tenant_id  TEXT NOT NULL DEFAULT 'tenant-demo',
  action     TEXT NOT NULL CHECK (action IN ('CREATE', 'TRANSITION', 'ARCHIVE')),
  summary    TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT 'system',
  trace_id   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 任务详情页按时间倒序回看操作轨迹
CREATE INDEX IF NOT EXISTS idx_operation_task_change_logs_task
  ON operation_task_change_logs (task_id, created_at DESC);
