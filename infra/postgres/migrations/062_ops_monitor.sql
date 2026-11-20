-- 062 运维监控告警（F3）：服务/基础设施巡检状态、告警规则与告警台账。
--
-- 监控是平台级能力，不随租户隔离：巡检目标为全部微服务与基础设施（Postgres/MinIO），
-- 状态与告警全局一份。告警触发/恢复经事件日志投递 platform.service.down /
-- platform.service.recovered，由消息中心按订阅偏好生成告警与恢复通知。

CREATE TABLE IF NOT EXISTS ops_service_status (
  /** 监控目标标识：服务名（telemetry 等）或基础设施名（postgres / minio） */
  target TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('SERVICE', 'INFRA')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UP', 'DOWN', 'UNKNOWN')),
  /** 最近一次探测耗时，单位：毫秒；探测失败时为空 */
  latency_ms INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  last_up_at TIMESTAMPTZ,
  last_down_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_monitor_rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('SERVICE_DOWN', 'SERVICE_SLOW', 'INFRA_DOWN')),
  /** SERVICE_SLOW 的响应时长阈值（毫秒）；DOWN 类规则不使用，置 0 */
  threshold_ms INTEGER NOT NULL DEFAULT 0 CHECK (threshold_ms >= 0),
  /** 连续异常轮次达到该值才触发告警，抑制单轮抖动误报 */
  consecutive INTEGER NOT NULL DEFAULT 1 CHECK (consecutive >= 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_monitor_alerts (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('SERVICE_DOWN', 'SERVICE_SLOW', 'INFRA_DOWN')),
  level TEXT NOT NULL CHECK (level IN ('WARNING', 'CRITICAL')),
  status TEXT NOT NULL CHECK (status IN ('FIRING', 'RESOLVED')),
  message TEXT NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

-- 同一目标同一类型最多一条在报告警：巡检重复触发靠约束兜底去重
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_monitor_alerts_firing
  ON ops_monitor_alerts (target, kind) WHERE status = 'FIRING';

CREATE INDEX IF NOT EXISTS idx_ops_monitor_alerts_status
  ON ops_monitor_alerts (status, fired_at DESC);

-- 种子：默认告警规则。服务连续 3 轮不可用、响应连续 3 轮超 2000 毫秒、
-- 基础设施连续 2 轮不可用才告警；阈值可在运维监控页调整。
INSERT INTO ops_monitor_rules (id, kind, threshold_ms, consecutive, enabled, updated_at) VALUES
('rule-service-down', 'SERVICE_DOWN', 0, 3, TRUE, now()),
('rule-service-slow', 'SERVICE_SLOW', 2000, 3, TRUE, now()),
('rule-infra-down', 'INFRA_DOWN', 0, 2, TRUE, now())
ON CONFLICT (id) DO NOTHING;