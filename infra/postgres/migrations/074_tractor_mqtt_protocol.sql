-- 074：演示拖拉机接入协议改 MQTT（B2 端到端打通）
--
-- 起因：开启 MQTT 接入后，指令中继（command-relay）只服务 protocol='MQTT' 的设备，
-- 而演示台账里 12 台设备全部是 HTTP 回调式（迁移 038 的 DEFAULT 'HTTP'）。拖拉机是
-- 文档约定中唯一订阅平台主题收指令、报遥测的直连设备（订阅
-- agri/{tenant}/{deviceNo}/command，上报 .../telemetry 与 .../receipt），协议不改，
-- 指令会一直停在 QUEUED 直到超时收口——MQTT 开了也看不出效果。
--
-- 约定：
-- 1. 只改 AUTO_TRACTOR 类型且未绑 Modbus 地址的演示拖拉机；现场 Modbus 从站一行不碰；
-- 2. MQTT 不要求绑定（迁移 068 的 CHECK 已放宽：HTTP/MQTT 的 binding_json 必须为 NULL），
--    因此同步把历史绑定清空，避免「协议与绑定同生同灭」的约束挡住 UPDATE；
-- 3. 用 ON CONFLICT/条件 UPDATE，重复执行结果一致；设备编号唯一口径为 (tenant_id, device_no)，
--    只更新演示租户下的一台，不跨租户误改。

UPDATE devices
   SET protocol = 'MQTT',
       binding_json = NULL,
       updated_at = now()
 WHERE device_no = 'DZ-T-001'
   AND tenant_id = 'tenant-demo'
   AND type = 'AUTO_TRACTOR'
   AND binding_json IS NULL;
