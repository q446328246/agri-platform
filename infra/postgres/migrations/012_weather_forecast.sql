-- 012：天气预报与灾害预警表
--
-- 动机：文档 5.3「本地五天天气状况」与 6.5「田间气象站」要求按日期与逐小时展示预报、
-- 支持预警发布与农事作业提示。原 weather-service 只有硬编码数组，无落库能力。
-- 本迁移新建三张表并灌入演示数据，与 TypeScript 侧 demo.ts 保持同一口径。
--
-- 约定：
-- 1. weather_forecasts / weather_forecast_hours / weather_alerts 均为天气服务专用表，
--    不与 telemetry_readings 交叉；遥测读数仍由 008 表承载；
-- 2. forecast_date 取 DATE 类型（非 timestamptz），逐小时预报用 timestamp，方便按日窗口过滤；
-- 3. 全部 ON CONFLICT DO NOTHING，可重复执行；时间锚定 now()，任何时候跑都有当日数据。

-- ---------- 五日天气预报 ----------
CREATE TABLE IF NOT EXISTS weather_forecasts (
  id TEXT PRIMARY KEY,
  forecast_date DATE NOT NULL,
  city TEXT NOT NULL,
  weather TEXT NOT NULL,
  temp_min NUMERIC(5, 1) NOT NULL,
  temp_max NUMERIC(5, 1) NOT NULL,
  wind_direction TEXT NOT NULL DEFAULT '东南风',
  wind_level SMALLINT NOT NULL DEFAULT 2,
  wind_speed NUMERIC(5, 1) NOT NULL DEFAULT 3.0,
  rain_probability SMALLINT NOT NULL DEFAULT 20,
  rain_amount NUMERIC(6, 1) NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (forecast_date, city)
);

CREATE INDEX IF NOT EXISTS idx_weather_forecasts_date ON weather_forecasts (forecast_date);

-- ---------- 逐小时预报 ----------
CREATE TABLE IF NOT EXISTS weather_forecast_hours (
  id TEXT PRIMARY KEY,
  hour_at TIMESTAMPTZ NOT NULL UNIQUE,
  weather TEXT NOT NULL,
  temperature NUMERIC(5, 1) NOT NULL,
  humidity SMALLINT NOT NULL DEFAULT 60,
  wind_speed NUMERIC(5, 1) NOT NULL DEFAULT 3.0,
  rain_probability SMALLINT NOT NULL DEFAULT 20,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weather_forecast_hours_at ON weather_forecast_hours (hour_at);

-- ---------- 气象灾害预警 ----------
CREATE TABLE IF NOT EXISTS weather_alerts (
  id TEXT PRIMARY KEY,
  alert_code TEXT NOT NULL UNIQUE,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('RAINSTORM','WIND','HIGH_TEMP','LOW_TEMP','DROUGHT','THUNDER','FOG')),
  level TEXT NOT NULL CHECK (level IN ('INFO','WARNING','CRITICAL')),
  color TEXT NOT NULL DEFAULT '黄',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '达州市',
  plot_code TEXT NOT NULL DEFAULT '',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_weather_alerts_active ON weather_alerts (active) WHERE active = TRUE;

-- ---------- 演示数据：五日预报 ----------
INSERT INTO weather_forecasts (id, forecast_date, city, weather, temp_min, temp_max, wind_direction, wind_level, wind_speed, rain_probability, rain_amount, refreshed_at) VALUES
  ('wx-day-demo-1', now()::date,              '达州市', '多云', 21, 31, '东南风', 2, 3.4, 24, 0,  now()),
  ('wx-day-demo-2', now()::date + 1,          '达州市', '晴',   22, 33, '南风',   2, 2.8, 18, 0,  now()),
  ('wx-day-demo-3', now()::date + 2,          '达州市', '中雨', 20, 27, '北风',   4, 8.6, 82, 24, now()),
  ('wx-day-demo-4', now()::date + 3,          '达州市', '阵雨', 19, 26, '西北风', 3, 5.2, 61, 9,  now()),
  ('wx-day-demo-5', now()::date + 4,          '达州市', '多云', 20, 29, '东风',   2, 3.1, 30, 0,  now())
ON CONFLICT DO NOTHING;

-- ---------- 演示数据：逐小时预报（48 小时，从当前整点开始） ----------
INSERT INTO weather_forecast_hours (id, hour_at, weather, temperature, humidity, wind_speed, rain_probability, refreshed_at)
SELECT 'wx-hour-demo-' || (n + 1)::text,
       date_trunc('hour', now()) + (n || ' hours')::interval,
       CASE
         WHEN (n / 12) = 2 THEN '中雨'
         WHEN (n / 12) = 3 AND n % 12 BETWEEN 4 AND 10 THEN '阵雨'
         WHEN (n / 12) = 1 THEN '晴'
         ELSE '多云'
       END,
       ROUND((21 + 5 * sin(radians(n * 15 - 120)))::numeric, 1),
       CAST(ROUND(60 + 20 * sin(radians(n * 12 + 45)))::int AS SMALLINT),
       ROUND((3 + 2.5 * sin(radians(n * 10 + 30)))::numeric, 1),
       CASE
         WHEN (n / 12) = 2 THEN CAST(70 + (n % 12) * 2 AS SMALLINT)
         WHEN (n / 12) = 3 AND n % 12 BETWEEN 4 AND 10 THEN CAST(55 + (n % 12) * 3 AS SMALLINT)
         ELSE CAST(GREATEST(10, 24 - (n % 12)) AS SMALLINT)
       END,
       now()
FROM generate_series(0, 47) AS n
ON CONFLICT DO NOTHING;

-- ---------- 演示数据：预警 ----------
INSERT INTO weather_alerts (id, alert_code, alert_type, level, color, title, description, city, plot_code, issued_at, expires_at, active) VALUES
  ('wx-alert-demo-1', 'WX-RAINSTORM-DEMO-1', 'RAINSTORM', 'CRITICAL', '橙', '暴雨橙色预警',
   '未来 24 小时累计降雨量将达 50 mm 以上，请提前疏通排水沟渠，暂停田间作业', '达州市', '',
   now() - interval '2 hours', now() + interval '22 hours', TRUE),
  ('wx-alert-demo-2', 'WX-WIND-DEMO-2', 'WIND', 'WARNING', '黄', '大风黄色预警',
   '阵风可达 7 级，无人机植保与喷灌作业暂停，注意加固设施棚膜', '达州市', '',
   now() - interval '1 hours', now() + interval '14 hours', TRUE),
  ('wx-alert-demo-3', 'WX-HOT-DEMO-3', 'HIGH_TEMP', 'WARNING', '黄', '高温黄色预警',
   '连续三日最高气温超过 33°C，注意灌溉时段选择傍晚，防止作物热害', '达州市',
   '511723-000001-01-00001-0000-5', now() - interval '30 hours', now() - interval '6 hours', TRUE),
  ('wx-alert-demo-4', 'WX-THUNDER-DEMO-4', 'THUNDER', 'INFO', '蓝', '雷电蓝色预警（已解除）',
   '雷雨云团已东移，田间作业恢复正常', '达州市', '',
   now() - interval '52 hours', now() - interval '28 hours', FALSE)
ON CONFLICT DO NOTHING;
