-- 008：四情监测、阈值规则与一张图设施线路
--
-- 三类数据：
-- 1. telemetry_rules：把原先硬编码在 telemetry http.ts 里的阈值搬到数据表，改阈值不用发版，
--    也为「苗情/虫情/灾情」共用同一套判定口径（direction 区分上限/下限）。
-- 2. telemetry_pest_events：虫情识别结果（AI 回调或人工上报），是 TelemetryPestDetected
--    事件的持久化来源；level 1/2/3 对应轻微/中等/严重，桌面端按此分级展示。
-- 3. infra_lines：一张图的灌溉管线、施肥管线、电力线路与道路，geom 存 GeoJSON LineString，
--    与地块 geom 一样用 JSONB 保持前后端字段一致（srid 4490）。

CREATE TABLE IF NOT EXISTS telemetry_rules (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  threshold NUMERIC(16, 4) NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARNING', 'CRITICAL')),
  message TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一指标只保留一条规则，避免上报时命中多条导致重复告警
CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_rules_metric ON telemetry_rules (metric);

INSERT INTO telemetry_rules (id, metric, direction, threshold, level, message) VALUES
  ('rule-soil-moisture', 'soilMoisture', 'below', 30, 'WARNING', '土壤含水率低于灌溉阈值'),
  ('rule-air-temperature', 'airTemperature', 'above', 40, 'WARNING', '空气温度超出适宜区间'),
  ('rule-wind-speed', 'windSpeed', 'above', 10, 'CRITICAL', '风速超过作业安全阈值'),
  ('rule-rainfall', 'rainfall', 'above', 50, 'WARNING', '降雨量超过排涝阈值'),
  ('rule-canopy-coverage', 'canopyCoverage', 'below', 60, 'WARNING', '苗情覆盖度低于长势下限'),
  ('rule-pest-count', 'pestCount', 'above', 5, 'WARNING', '虫口密度达到防治指标'),
  ('rule-disease-index', 'diseaseIndex', 'above', 15, 'CRITICAL', '病情指数超过防控上限')
ON CONFLICT (metric) DO NOTHING;

CREATE TABLE IF NOT EXISTS telemetry_pest_events (
  id TEXT PRIMARY KEY,
  plot_code TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  pest_type TEXT NOT NULL,
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 3),
  confidence NUMERIC(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  image_file_id TEXT,
  detected_at TIMESTAMPTZ NOT NULL,
  handled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pest_events_plot_time ON telemetry_pest_events (plot_code, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_pest_events_pending ON telemetry_pest_events (handled, detected_at DESC);

CREATE TABLE IF NOT EXISTS infra_lines (
  id TEXT PRIMARY KEY,
  line_code TEXT NOT NULL UNIQUE,
  line_name TEXT NOT NULL,
  line_type TEXT NOT NULL CHECK (line_type IN ('IRRIGATION_PIPE', 'FERTILIZATION_PIPE', 'ELECTRIC_LINE', 'ROAD')),
  tenant_id TEXT NOT NULL DEFAULT 'tenant-demo',
  geom JSONB NOT NULL,
  length_m NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_infra_lines_tenant ON infra_lines (tenant_id, line_type) WHERE deleted_at IS NULL;

-- 示范区示例线路：没有真实测绘数据时，一张图仍有可切换的管线图层
INSERT INTO infra_lines (id, line_code, line_name, line_type, tenant_id, geom, length_m) VALUES
  ('infra-line-demo-1', 'LINE-IRR-001', '示范区主管灌溉线', 'IRRIGATION_PIPE', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4132,30.9791],[107.4181,30.9806],[107.4234,30.9821],[107.4286,30.9843]],"srid":4490}', 1860),
  ('infra-line-demo-2', 'LINE-FERT-001', '示范区施肥支线', 'FERTILIZATION_PIPE', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4234,30.9821],[107.4249,30.9864],[107.4268,30.9901]],"srid":4490}', 980),
  ('infra-line-demo-3', 'LINE-POWER-001', '机井电力线路', 'ELECTRIC_LINE', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4108,30.9849],[107.4166,30.9858],[107.4228,30.9871]],"srid":4490}', 1240)
ON CONFLICT (line_code) DO NOTHING;
