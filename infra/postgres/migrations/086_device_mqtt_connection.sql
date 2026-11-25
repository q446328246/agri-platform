-- 086：设备自带 MQTT 连接配置
--
-- MQTT 设备通常已在 broker 侧自有账号。平台只保存连接所需参数，不再为每台设备改 .env；
-- 密码使用服务端 AES-256-GCM 加密后写入 JSONB，CA 证书是公开文本，可随设备下载。
-- 测试环境可另外开启 EMQX 自动开户，但这不是生产接入的前置条件。
-- 存量 MQTT 设备允许暂时没有配置，避免迁移要求补造账号或密码。

ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_config_json JSONB;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_mqtt_config_check;
ALTER TABLE devices ADD CONSTRAINT devices_mqtt_config_check CHECK (
  (protocol <> 'MQTT' AND mqtt_config_json IS NULL)
  OR (protocol = 'MQTT' AND (mqtt_config_json IS NULL OR jsonb_typeof(mqtt_config_json) = 'object'))
);
