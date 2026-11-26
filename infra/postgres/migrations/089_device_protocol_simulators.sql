-- 089：七种设备协议各补一台可调试的灌溉泵模拟设备
--
-- 连接地址与点位取自 apps/iot-service/src/device-simulator.config.json，内存种子使用同一份夹具。
-- 初始保持 OFFLINE / last_seen_at NULL，由 scripts/simulate-device-protocols.mjs 启动后心跳上线，
-- 不让“台账里有记录”冒充“模拟器正在运行”。不绑定地块，便于独立下发调试指令。
-- MQTT 不预置账号或密码密文；设备凭据只在本地 .env 配置，避免把秘密写进迁移。

INSERT INTO devices (
  tenant_id, id, device_no, name, type, status, protocol, driver_id,
  binding_json, plc_config_json, created_at, updated_at
) VALUES
  ('tenant-demo', 'device-demo-sim-http', 'DZ-SIM-HTTP', 'HTTP 真机模拟灌溉泵',
   'IRRIGATION_PUMP', 'OFFLINE', 'HTTP', 'HTTP_CALLBACK', NULL, NULL, now(), now()),
  ('tenant-demo', 'device-demo-sim-modbus', 'DZ-SIM-MODBUS', 'Modbus TCP 真机模拟灌溉泵',
   'IRRIGATION_PUMP', 'OFFLINE', 'MODBUS_TCP', 'MODBUS_TCP_GATEWAY',
   '{"host":"127.0.0.1","port":15020,"unitId":1,"profile":"WATER_M3","timeoutMs":2000}'::jsonb, NULL, now(), now()),
  ('tenant-demo', 'device-demo-sim-mqtt', 'DZ-SIM-MQTT', 'MQTT 真机模拟灌溉泵',
   'IRRIGATION_PUMP', 'OFFLINE', 'MQTT', 'MQTT_DIRECT', NULL, NULL, now(), now()),
  ('tenant-demo', 'device-demo-sim-plc-modbus', 'DZ-SIM-PLC-MB', 'PLC Modbus TCP 真机模拟灌溉泵',
   'IRRIGATION_PUMP', 'OFFLINE', 'PLC_MODBUS_TCP', 'PLC_MODBUS_TCP_GATEWAY', NULL,
   '{"driverId":"PLC_MODBUS_TCP_GATEWAY","host":"127.0.0.1","port":15021,"timeoutMs":2000,"profile":"PLC_MODBUS_TCP_WATER_M3","switchPoint":0,"runFeedbackPoint":0,"faultPoint":1,"meterPoint":0,"unitId":1}'::jsonb,
   now(), now()),
  ('tenant-demo', 'device-demo-sim-s7', 'DZ-SIM-S7', 'Siemens S7 真机模拟灌溉泵',
   'IRRIGATION_PUMP', 'OFFLINE', 'SIEMENS_S7', 'SIEMENS_S7_DRIVER', NULL,
   '{"driverId":"SIEMENS_S7_DRIVER","host":"127.0.0.1","port":15022,"timeoutMs":5000,"profile":"SIEMENS_S7_WATER_M3","switchPoint":"DB1,X0.0","runFeedbackPoint":"DB1,X0.1","faultPoint":"DB1,X0.2","meterPoint":"DB10,INT0","rack":0,"slot":1}'::jsonb,
   now(), now()),
  ('tenant-demo', 'device-demo-sim-mc', 'DZ-SIM-MC', 'Mitsubishi MC 真机模拟灌溉泵',
   'IRRIGATION_PUMP', 'OFFLINE', 'MITSUBISHI_MC', 'MITSUBISHI_MC_DRIVER', NULL,
   '{"driverId":"MITSUBISHI_MC_DRIVER","host":"127.0.0.1","port":15023,"timeoutMs":5000,"profile":"MITSUBISHI_MC_WATER_M3","switchPoint":"M0","runFeedbackPoint":"M16","faultPoint":"M17","meterPoint":"D100","ascii":false}'::jsonb,
   now(), now()),
  ('tenant-demo', 'device-demo-sim-opcua', 'DZ-SIM-OPCUA', 'OPC UA 真机模拟灌溉泵',
   'IRRIGATION_PUMP', 'OFFLINE', 'OPC_UA', 'OPC_UA_CLIENT', NULL,
   '{"driverId":"OPC_UA_CLIENT","endpointUrl":"opc.tcp://127.0.0.1:15024","timeoutMs":10000,"authMode":"ANONYMOUS","profile":"OPC_UA_WATER_M3","switchPoint":"ns=2;i=1001","runFeedbackPoint":"ns=2;i=1002","faultPoint":"ns=2;i=1003","meterPoint":"ns=2;i=1004"}'::jsonb,
   now(), now())
ON CONFLICT (id) DO NOTHING;
