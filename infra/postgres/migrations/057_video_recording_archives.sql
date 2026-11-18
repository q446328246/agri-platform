-- 057 录像留档档案表（A13 告警时刻前后录像片段自动留档）
--
-- 开发方案 7.1/7.2：多画面分屏监看由前端承载，本表解决「告警时刻前后录像片段
-- 自动留档」的档案侧：AI 识别事件落库时同步登记一条留档（事件时刻 ± 前后窗口），
-- 人工也可补登。片段本体依赖 B 类流媒体服务切片上传，平台侧只留档案与接口：
--   status：PENDING 待切片（流媒体未接入时的诚实状态）/ ARCHIVED 已留档 / FAILED 切片失败
--   storage_key / playback_url：流媒体侧经内部接口回填，未回填前为空，不伪造回放地址
-- 摄像机台账与实时流地址仍由 video-service 进程内维护（片源属 B 类），本表不重复建 cameras。

CREATE TABLE IF NOT EXISTS video_recording_archives (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant-demo',
  camera_id TEXT NOT NULL,
  plot_code TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('AI_EVENT', 'ALERT', 'MANUAL')),
  event_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  event_at TIMESTAMPTZ NOT NULL,
  pre_seconds INTEGER NOT NULL DEFAULT 30 CHECK (pre_seconds >= 0 AND pre_seconds <= 600),
  post_seconds INTEGER NOT NULL DEFAULT 60 CHECK (post_seconds >= 0 AND post_seconds <= 600),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  storage_key TEXT NOT NULL DEFAULT '',
  playback_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ARCHIVED', 'FAILED')),
  message TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_video_recording_archives_tenant_created
  ON video_recording_archives (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_recording_archives_camera_started
  ON video_recording_archives (camera_id, started_at DESC);