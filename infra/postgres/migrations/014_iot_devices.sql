-- 014：设备台账表
--
-- 动机：页面「添加设备」原先只有按钮，iot-service 的台账是进程内硬编码数组，
-- 新增既无接口也不落库，重启即失。本迁移把台账落成 devices 表，并注入与
-- TypeScript 侧 demoDevices() 完全同一批的 12 台设备，保证既有设备 id 不变
-- （遥测读数、控制指令、视频摄像头都按这些 id 关联）。
--
-- 约定：
-- 1. 不加 tenant_id：设备域与 control_commands 一致按全局台账管理，
--    加一列却从不按它过滤只会误导后续开发；
-- 2. type 的 CHECK 取值与 apps/web/src/utils/device.ts 的选项、
--    iot-service 的 DEVICE_TYPES 常量三处同口径，新增类型时三处一起改；
-- 3. plot_code 用空串表示「未绑定地块」，避免仓储层到处判 NULL；
-- 4. 种子 ON CONFLICT DO NOTHING，重复执行与后续人工改名都不会被覆盖。

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  device_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'WEATHER_STATION', 'SOIL_SENSOR', 'INTEGRATED_STATION', 'REMOTE_SENSE', 'INSECT_LAMP',
    'FERTILIZER_VALVE', 'IRRIGATION_VALVE', 'IRRIGATION_PUMP', 'AGRICULTURAL_DRONE', 'AUTO_TRACTOR'
  )),
  status TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE', 'OFFLINE')),
  plot_code TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_type ON devices (type);
CREATE INDEX IF NOT EXISTS idx_devices_plot ON devices (plot_code) WHERE plot_code <> '';

-- 演示台账：与迁移 010 的地块编码一一对应，气象站挂在首部而不落具体地块。
-- last_seen_at 用相对小时数锚定，任何时候跑迁移都是「刚刚上报」或「离线 N 小时」。
INSERT INTO devices (id, device_no, name, type, status, plot_code, last_seen_at) VALUES
  ('device-weather-001',    'DZ-W-001', '达州气象站 A01',           'WEATHER_STATION',    'ONLINE',  '',                                     now()),
  ('device-soil-003',       'DZ-S-003', '东区一号田墒情站 S03',      'SOIL_SENSOR',        'ONLINE',  '511723-000001-01-00001-0000-5',         now()),
  ('device-station-002',    'DZ-C-002', '东区二号田综合监测站 C02',  'INTEGRATED_STATION', 'ONLINE',  '511723-000001-01-00002-0000-Z',         now()),
  ('device-soil-004',       'DZ-S-004', '西区一号田墒情站 S04',      'SOIL_SENSOR',        'ONLINE',  '511723-000001-02-00005-0000-C',         now()),
  ('device-ndvi-001',       'DZ-R-001', '苗情遥感反演节点 R01',      'REMOTE_SENSE',       'ONLINE',  '511723-000001-01-00003-0000-T',         now() - INTERVAL '2 hours'),
  ('device-lamp-001',       'DZ-L-001', '东区虫情测报灯 L01',        'INSECT_LAMP',        'ONLINE',  '511723-000001-01-00003-0000-T',         now()),
  ('device-lamp-002',       'DZ-L-002', '联片虫情测报灯 L02',        'INSECT_LAMP',        'OFFLINE', '511723-000001-03-00009-0000-J',         now() - INTERVAL '14 hours'),
  ('device-valve-001',      'DZ-V-001', '首部水肥泵阀 V01',          'FERTILIZER_VALVE',   'ONLINE',  '511723-000001-01-00001-0000-5',         now()),
  ('device-valve-002',      'DZ-V-002', '西区灌溉阀门 V02',          'IRRIGATION_VALVE',   'ONLINE',  '511723-000001-02-00005-0000-C',         now()),
  ('device-pump-001',       'DZ-P-001', '联片灌溉泵站 P01',          'IRRIGATION_PUMP',    'ONLINE',  '511723-000001-03-00008-0000-P',         now() - INTERVAL '1 hours'),
  ('device-drone-001',      'DZ-D-001', '植保无人机 U01',            'AGRICULTURAL_DRONE', 'ONLINE',  '511723-000001-01-00003-0000-T',         now() - INTERVAL '3 hours'),
  ('device-tractor-001',    'DZ-T-001', '无人驾驶拖拉机 T01',        'AUTO_TRACTOR',       'OFFLINE', '511723-000001-03-00010-0000-U',         now() - INTERVAL '6 hours')
ON CONFLICT (id) DO NOTHING;
