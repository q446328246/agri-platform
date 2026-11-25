-- 087：设备协议驱动标识
--
-- 设备、协议驱动、连接参数分成三层：protocol 选择通信协议，driver_id 选择运行驱动，
-- binding_json / mqtt_config_json 分别保存该协议需要的连接参数，不把不同协议的字段混在一列。
-- 存量设备按现有协议回填默认驱动；HTTP 与 MQTT 不需要 Modbus binding 的约束保持不变。

ALTER TABLE devices ADD COLUMN IF NOT EXISTS driver_id TEXT;

UPDATE devices
SET driver_id = CASE protocol
  WHEN 'HTTP' THEN 'HTTP_CALLBACK'
  WHEN 'MODBUS_TCP' THEN 'MODBUS_TCP_GATEWAY'
  WHEN 'MQTT' THEN 'MQTT_DIRECT'
END
WHERE driver_id IS NULL;

ALTER TABLE devices ALTER COLUMN driver_id SET DEFAULT 'HTTP_CALLBACK';
ALTER TABLE devices ALTER COLUMN driver_id SET NOT NULL;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_protocol_driver_check;
ALTER TABLE devices ADD CONSTRAINT devices_protocol_driver_check CHECK (
  (protocol = 'HTTP' AND driver_id = 'HTTP_CALLBACK')
  OR (protocol = 'MODBUS_TCP' AND driver_id = 'MODBUS_TCP_GATEWAY')
  OR (protocol = 'MQTT' AND driver_id = 'MQTT_DIRECT')
);
