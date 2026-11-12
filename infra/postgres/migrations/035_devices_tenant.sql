-- 035 设备台账租户归属
--
-- 014 当初按「设备域全局台账」处理，理由是那时 control_commands 也没有 tenant_id；
-- 032 已经给指令补上门户，台账却还留在全局：乙农场能列出甲农场的设备编号、地块绑定与
-- 在线状态，还能对着别家的设备号下控制指令。编号唯一也停在 `device_no UNIQUE` 上，
-- 两个农场各自采购的同型号设备（出厂编号相同）根本登不进来。本迁移补 tenant_id，
-- 与 control_commands、operation_tasks、video_ptz_commands 同一口径。
--
-- 用 DEFAULT 'tenant-demo' 而不是先加可空列再回填：存量行（含 014 演示种子）全部属于
-- 演示租户，Postgres 11+ 对常量默认值不重写表，历史库与应用镜像可以各自独立升级。
--
-- 校正 014 的约定说明：014 注释里「不加 tenant_id：设备域与 control_commands 一致按
-- 全局台账管理，加一列却从不按它过滤只会误导后续开发」已经不成立——本迁移之后这一列
-- 就是每个查询的第一个条件，读、写、撞号校验都要带它。

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'tenant-demo';

-- 编号唯一的口径从「全局唯一」改为「租户内唯一」：沿用原约束名，重复执行时
-- DROP IF EXISTS 先把上一轮的版本摘掉，不会第二次跑就撞约束名。
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_no_key;
ALTER TABLE devices
  ADD CONSTRAINT devices_device_no_key UNIQUE (tenant_id, device_no);

-- 列表与筛选都是「某租户 + 类型/地块」，租户放在最前
DROP INDEX IF EXISTS idx_devices_type;
CREATE INDEX IF NOT EXISTS idx_devices_type
  ON devices (tenant_id, type);

DROP INDEX IF EXISTS idx_devices_plot;
CREATE INDEX IF NOT EXISTS idx_devices_plot
  ON devices (tenant_id, plot_code) WHERE plot_code <> '';
