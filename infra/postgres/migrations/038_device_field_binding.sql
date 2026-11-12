-- 038 设备现场接入绑定（协议 + Modbus 地址与剖面）
--
-- 动机：平台只有一种接入方式——设备自己把遥测和回执 POST 回来（/api/v1/telemetry、
-- /api/v1/control/device/*）。台账因此只记编号、类型、地块三件事。现场真正在执行动作的
-- 泵、阀、水肥机讲的是 Modbus TCP：主站（平台侧网关）主动连过去写线圈，从站只会应答，
-- 永远不会主动连平台。要让网关连得上、写对点，台账必须记住接入地址与寄存器剖面。
--
-- 约定：
-- 1. protocol 默认 'HTTP'：存量行（含 014 演示种子）全部是回调式接入，本迁移不改变任何
--    现有行为；只有显式改成 MODBUS_TCP 并给出绑定的设备，才会被现场网关轮询与下发。
-- 2. 接入地址与剖面放在一个 binding_json 里，不摊成 host/port/unit_id/profile 四列：
--    这些字段只对 Modbus 有意义，摊平会让 HTTP 设备永远带四个空列，后续换总线又要改表。
--    形状由 apps/iot-service/src/device-binding.ts 校验，表里只保证「协议与绑定同生同灭」。
-- 3. 剖面 key 对应的寄存器地址、倍率、单位只在代码里有一份（MODBUS_PROFILES），
--    不在数据库里写死，避免台账与网关两侧的点位表各说各话。
-- 4. 约束沿用「先 DROP IF EXISTS 再 ADD」，重复执行不撞约束名，与 031/035 同一写法。

ALTER TABLE devices ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'HTTP';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS binding_json JSONB;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_protocol_check;
ALTER TABLE devices ADD CONSTRAINT devices_protocol_check
  CHECK (protocol IN ('HTTP', 'MODBUS_TCP'));

-- 回调式设备不该留着绑定（会被误认为已经改成交互式接入），现场协议设备必须有绑定
-- （否则网关取到空绑定只能把指令收口成 FAILED，白跑一趟）
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_binding_check;
ALTER TABLE devices ADD CONSTRAINT devices_binding_check CHECK (
  (protocol = 'HTTP' AND binding_json IS NULL)
  OR (protocol <> 'HTTP' AND binding_json IS NOT NULL)
);

-- 现场网关只扫协议非 HTTP 的设备；台账绝大多数是回调式，用部分索引避开它们
CREATE INDEX IF NOT EXISTS idx_devices_field_protocol
  ON devices (tenant_id, device_no) WHERE protocol <> 'HTTP';
