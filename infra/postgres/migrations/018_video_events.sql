-- 018: 视频 AI 识别事件与云台指令台账。
-- AI 事件先落库再转发遥测生成虫情告警；转发失败由后台中继按重试上限补投，也可人工重试。
-- 云台指令记录操作意图与真实投递结果；摄像机硬件通道经 PTZ_WEBHOOK_URL 接入，未配置时指令留存为 QUEUED。
CREATE TABLE IF NOT EXISTS video_ai_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  camera_id TEXT NOT NULL CHECK (length(trim(camera_id)) > 0),
  plot_code TEXT NOT NULL DEFAULT '',
  pest_type TEXT NOT NULL CHECK (length(trim(pest_type)) > 0),
  level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  image_file_id TEXT,
  detected_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  forwarded BOOLEAN NOT NULL DEFAULT FALSE,
  forward_status INTEGER NOT NULL DEFAULT 0,
  forward_message TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error TEXT,
  forwarded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_video_ai_events_tenant_received ON video_ai_events(tenant_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_video_ai_events_retry ON video_ai_events(received_at) WHERE forwarded = FALSE;

CREATE TABLE IF NOT EXISTS video_ptz_commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  camera_id TEXT NOT NULL CHECK (length(trim(camera_id)) > 0),
  action TEXT NOT NULL CHECK (action IN ('LEFT','RIGHT','UP','DOWN','ZOOM_IN','ZOOM_OUT','STOP')),
  speed INTEGER CHECK (speed IS NULL OR (speed BETWEEN 1 AND 10)),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED')),
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_video_ptz_tenant_created ON video_ptz_commands(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_video_ptz_camera ON video_ptz_commands(tenant_id, camera_id);