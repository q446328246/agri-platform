-- 077：按 MQTT 报文标识关联 QoS 重传，避免把相同载荷的正常上报误去重。
-- 正常报文复用已完成的 packet_id 时释放旧键；重传或仍在途时复用当前键。

ALTER TABLE mqtt_deliveries
    ADD COLUMN IF NOT EXISTS packet_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mqtt_deliveries_inbound_packet_key
    ON mqtt_deliveries (packet_key)
    WHERE direction = 'INBOUND' AND packet_key IS NOT NULL;
