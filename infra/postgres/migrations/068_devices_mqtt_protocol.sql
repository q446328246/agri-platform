-- 068：设备接入协议扩展 MQTT（B2 拖拉机等直连设备）
--
-- 起因：设备协议枚举只有 HTTP / MODBUS_TCP，MQTT 直连设备（拖拉机订阅平台主题
-- 收指令、报遥测）在台账里没有可登记的协议，MQTT 指令中继也没有可服务的设备。
-- 协议 CHECK 与绑定 CHECK 同步放宽：MQTT 设备不要求 Modbus 绑定（绑定对直连
-- 设备没有意义），现场总线 MODBUS_TCP 仍强制绑定。
--
-- 约定：约束沿用「先 DROP IF EXISTS 再 ADD」，重复执行不撞约束名；既有数据
-- 只含 HTTP/MODBUS_TCP，放宽约束不改变任何存量行。

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_protocol_check;
ALTER TABLE devices ADD CONSTRAINT devices_protocol_check
  CHECK (protocol IN ('HTTP', 'MODBUS_TCP', 'MQTT'));

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_binding_check;
ALTER TABLE devices ADD CONSTRAINT devices_binding_check CHECK (
  (protocol IN ('HTTP', 'MQTT') AND binding_json IS NULL)
  OR (protocol = 'MODBUS_TCP' AND binding_json IS NOT NULL)
);
