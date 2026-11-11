-- 024 管线归属地块：给 infra_lines 增加 plot_code，支撑一张图"管线按地块联动查询/过滤"。
--
-- 背景：管线（灌水管/施肥管/电力线/通信线/机耕道）此前只按类型区分，
-- 无法回答"某地块有哪些管线""某条管线服务哪个地块"。
-- plot_code 引用 plots.parcel_code，与片区 zone_code 一样是纯文本引用（不建外键）：
-- 地块可能被软删或先建管线后补地块，硬外键会挡住正常建档顺序。
-- 空串表示"未归属地块"；归属由建档人在线路编辑里指定，系统不做几何相交自动判定（演示坐标不等于实测）。
ALTER TABLE infra_lines ADD COLUMN IF NOT EXISTS plot_code TEXT NOT NULL DEFAULT '';

-- 按地块过滤管线（deleted 行不进入联动结果）
CREATE INDEX IF NOT EXISTS idx_infra_lines_plot ON infra_lines (plot_code) WHERE deleted_at IS NULL;
