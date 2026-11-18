-- 055 变量播种/施肥方案落库（A15 网格级变量作业）
--
-- 开发方案 8.3/9.3：按地块内长势差异分区定速率，播种/施肥不再全田一个量。
-- 方案由「覆盖路径（coverage）+ A14 长势网格速率映射」生成：逐作业带采样网格值
-- 映射出公斤/亩速率，汇总总用量与加权平均速率。路径与速率表整体存 JSONB，
-- 与覆盖方案进程内保留不同，变量方案要留给生产档案复盘，故落库。
-- 网格本身不在此表：长势网格由遥测服务按请求现算（054 设备安装坐标 + IDW），
-- 多光谱反演接入后走同一覆盖口，不必改本表结构。

CREATE TABLE IF NOT EXISTS variable_rate_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant-demo',
  plot_code TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('SEEDING', 'FERTILIZATION')),
  metric TEXT NOT NULL DEFAULT '',
  plan JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_variable_rate_plans_tenant_created
  ON variable_rate_plans (tenant_id, created_at DESC);