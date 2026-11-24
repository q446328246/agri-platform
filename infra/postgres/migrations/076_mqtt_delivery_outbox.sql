-- 076：MQTT 可靠投递队列
--
-- QoS 1 只保证 broker 与客户端之间的传输，不保证 HTTP 转发或应用发布已经成功。
-- 入站消息先落库，业务接口成功后才确认；出站指令先落库，broker PUBACK 后才删除。
-- 进程在任一步之间退出，重启后仍可按 next_attempt_at 重试。

CREATE TABLE IF NOT EXISTS mqtt_deliveries (
    id text PRIMARY KEY,
    direction text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    tenant_id text NOT NULL,
    device_no text NOT NULL,
    device_id text NOT NULL,
    topic text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mqtt_deliveries_due
    ON mqtt_deliveries (status, next_attempt_at, created_at);

-- 入站记录保留 24 小时用于 QoS 重投去重；到期由投递完成路径清理，不积压无限历史。
CREATE INDEX IF NOT EXISTS idx_mqtt_deliveries_inbound_created
    ON mqtt_deliveries (created_at) WHERE direction = 'INBOUND';
