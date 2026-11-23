-- 070：摄像机台账
--
-- 起因：摄像机此前由 video-service 进程内维护（http.ts 里写死的演示数组），没有落库、
-- 没有增删改接口，前端无法配置摄像头（改流地址、绑地块、增删都要动代码重建镜像）。
-- 本迁移建摄像机台账，使摄像头可建档、可改、可删，并保留原有四台演示摄像机。
--
-- 约定：
-- 1. 摄像机不进 iot-service 设备台账：设备台账管的是「可下发控制指令」的水肥/农机，
--    摄像机走独立的监看/云台/录像链路，云台指令有独立状态机（QUEUED/SENT/FAILED），
--    不并入控制指令状态机；
-- 2. 流地址（stream_url）是 B 类外部条件：平台只存地址、不保证能拉到流，
--    地址不可用时前端如实提示「流不可用」，不伪造画面；
-- 3. 演示种子沿用既有编号 camera-001~004，与迁移 010 的虫情演示数据
--    （device_id = camera-001/002/003）及 AI 识别事件的 cameraId 引用保持一致，不换号；
-- 4. 建表与种子均可重复执行（IF NOT EXISTS / ON CONFLICT DO NOTHING）。

CREATE TABLE IF NOT EXISTS video_cameras (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  /** 绑定地块编码，未绑定为空串 */
  plot_code  TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE')),
  /** 实时流地址（HLS m3u8 / mp4）；B 类外部条件，平台只存不保证可拉 */
  stream_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_cameras_tenant ON video_cameras (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_cameras_plot ON video_cameras (plot_code);

-- 演示摄像机（与迁移 010 虫情数据、AI 识别事件引用同编号）
INSERT INTO video_cameras (id, tenant_id, name, plot_code, status, stream_url) VALUES
  ('camera-001', 'tenant-demo', '东区一号田摄像头', '511723-000001-01-00001-0000-5', 'ONLINE', 'https://example.invalid/live/camera-001.m3u8'),
  ('camera-002', 'tenant-demo', '西区一号田摄像头', '511723-000001-02-00005-0000-C', 'ONLINE', 'https://example.invalid/live/camera-002.m3u8'),
  ('camera-003', 'tenant-demo', '联片一号田摄像头', '511723-000001-03-00008-0000-P', 'ONLINE', 'https://example.invalid/live/camera-003.m3u8'),
  ('camera-004', 'tenant-demo', '场部入口枪机', '', 'OFFLINE', 'https://example.invalid/live/camera-004.m3u8')
ON CONFLICT (id) DO NOTHING;
