-- 065：拖拉机作业台账与安全事件（B2 无人农机作业链路）
--
-- 动机：方案 8.2 要求无人拖拉机自动作业链路——指令下发、状态回传、RTK 作业轨迹，
-- 并以电子围栏/急停/断链保护为作业安全红线。原控制侧只有单条指令的下发与回执，
-- 没有「一次作业由多条分步指令组成」的编排留痕，也没有作业期安全验证事件台账。
--
-- 约定：
-- 1. 一次作业（tractor_jobs）由分步指令（tractor_job_stages）组成：换具 → 作业 →
--    返航；每步挂控制侧指令标识，复用控制服务的指令生命周期（QUEUED→SENT→DONE）；
-- 2. 作业状态机：PLANNED → RUNNING → COMPLETED / PAUSED / FAILED / ESTOPPED，
--    PAUSED 可复核后恢复，ESTOPPED 为终态须新开作业；
-- 3. tractor_safety_events 记录作业前预检失败与作业期安全验证事件
--    （围栏越界/RTK 质量劣化/通信失联/急停），与消息中心事件同口径留痕；
-- 4. 全部可重复执行（IF NOT EXISTS），时间列统一 TIMESTAMPTZ。

CREATE TABLE IF NOT EXISTS tractor_jobs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  plot_code     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  /** 作业类型：SEEDING 播种 / TILLAGE 整地 / WEEDING 除草，与控制指令类型同源 */
  operation_type TEXT NOT NULL CHECK (operation_type IN ('SEEDING', 'TILLAGE', 'WEEDING')),
  /** 作业参数：面积（亩）、作业时长（分钟）等，随作业留痕 */
  parameters    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL CHECK (status IN ('PLANNED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'ESTOPPED')),
  /** 当前分步指令在序列中的位置，0 表示尚未开始 */
  current_stage SMALLINT NOT NULL DEFAULT 0,
  operator      TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tractor_jobs_plot ON tractor_jobs (plot_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tractor_jobs_device ON tractor_jobs (device_id, status);
CREATE INDEX IF NOT EXISTS idx_tractor_jobs_status ON tractor_jobs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS tractor_job_stages (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES tractor_jobs (id) ON DELETE CASCADE,
  /** 分步类型：TOOL_SWITCH 换具 / OPERATION 作业 / RETURN_HOME 返航 */
  stage        TEXT NOT NULL CHECK (stage IN ('TOOL_SWITCH', 'OPERATION', 'RETURN_HOME')),
  /** 控制侧指令类型，与 stage 对应 */
  command_type TEXT NOT NULL,
  /** 控制服务指令标识，下发后回填 */
  command_id   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'DONE', 'FAILED', 'SKIPPED')),
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tractor_job_stages_job ON tractor_job_stages (job_id, created_at);

CREATE TABLE IF NOT EXISTS tractor_safety_events (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  job_id     TEXT,
  plot_code  TEXT NOT NULL DEFAULT '',
  device_id  TEXT NOT NULL DEFAULT '',
  /** PRECHECK_FAIL 作业前预检失败 / GEOFENCE_BREACH 围栏越界 / RTK_QUALITY RTK 质量劣化 / COMM_LOSS 通信失联 / ESTOP 急停 */
  kind       TEXT NOT NULL CHECK (kind IN ('PRECHECK_FAIL', 'GEOFENCE_BREACH', 'RTK_QUALITY', 'COMM_LOSS', 'ESTOP')),
  level      TEXT NOT NULL CHECK (level IN ('WARNING', 'CRITICAL')),
  message    TEXT NOT NULL DEFAULT '',
  lng        NUMERIC(10, 6),
  lat        NUMERIC(10, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tractor_safety_job ON tractor_safety_events (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tractor_safety_plot ON tractor_safety_events (plot_code, created_at DESC);

-- ---------- 演示数据（B2 端到端可见） ----------
-- 迁移 014 已登记演示拖拉机 device-tractor-001（DZ-T-001，绑定地块 03-00010）。
-- 作业前预检要求设备在线且有 RTK 定位，这里把设备置为在线，并按地块边界首顶点
-- 灌入一组 RTK 读数（rtkLongitude/rtkLatitude 取地块多边形第一个顶点，rtkHdop/rtkFix
-- 为演示质量值），使作业下发与围栏判定在演示库可直接走通。
-- 实际部署中设备在线与 RTK 数据由现场设备心跳与定位上报驱动，此处仅为演示种子。
UPDATE devices
   SET status = 'ONLINE', last_seen_at = now()
 WHERE device_no = 'DZ-T-001' AND type = 'AUTO_TRACTOR';

INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'b2-rtk-001', 'device-tractor-001', '511723-000001-03-00010-0000-U', 'rtkLongitude',
       (geom->'coordinates'->0->0->0)::numeric, 'deg', now() - INTERVAL '10 minutes'
  FROM plot_records WHERE parcel_code = '511723-000001-03-00010-0000-U'
ON CONFLICT (id) DO NOTHING;

INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'b2-rtk-002', 'device-tractor-001', '511723-000001-03-00010-0000-U', 'rtkLatitude',
       (geom->'coordinates'->0->0->1)::numeric, 'deg', now() - INTERVAL '10 minutes'
  FROM plot_records WHERE parcel_code = '511723-000001-03-00010-0000-U'
ON CONFLICT (id) DO NOTHING;

INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'b2-rtk-003', 'device-tractor-001', '511723-000001-03-00010-0000-U', 'rtkLongitude',
       (geom->'coordinates'->0->0->0)::numeric, 'deg', now() - INTERVAL '2 minutes'
  FROM plot_records WHERE parcel_code = '511723-000001-03-00010-0000-U'
ON CONFLICT (id) DO NOTHING;

INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'b2-rtk-004', 'device-tractor-001', '511723-000001-03-00010-0000-U', 'rtkLatitude',
       (geom->'coordinates'->0->0->1)::numeric, 'deg', now() - INTERVAL '2 minutes'
  FROM plot_records WHERE parcel_code = '511723-000001-03-00010-0000-U'
ON CONFLICT (id) DO NOTHING;

INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
VALUES ('b2-rtk-005', 'device-tractor-001', '511723-000001-03-00010-0000-U', 'rtkHdop', 1.2, 'HDOP', now() - INTERVAL '2 minutes'),
       ('b2-rtk-006', 'device-tractor-001', '511723-000001-03-00010-0000-U', 'rtkFix', 1, 'FIX', now() - INTERVAL '2 minutes')
ON CONFLICT (id) DO NOTHING;
