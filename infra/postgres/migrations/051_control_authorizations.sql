-- 051 控制指令授权范围管控（A8，开发方案 14.3 三重管控之三）
--
-- 「指令仅能在授权地块与授权时间段内生效，超出范围自动拒绝」。本表登记设备/地块的
-- 作业授权窗口：device_id 为空表示全部设备，plot_code 为空表示全部地块，
-- valid_from/valid_to 界定授权时间段。人工下发指令时须命中至少一条覆盖
-- 「该设备 + 该地块 + 当前时刻」的授权，否则 403 拒绝。
--
-- 空表 = 未启用范围管控（放行）：存量演示与测试没有授权数据，启用管控必须先在
-- 前端「控制指令 → 作业授权」里显式建档，避免升级即把所有下发全部拒掉。
-- 事件自动指令（越限/处方联动）不受此表约束——那是平台自身的安全处置，
-- 范围管控只约束人工下发。

CREATE TABLE IF NOT EXISTS control_authorizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_id TEXT,
  plot_code TEXT,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT control_authorizations_window_check CHECK (valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS idx_control_authorizations_tenant
  ON control_authorizations (tenant_id, created_at DESC);

-- 范围校验按「租户 + 时刻」扫窗口，设备/地块可空（通配）不适合等值索引，窗口列单独建
CREATE INDEX IF NOT EXISTS idx_control_authorizations_window
  ON control_authorizations (tenant_id, valid_from, valid_to);