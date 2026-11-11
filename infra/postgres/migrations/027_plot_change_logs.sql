-- 027 地块变更历史（追加式留痕）
--
-- 为每个地块记录一条只增不改的操作时间线：建档、改档案/重绘边界、删除各写一行。
-- 详情页据此回看"这块地被动过什么、谁动的、什么时候"，是审计对象，不提供更新/删除接口。
--
-- 与地块档案表解耦：plot_code 为纯文本引用，不建外键（地块软删后历史仍需留存在案）。
-- 不回补历史启用前的存量地块操作——过去的轨迹无法追溯，伪造会污染审计。
-- actor 取网关注入的 x-user-id，系统内部触发时记为 system。
CREATE TABLE IF NOT EXISTS plot_change_logs (
  id           TEXT PRIMARY KEY,
  parcel_code  TEXT NOT NULL,
  tenant_id    TEXT NOT NULL DEFAULT 'tenant-demo',
  action       TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
  summary      TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL DEFAULT 'system',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 按地块倒序回看变更历史
CREATE INDEX IF NOT EXISTS idx_plot_change_logs_plot ON plot_change_logs (parcel_code, created_at DESC);
