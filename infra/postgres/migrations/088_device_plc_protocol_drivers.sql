-- 088：PLC 台账类型与四种现场协议驱动
--
-- PLC 的连接参数独立保存在 plc_config_json，按 driver_id 判别形状；不与 Modbus binding
-- 或 MQTT 配置混用。协议、驱动、设备类型与连接容器均由数据库约束再次兜底。

ALTER TABLE devices ADD COLUMN IF NOT EXISTS plc_config_json JSONB;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_type_check;
ALTER TABLE devices ADD CONSTRAINT devices_type_check CHECK (type IN (
  'PLC', 'WEATHER_STATION', 'SOIL_SENSOR', 'INTEGRATED_STATION', 'REMOTE_SENSE', 'INSECT_LAMP',
  'FERTILIZER_VALVE', 'IRRIGATION_VALVE', 'IRRIGATION_PUMP', 'AGRICULTURAL_DRONE', 'AUTO_TRACTOR'
));

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_protocol_check;
ALTER TABLE devices ADD CONSTRAINT devices_protocol_check CHECK (
  protocol IN ('HTTP', 'MODBUS_TCP', 'MQTT', 'PLC_MODBUS_TCP', 'SIEMENS_S7', 'MITSUBISHI_MC', 'OPC_UA')
);

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_protocol_driver_check;
ALTER TABLE devices ADD CONSTRAINT devices_protocol_driver_check CHECK (
  (protocol = 'HTTP' AND driver_id = 'HTTP_CALLBACK')
  OR (protocol = 'MODBUS_TCP' AND driver_id = 'MODBUS_TCP_GATEWAY')
  OR (protocol = 'MQTT' AND driver_id = 'MQTT_DIRECT')
  OR (protocol = 'PLC_MODBUS_TCP' AND driver_id = 'PLC_MODBUS_TCP_GATEWAY')
  OR (protocol = 'SIEMENS_S7' AND driver_id = 'SIEMENS_S7_DRIVER')
  OR (protocol = 'MITSUBISHI_MC' AND driver_id = 'MITSUBISHI_MC_DRIVER')
  OR (protocol = 'OPC_UA' AND driver_id = 'OPC_UA_CLIENT')
);

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_binding_check;
ALTER TABLE devices ADD CONSTRAINT devices_binding_check CHECK (
  (protocol IN ('HTTP', 'MQTT', 'PLC_MODBUS_TCP', 'SIEMENS_S7', 'MITSUBISHI_MC', 'OPC_UA') AND binding_json IS NULL)
  OR (protocol = 'MODBUS_TCP' AND binding_json IS NOT NULL)
);

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_plc_config_check;
ALTER TABLE devices ADD CONSTRAINT devices_plc_config_check CHECK (
  (protocol IN ('PLC_MODBUS_TCP', 'SIEMENS_S7', 'MITSUBISHI_MC', 'OPC_UA')
    AND plc_config_json IS NOT NULL AND jsonb_typeof(plc_config_json) = 'object')
  OR (protocol IN ('HTTP', 'MODBUS_TCP', 'MQTT') AND plc_config_json IS NULL)
);
