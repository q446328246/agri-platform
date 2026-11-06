-- 010：全量演示数据
--
-- 目的：让前端每个页面登录后都有可读的数据，而不必先手工录入。
-- 覆盖范围只限落库的业务表；设备、摄像头、农事任务、水肥方案这类
-- 进程内数据由对应服务的种子提供（iot-service / video-service / operation-service）。
--
-- 约定：
-- 1. 所有演示数据的主键都带 demo 前缀，方便识别与清理，不影响真实录入的数据；
-- 2. 全部使用 ON CONFLICT DO NOTHING，迁移重复执行或部分数据已被页面改过时不会报错；
-- 3. 先清掉历史冒烟脚本遗留的记录，避免片区与地块列表里混入「冒烟地块」。
-- 坐标一律 CGCS2000（srid 4490），区域为达川区丘区农机装备产业园（107.421325, 30.982425）周边。

-- ---------- 清理冒烟与部署验证遗留 ----------
DELETE FROM plot_zones WHERE zone_code LIKE 'ZONE-SMOKE-%';
DELETE FROM plot_records WHERE parcel_name LIKE '%冒烟%' OR parcel_name LIKE '%部署验证%';
DELETE FROM infra_lines WHERE line_name LIKE '%冒烟%';

-- ---------- 片区：补齐待划入片区的实测边界 ----------
INSERT INTO plot_zones (id, zone_code, zone_name, tenant_id, farm_id, color, description, geom) VALUES
  ('zone-demo-3', 'ZONE-03', '达川丘区联片', 'tenant-demo', 'farm-kaijiang-01', '#69f0ae',
   '跨村联片作业区，承担无人机植保与农机调度演练',
   '{"type":"Polygon","coordinates":[[[107.4294,30.9818],[107.4362,30.9818],[107.4362,30.9876],[107.4294,30.9876],[107.4294,30.9818]]],"srid":4490}')
ON CONFLICT (zone_code) DO NOTHING;

UPDATE plot_zones SET geom = '{"type":"Polygon","coordinates":[[[107.4294,30.9818],[107.4362,30.9818],[107.4362,30.9876],[107.4294,30.9876],[107.4294,30.9818]]],"srid":4490}'
 WHERE zone_code = 'ZONE-03' AND geom IS NULL;

-- ---------- 地块：三个片区各若干成员，两块暂未划入 ----------
-- 编码由 @agri/plot-core 的 buildPlotCode 生成，校验位与线上一致，可直接用于编码校验
INSERT INTO plot_records (parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, zone_code, geom, created_at, updated_at) VALUES
  ('plot-demo-01', '511723-000001-01-00001-0000-5', '东区一号田', 'tenant-demo', 'farm-kaijiang-01', 26.50, 'CLAY', 'ZONE-01',
   '{"type":"Polygon","coordinates":[[[107.4217,30.9808],[107.4241,30.9807],[107.4252,30.9819],[107.4238,30.9828],[107.4219,30.9822],[107.4217,30.9808]]],"srid":4490}',
   now() - interval '150 days', now() - interval '12 days'),
  ('plot-demo-02', '511723-000001-01-00002-0000-Z', '东区二号田', 'tenant-demo', 'farm-kaijiang-01', 22.00, 'LOAM', 'ZONE-01',
   '{"type":"Polygon","coordinates":[[[107.4253,30.9820],[107.4276,30.9814],[107.4289,30.9826],[107.4272,30.9834],[107.4255,30.9830],[107.4253,30.9820]]],"srid":4490}',
   now() - interval '148 days', now() - interval '30 days'),
  ('plot-demo-03', '511723-000001-01-00003-0000-T', '东区三号田', 'tenant-demo', 'farm-kaijiang-01', 31.40, 'LOAM', 'ZONE-01',
   '{"type":"Polygon","coordinates":[[[107.4240,30.9830],[107.4260,30.9836],[107.4283,30.9842],[107.4290,30.9855],[107.4258,30.9853],[107.4239,30.9841],[107.4240,30.9830]]],"srid":4490}',
   now() - interval '145 days', now() - interval '9 days'),
  ('plot-demo-04', '511723-000001-01-00004-0000-N', '东区四号田', 'tenant-demo', 'farm-kaijiang-01', 18.80, 'SAND', 'ZONE-01',
   '{"type":"Polygon","coordinates":[[[107.4218,30.9824],[107.4236,30.9842],[107.4252,30.9856],[107.4228,30.9857],[107.4216,30.9843],[107.4218,30.9824]]],"srid":4490}',
   now() - interval '140 days', now() - interval '45 days'),
  ('plot-demo-05', '511723-000001-02-00005-0000-C', '西区一号田', 'tenant-demo', 'farm-kaijiang-01', 24.60, 'SILT', 'ZONE-02',
   '{"type":"Polygon","coordinates":[[[107.4135,30.9805],[107.4158,30.9804],[107.4166,30.9818],[107.4148,30.9826],[107.4134,30.9817],[107.4135,30.9805]]],"srid":4490}',
   now() - interval '138 days', now() - interval '20 days'),
  ('plot-demo-06', '511723-000001-02-00006-0000-6', '西区二号田', 'tenant-demo', 'farm-kaijiang-01', 19.20, 'LOAM', 'ZONE-02',
   '{"type":"Polygon","coordinates":[[[107.4168,30.9820],[107.4190,30.9812],[107.4203,30.9824],[107.4187,30.9833],[107.4170,30.9831],[107.4168,30.9820]]],"srid":4490}',
   now() - interval '132 days', now() - interval '60 days'),
  ('plot-demo-07', '511723-000001-02-00007-0000-0', '西区三号田', 'tenant-demo', 'farm-kaijiang-01', 28.70, 'CLAY', 'ZONE-02',
   '{"type":"Polygon","coordinates":[[[107.4148,30.9829],[107.4170,30.9836],[107.4192,30.9843],[107.4200,30.9850],[107.4160,30.9849],[107.4142,30.9840],[107.4148,30.9829]]],"srid":4490}',
   now() - interval '128 days', now() - interval '18 days'),
  ('plot-demo-08', '511723-000001-03-00008-0000-P', '联片一号田', 'tenant-demo', 'farm-kaijiang-01', 35.30, 'LOAM', 'ZONE-03',
   '{"type":"Polygon","coordinates":[[[107.4298,30.9823],[107.4322,30.9821],[107.4331,30.9836],[107.4310,30.9844],[107.4296,30.9835],[107.4298,30.9823]]],"srid":4490}',
   now() - interval '120 days', now() - interval '33 days'),
  ('plot-demo-09', '511723-000001-03-00009-0000-J', '联片二号田', 'tenant-demo', 'farm-kaijiang-01', 41.10, 'SAND', 'ZONE-03',
   '{"type":"Polygon","coordinates":[[[107.4332,30.9838],[107.4356,30.9832],[107.4359,30.9852],[107.4338,30.9858],[107.4325,30.9850],[107.4332,30.9838]]],"srid":4490}',
   now() - interval '118 days', now() - interval '25 days'),
  ('plot-demo-10', '511723-000001-03-00010-0000-U', '联片三号田', 'tenant-demo', 'farm-kaijiang-01', 27.90, 'SILT', 'ZONE-03',
   '{"type":"Polygon","coordinates":[[[107.4300,30.9847],[107.4320,30.9855],[107.4340,30.9871],[107.4312,30.9873],[107.4297,30.9861],[107.4300,30.9847]]],"srid":4490}',
   now() - interval '115 days', now() - interval '50 days'),
  ('plot-demo-11', '511723-000001-04-00011-0000-J', '丘陵整治示范田', 'tenant-demo', 'farm-kaijiang-01', 15.50, 'LOAM', NULL,
   '{"type":"Polygon","coordinates":[[[107.4176,30.9862],[107.4194,30.9860],[107.4199,30.9872],[107.4182,30.9876],[107.4176,30.9862]]],"srid":4490}',
   now() - interval '90 days', now() - interval '90 days'),
  ('plot-demo-12', '511723-000001-04-00012-0000-D', '农机作业演练田', 'tenant-demo', 'farm-kaijiang-01', 20.30, 'SAND', NULL,
   '{"type":"Polygon","coordinates":[[[107.4108,30.9852],[107.4132,30.9856],[107.4140,30.9868],[107.4114,30.9866],[107.4108,30.9852]]],"srid":4490}',
   now() - interval '86 days', now() - interval '86 days')
ON CONFLICT (parcel_code) DO NOTHING;

-- ---------- 田间线路：补齐三条片区机耕道与支线，供一张图图层与导航路网 ----------
INSERT INTO infra_lines (id, line_code, line_name, line_type, tenant_id, geom, length_m) VALUES
  ('infra-line-demo-5', 'LINE-ROAD-002', '东区环田机耕道', 'ROAD', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4216,30.9808],[107.4238,30.9828],[107.4258,30.9852],[107.4288,30.9854]],"srid":4490}', 820),
  ('infra-line-demo-6', 'LINE-ROAD-003', '西区环田机耕道', 'ROAD', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4135,30.9806],[107.4150,30.9828],[107.4162,30.9848],[107.4200,30.9851]],"srid":4490}', 860),
  ('infra-line-demo-7', 'LINE-ROAD-004', '联片机耕道', 'ROAD', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4297,30.9824],[107.4326,30.9846],[107.4352,30.9856],[107.4340,30.9872]],"srid":4490}', 720),
  ('infra-line-demo-8', 'LINE-IRR-002', '东区灌溉支线', 'IRRIGATION_PIPE', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4219,30.9812],[107.4256,30.9831],[107.4286,30.9850]],"srid":4490}', 890),
  ('infra-line-demo-9', 'LINE-FERT-002', '西区施肥支线', 'FERTILIZATION_PIPE', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4138,30.9810],[107.4172,30.9828],[107.4200,30.9845]],"srid":4490}', 760),
  ('infra-line-demo-10', 'LINE-POWER-002', '联片机井电力线路', 'ELECTRIC_LINE', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4292,30.9870],[107.4326,30.9862],[107.4356,30.9856]],"srid":4490}', 700)
ON CONFLICT (line_code) DO NOTHING;

-- ---------- 遥测读数：6 台设备 27 条指标序列，最近 14 天每 3 小时一点 ----------
-- base/amp/phase 决定波形（base + amp × sin），rain 形状按 9 步一轮出现降雨，
-- flat 形状只给极小漂移（如土壤 pH）。取值刻意覆盖阈值规则：
-- 西区墒情会跌破 30%、气象站风速冲到 11 m/s 以上、病情指数与虫口密度也会越限。
INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'rd-demo-' || md5(s.device_id || '|' || s.metric || '|' || k.n::text),
       s.device_id, s.plot_code, s.metric,
       CASE s.shape
         WHEN 'rain' THEN CASE WHEN mod(k.n, 9) < 2
                               THEN ROUND((s.amp * (0.5 + 0.5 * sin(radians(k.n * 31 + s.phase))))::numeric, 1)
                               ELSE 0 END
         WHEN 'flat' THEN ROUND((s.base + s.amp * sin(radians(k.n * 3 + s.phase)) / 10)::numeric, 2)
         ELSE ROUND((s.base + s.amp * sin(radians(k.n * 11 + s.phase)))::numeric, s.decimals)
       END,
       s.unit,
       now() - ((111 - k.n) * interval '3 hours')
  FROM (VALUES
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'soilMoisture',    '%',        34,   10,   0, 1, 'wave'),
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'soilPh',          '',          7.1,  0.3, 30, 2, 'flat'),
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'airTemperature',  '°C',       22,    8,  15, 1, 'wave'),
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'airHumidity',     '%',        70,   18,  20, 1, 'wave'),
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'windSpeed',       'm/s',       4.5,  4.0, 40, 1, 'wave'),
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'rainfall',        'mm',        0,   18,  10, 1, 'rain'),
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'lightIntensity',  'lux',   34000, 28000,  5, 0, 'wave'),
    ('device-soil-003',   '511723-000001-01-00001-0000-5', 'co2Concentration','ppm',     450,   70,  25, 0, 'wave'),
    ('device-station-002','511723-000001-01-00002-0000-Z', 'soilMoisture',    '%',        28,    9,  12, 1, 'wave'),
    ('device-station-002','511723-000001-01-00002-0000-Z', 'canopyCoverage',  '%',        58,   10,  18, 1, 'wave'),
    ('device-station-002','511723-000001-01-00002-0000-Z', 'airTemperature',  '°C',       23,    7,   6, 1, 'wave'),
    ('device-station-002','511723-000001-01-00002-0000-Z', 'airHumidity',     '%',        68,   16,  24, 1, 'wave'),
    ('device-station-002','511723-000001-01-00002-0000-Z', 'windSpeed',       'm/s',       3.6,  2.4, 33, 1, 'wave'),
    ('device-station-002','511723-000001-01-00002-0000-Z', 'rainfall',        'mm',        0,   14,  45, 1, 'rain'),
    ('device-station-002','511723-000001-01-00002-0000-Z', 'lightIntensity',  'lux',   32000, 26000, 15, 0, 'wave'),
    ('device-weather-001','',                              'airTemperature',  '°C',       23,    9,   8, 1, 'wave'),
    ('device-weather-001','',                              'airHumidity',     '%',        66,   20,  30, 1, 'wave'),
    ('device-weather-001','',                              'windSpeed',       'm/s',       5.5,  6.0, 12, 1, 'wave'),
    ('device-weather-001','',                              'rainfall',        'mm',        0,   26,  27, 1, 'rain'),
    ('device-soil-004',   '511723-000001-02-00005-0000-C', 'soilMoisture',    '%',        27,    8,   5, 1, 'wave'),
    ('device-soil-004',   '511723-000001-02-00005-0000-C', 'soilPh',          '',          7.3,  0.25,40, 2, 'flat'),
    ('device-soil-004',   '511723-000001-02-00005-0000-C', 'airTemperature',  '°C',       21,    7,  22, 1, 'wave'),
    ('device-ndvi-001',   '511723-000001-01-00003-0000-T', 'canopyCoverage',  '%',        76,   10,  10, 1, 'wave'),
    ('device-ndvi-001',   '511723-000001-01-00003-0000-T', 'diseaseIndex',    '',         12,    7,  35, 1, 'wave'),
    ('device-lamp-001',   '511723-000001-01-00003-0000-T', 'pestCount',       '头/百株',   5.2,  3.5,  8, 1, 'wave'),
    ('device-lamp-002',   '511723-000001-03-00009-0000-J', 'pestCount',       '头/百株',   3.4,  2.6, 28, 1, 'wave'),
    ('device-valve-001',  '511723-000001-01-00001-0000-5', 'soilMoisture',    '%',        33,    8,  55, 1, 'wave')
  ) AS s(device_id, plot_code, metric, unit, base, amp, phase, decimals, shape)
 CROSS JOIN generate_series(0, 111) AS k(n)
ON CONFLICT (id) DO NOTHING;

-- ---------- 灾情告警：与阈值规则同源，含已处理与待处理 ----------
INSERT INTO telemetry_alerts (id, device_id, plot_code, level, metric, message, created_at, handled, handled_at) VALUES
  ('alert-demo-001', 'device-soil-004', '511723-000001-02-00005-0000-C', 'WARNING', 'soilMoisture', '土壤含水率低于灌溉阈值：实测 24.6%，阈值 30%', now() - interval '6 hours', FALSE, NULL),
  ('alert-demo-002', 'device-weather-001', '', 'CRITICAL', 'windSpeed', '风速超过作业安全阈值：实测 11.4 m/s，暂停无人机植保', now() - interval '11 hours', FALSE, NULL),
  ('alert-demo-003', 'device-ndvi-001', '511723-000001-01-00003-0000-T', 'CRITICAL', 'diseaseIndex', '病情指数超过防控上限：实测 18.2，建议立即喷防', now() - interval '1 days', FALSE, NULL),
  ('alert-demo-004', 'device-lamp-001', '511723-000001-01-00003-0000-T', 'WARNING', 'pestCount', '虫口密度达到防治指标：稻飞虱 8.1 头/百株', now() - interval '2 days', FALSE, NULL),
  ('alert-demo-005', 'device-station-002', '511723-000001-01-00002-0000-Z', 'WARNING', 'canopyCoverage', '苗情覆盖度低于长势下限：实测 49.5%', now() - interval '3 days', TRUE, now() - interval '2 days'),
  ('alert-demo-006', 'device-weather-001', '', 'WARNING', 'rainfall', '降雨量超过排涝阈值：日累计 56.0 mm，检查东区排水沟', now() - interval '5 days', TRUE, now() - interval '4 days'),
  ('alert-demo-007', 'device-soil-003', '511723-000001-01-00001-0000-5', 'INFO', 'airTemperature', '空气温度偏高：实测 31.6 °C，注意灌溉时段', now() - interval '7 days', TRUE, now() - interval '7 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 虫情识别：覆盖三个片区，含已处置与待处置 ----------
INSERT INTO telemetry_pest_events (id, plot_code, device_id, pest_type, level, confidence, image_file_id, detected_at, handled) VALUES
  ('pest-demo-001', '511723-000001-01-00003-0000-T', 'device-lamp-001', '稻飞虱', 3, 0.940, 'file-pest-demo-001', now() - interval '2 days', FALSE),
  ('pest-demo-002', '511723-000001-01-00001-0000-5', 'camera-001', '二化螟', 2, 0.885, 'file-pest-demo-002', now() - interval '3 days', FALSE),
  ('pest-demo-003', '511723-000001-02-00005-0000-C', 'camera-002', '玉米螟', 1, 0.760, 'file-pest-demo-003', now() - interval '4 days', TRUE),
  ('pest-demo-004', '511723-000001-03-00009-0000-J', 'device-lamp-002', '斜纹夜蛾', 2, 0.910, 'file-pest-demo-004', now() - interval '5 days', FALSE),
  ('pest-demo-005', '511723-000001-03-00008-0000-P', 'camera-003', '蚜虫', 1, 0.725, 'file-pest-demo-005', now() - interval '8 days', TRUE),
  ('pest-demo-006', '511723-000001-01-00002-0000-Z', 'camera-001', '粘虫', 3, 0.902, 'file-pest-demo-006', now() - interval '10 days', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ---------- 决策规则：与阈值规则同口径，含启用与停用两类示范 ----------
-- 服务默认已带 `rule-soil-dry`（土壤含水率低于阈值补灌），此处只补差异化规则；
-- `condition_json` 只写决策引擎支持的键（soilMoistureBelow / rainProbabilityBelow / growthStage），
-- 病情与虫口两类指标引擎暂未纳入求值，因此置 enabled = FALSE，列表仅作展示与备料。
INSERT INTO decision_rules (id, rule_name, rule_type, enabled, expression, priority, condition_json, action_json, created_at, updated_at) VALUES
  ('rule-seedling-irrigation', '苗期浅水补灌', 'IRRIGATION', TRUE, 'soilMoisture < 28 && growthStage == 苗期', 20,
   '{"soilMoistureBelow":28,"growthStage":"苗期"}'::jsonb,
   '{"type":"IRRIGATION","amount":12,"unit":"mm","reason":"苗期耐旱性弱，少量多次补给"}'::jsonb,
   now() - interval '60 days', now() - interval '60 days'),
  ('rule-topdressing', '抽穗期追肥', 'FERTILIZATION', TRUE, 'growthStage == 抽穗期', 30,
   '{"growthStage":"抽穗期"}'::jsonb,
   '{"type":"FERTILIZATION","amount":3.5,"unit":"kg/亩","reason":"抽穗期需肥高峰，结合灌溉分次施用"}'::jsonb,
   now() - interval '45 days', now() - interval '45 days'),
  ('rule-disease-index', '病情指数超过防控上限', 'PEST_WARNING', FALSE, 'diseaseIndex > 15', 40,
   '{}'::jsonb,
   '{"type":"PEST_WARNING","amount":0,"unit":"","reason":"遥感反演病情指数越限，建议 24 小时内喷防"}'::jsonb,
   now() - interval '30 days', now() - interval '30 days'),
  ('rule-pest-count', '虫口密度达防治指标', 'PEST_WARNING', FALSE, 'pestCount > 5', 50,
   '{}'::jsonb,
   '{"type":"PEST_WARNING","amount":0,"unit":"","reason":"测报灯虫口达防治指标，纳入统防统治"}'::jsonb,
   now() - interval '26 days', now() - interval '26 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 决策处方：灌溉/施肥推荐与无需处置留痕 ----------
INSERT INTO decision_prescriptions (id, plot_code, plot_name, status, soil_moisture, rain_probability, growth_stage, inputs_json, matched_rules_json, actions_json, generated_at, issued_at) VALUES
  ('presc-demo-001', '511723-000001-02-00005-0000-C', '西区一号田', 'RECOMMENDED', 24.6, 18.0, '分蘖期',
   '{"soilMoisture":24.6,"rainProbability":18,"growthStage":"分蘖期","canopyCoverage":71}',
   '[{"ruleId":"rule-soil-dry","name":"土壤含水率低于阈值补灌","expression":"soilMoisture < 30 && rainProbability < 60"}]',
   '[{"type":"IRRIGATION","deviceId":"device-valve-002","parameters":{"targetMm":25,"durationMin":90},"reason":"含水率低于灌溉阈值且近期无有效降雨"}]',
   now() - interval '6 hours', now() - interval '5 hours'),
  ('presc-demo-002', '511723-000001-01-00003-0000-T', '东区三号田', 'RECOMMENDED', 36.2, 12.0, '拔节期',
   '{"soilMoisture":36.2,"rainProbability":12,"growthStage":"拔节期","diseaseIndex":18.2,"pestCount":8.1}',
   '[{"ruleId":"rule-disease-index","name":"病情指数超过防控上限","expression":"diseaseIndex > 15"}]',
   '[{"type":"SPRAYING","deviceId":"device-drone-001","parameters":{"agent":"戊唑醇","dilution":"1:800","areaMu":31.4},"reason":"病情指数越限且虫口密度达防治指标"}]',
   now() - interval '1 days', now() - interval '22 hours'),
  ('presc-demo-003', '511723-000001-01-00001-0000-5', '东区一号田', 'NO_ACTION', 41.5, 62.0, '苗期',
   '{"soilMoisture":41.5,"rainProbability":62,"growthStage":"苗期","canopyCoverage":64}',
   '[]', '[]',
   now() - interval '2 days', NULL),
  ('presc-demo-004', '511723-000001-03-00009-0000-J', '联片二号田', 'RECOMMENDED', 30.4, 24.0, '抽穗期',
   '{"soilMoisture":30.4,"rainProbability":24,"growthStage":"抽穗期","pestCount":4.1}',
   '[{"ruleId":"rule-topdressing","name":"抽穗期追肥","expression":"growthStage == 抽穗期"}]',
   '[{"type":"FERTILIZATION","deviceId":"device-valve-001","parameters":{"nitrogen":3.5,"phosphorus":1.2,"potassium":1.0,"totalKg":143},"reason":"抽穗期需追施氮肥，结合灌溉水肥一体化"}]',
   now() - interval '3 days', now() - interval '3 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 控制指令：人工与事件两种来源，含排队/已下发/失败 ----------
INSERT INTO control_commands (id, device_id, plot_code, operator_id, confirmed_at, type, parameters, status, origin, source_event_id, reason, created_at) VALUES
  ('cmd-demo-001', 'device-valve-002', '511723-000001-02-00005-0000-C', 'user-admin', now() - interval '5 hours', 'IRRIGATION',
   '{"zones":[{"zoneCode":"A","areaMu":24.6,"targetMm":25}],"flowM3h":18}', 'SENT', 'EVENT', 'evt-demo-presc-001', '处方 presc-demo-001 自动下发', now() - interval '5 hours'),
  ('cmd-demo-002', 'device-valve-001', '511723-000001-01-00001-0000-5', 'user-admin', now() - interval '9 hours', 'FERTILIZATION',
   '{"recipe":{"nitrogen":3.2,"phosphorus":1.0,"potassium":1.1},"stir":{"durationMin":15,"rpm":60}}', 'QUEUED', 'MANUAL', NULL, '', now() - interval '9 hours'),
  ('cmd-demo-003', 'device-drone-001', '511723-000001-01-00003-0000-T', 'user-operator', now() - interval '22 hours', 'WEEDING',
   '{"agent":"戊唑醇","dilution":"1:800","swathWidthM":7}', 'SENT', 'EVENT', 'evt-demo-presc-002', '病情指数越限触发植保', now() - interval '22 hours'),
  ('cmd-demo-004', 'device-station-002', '511723-000001-01-00002-0000-Z', 'user-admin', now() - interval '2 days', 'IRRIGATION',
   '{"zones":[{"zoneCode":"A","areaMu":22,"targetMm":15}],"flowM3h":20}', 'FAILED', 'MANUAL', NULL, '设备 30 秒内未回执，已转人工巡检', now() - interval '2 days'),
  ('cmd-demo-005', 'device-valve-001', '511723-000001-03-00009-0000-J', 'user-operator', now() - interval '3 days', 'FERTILIZATION',
   '{"recipe":{"nitrogen":3.5,"phosphorus":1.2,"potassium":1.0}}', 'SENT', 'EVENT', 'evt-demo-presc-004', '抽穗期追肥处方下发', now() - interval '3 days'),
  ('cmd-demo-006', 'device-tractor-001', '511723-000001-04-00012-0000-D', 'user-operator', now() - interval '6 days', 'SEEDING',
   '{"rowSpacingCm":25,"seedRateKgPerMu":1.8}', 'QUEUED', 'MANUAL', NULL, '', now() - interval '6 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 消息中心：告警、农事提醒与系统通知 ----------
INSERT INTO ops_messages (id, tenant_id, type, title, content, level, is_read, plot_code, source_event_id, dedupe_key, created_at) VALUES
  ('msg-demo-001', 'tenant-demo', 'ALERT', '西区一号田缺水预警', '土壤含水率 24.6%，低于灌溉阈值 30%；已生成灌溉处方并下发阀门指令。', 'WARNING', FALSE, '511723-000001-02-00005-0000-C', NULL, 'demo:soil-west-1', now() - interval '5 hours'),
  ('msg-demo-002', 'tenant-demo', 'ALERT', '大风预警：暂停无人机作业', '气象站实测风速 11.4 m/s，超过作业安全阈值 10 m/s。', 'CRITICAL', FALSE, NULL, NULL, 'demo:wind-safe', now() - interval '10 hours'),
  ('msg-demo-003', 'tenant-demo', 'ALERT', '东区三号田病情越限', '遥感反演病情指数 18.2，超过防控上限 15，建议 24 小时内喷防。', 'CRITICAL', FALSE, '511723-000001-01-00003-0000-T', NULL, 'demo:disease-east-3', now() - interval '1 days'),
  ('msg-demo-004', 'tenant-demo', 'ALERT', '虫情识别：稻飞虱（严重）', '虫情测报灯 L01 识别到稻飞虱 8.1 头/百株，达到防治指标。', 'WARNING', TRUE, '511723-000001-01-00003-0000-T', NULL, 'demo:pest-east-3', now() - interval '2 days'),
  ('msg-demo-005', 'tenant-demo', 'NOTICE', '处方已下发：联片二号田追肥', '按抽穗期需肥量生成水肥处方，折纯氮 3.5 kg/亩，随灌溉分 3 个分区施用。', 'INFO', TRUE, '511723-000001-03-00009-0000-J', NULL, 'demo:presc-zone3-2', now() - interval '3 days'),
  ('msg-demo-006', 'tenant-demo', 'NOTICE', '农事任务提醒：东区二号田灌溉', '计划任务将于明日 06:30 开始，请确认首部阀门与电源状态。', 'INFO', FALSE, '511723-000001-01-00002-0000-Z', NULL, 'demo:task-east-2', now() - interval '3 days'),
  ('msg-demo-007', 'tenant-demo', 'NOTICE', '片区台账更新：达川丘区联片', 'ZONE-03 已补充实测边界并划入 3 块联片地块，合计 104.3 亩。', 'INFO', TRUE, NULL, NULL, 'demo:zone-3', now() - interval '4 days'),
  ('msg-demo-008', 'tenant-demo', 'ALERT', '设备离线提醒：无人驾驶拖拉机 T01', '最后一次上报为 6 小时前，请检查终端电源与通讯卡。', 'WARNING', FALSE, '511723-000001-03-00010-0000-U', NULL, 'demo:device-offline-t01', now() - interval '5 days'),
  ('msg-demo-009', 'tenant-demo', 'NOTICE', '排涝作业完成', '东区主管网排水至限额以下，累计排水 3800 m³，田面无积水。', 'INFO', TRUE, '511723-000001-01-00001-0000-5', NULL, 'demo:drain-done', now() - interval '6 days'),
  ('msg-demo-010', 'tenant-demo', 'NOTICE', '本周农事周报已生成', '覆盖 12 块地块，累计作业 168.3 亩次，投入产出明细见核算页。', 'INFO', FALSE, NULL, NULL, 'demo:weekly', now() - interval '7 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 投入产出核算：2026 主季 + 2025 上季，覆盖 8 块主力地块 ----------
-- 金额按地块序号 pn 做系数浮动，避免所有地块数值雷同；汇总口径由 kind 分组求和。
INSERT INTO finance_entries (id, plot_code, season, kind, category, amount, unit, note, created_at)
SELECT 'fin-demo-' || md5(p.code || '|' || c.category || '|' || '2026'),
       p.code, '2026', 'INPUT', c.category,
       ROUND((c.amount * (0.62 + 0.07 * p.pn))::numeric, 2), '元', c.note,
       now() - ((c.pn * 9 + p.pn * 2) * interval '6 days')
  FROM (VALUES
    ('511723-000001-01-00001-0000-5', 1), ('511723-000001-01-00002-0000-Z', 2), ('511723-000001-01-00003-0000-T', 3), ('511723-000001-01-00004-0000-N', 4),
    ('511723-000001-02-00005-0000-C', 5), ('511723-000001-02-00006-0000-6', 6), ('511723-000001-02-00007-0000-0', 7), ('511723-000001-03-00008-0000-P', 8)
  ) AS p(code, pn)
 CROSS JOIN (VALUES
    ('种子',        980.00, '晶两优534 杂交稻种', 1), ('复合肥',   2150.00, '15-15-15 配方肥 4 袋/亩', 2),
    ('农药',       1680.00, '戊唑醇、氯虫苯甲酰胺', 3), ('农机作业', 2600.00, '机耕、机插、机收外包', 4),
    ('灌溉水电',   1450.00, '水肥一体化首部用电', 5), ('人工',     3200.00, '田间管理与管护用工', 6)
  ) AS c(category, amount, note, pn)
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance_entries (id, plot_code, season, kind, category, amount, unit, note, created_at)
SELECT 'fin-demo-' || md5(p.code || '|' || c.category || '|' || '2026'),
       p.code, '2026', 'OUTPUT', c.category,
       ROUND((c.amount * (0.58 + 0.09 * p.pn))::numeric, 2), '元', c.note,
       now() - ((c.pn * 4 + p.pn) * interval '5 days')
  FROM (VALUES
    ('511723-000001-01-00001-0000-5', 1), ('511723-000001-01-00002-0000-Z', 2), ('511723-000001-01-00003-0000-T', 3), ('511723-000001-01-00004-0000-N', 4),
    ('511723-000001-02-00005-0000-C', 5), ('511723-000001-02-00006-0000-6', 6), ('511723-000001-02-00007-0000-0', 7), ('511723-000001-03-00008-0000-P', 8)
  ) AS p(code, pn)
 CROSS JOIN (VALUES
    ('稻谷销售',   21800.00, '按 1.32 元/斤 订单结算', 1), ('秸秆出售', 1650.00, '打包外运至养殖场', 2),
    ('种粮补贴',    3100.00, '实际种粮农民一次性补贴', 3)
  ) AS c(category, amount, note, pn)
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance_entries (id, plot_code, season, kind, category, amount, unit, note, created_at)
SELECT 'fin-demo-' || md5(p.code || '|' || c.category || '|' || '2025'),
       p.code, '2025', c.kind, c.category,
       ROUND((c.amount * (0.60 + 0.08 * p.pn))::numeric, 2), '元', c.note,
       now() - ((c.pn * 3 + p.pn) * interval '11 days' + interval '130 days')
  FROM (VALUES
    ('511723-000001-01-00001-0000-5', 1), ('511723-000001-01-00003-0000-T', 2),
    ('511723-000001-02-00005-0000-C', 3), ('511723-000001-03-00008-0000-P', 4)
  ) AS p(code, pn)
 CROSS JOIN (VALUES
    ('INPUT',  '种子',      900.00, '上季稻种', 1), ('INPUT', '复合肥',   1980.00, '上季基肥', 2),
    ('INPUT',  '农机作业', 2400.00, '上季外包作业', 3),
    ('OUTPUT', '稻谷销售', 20200.00, '上季订单收购', 4), ('OUTPUT', '种粮补贴', 2900.00, '上季补贴', 5)
  ) AS c(kind, category, amount, note, pn)
ON CONFLICT (id) DO NOTHING;

-- ---------- 生产溯源：处方 → 农事作业 → 作业完成 的完整链路 ----------
INSERT INTO trace_records (id, trace_code, plot_code, event, detail, operator, created_at) VALUES
  ('trace-demo-001', 'TR-2026-0101', '511723-000001-01-00001-0000-5', 'FARM_OPERATION', '冬季翻耕晒垡，旋耕深度 22 cm', '张伟', now() - interval '120 days'),
  ('trace-demo-002', 'TR-2026-0102', '511723-000001-01-00001-0000-5', 'FARM_OPERATION', '播撒商品有机肥 300 kg/亩作基肥', '张伟', now() - interval '105 days'),
  ('trace-demo-003', 'TR-2026-0103', '511723-000001-01-00001-0000-5', 'FARM_OPERATION', '机插秧，晶两优534，行株距 25×15 cm', '李芳', now() - interval '96 days'),
  ('trace-demo-004', 'TR-2026-0104', '511723-000001-01-00001-0000-5', 'PRESCRIPTION_ISSUED', '分蘖期水肥处方：亩施纯氮 3.2 kg，分两次随水施', 'decision-service', now() - interval '78 days'),
  ('trace-demo-005', 'TR-2026-0105', '511723-000001-01-00001-0000-5', 'FARM_OPERATION', '水肥一体化追肥第 1 次，灌溉 15 mm', '李芳', now() - interval '77 days'),
  ('trace-demo-006', 'TR-2026-0106', '511723-000001-01-00001-0000-5', 'OPERATION_COMPLETED', '返青分蘖期作业归档，累计用工 6 人次', '王强', now() - interval '60 days'),
  ('trace-demo-007', 'TR-2026-0201', '511723-000001-01-00002-0000-Z', 'FARM_OPERATION', '机械侧深施肥，缓释肥 40 kg/亩', '张伟', now() - interval '94 days'),
  ('trace-demo-008', 'TR-2026-0202', '511723-000001-01-00002-0000-Z', 'PRESCRIPTION_ISSUED', '覆盖度偏低处方：提高灌溉频次并叶面补锌', 'decision-service', now() - interval '3 days'),
  ('trace-demo-009', 'TR-2026-0203', '511723-000001-01-00002-0000-Z', 'FARM_OPERATION', '叶面肥喷施 2 遍，含磷酸二氢钾', '李芳', now() - interval '2 days'),
  ('trace-demo-010', 'TR-2026-0301', '511723-000001-01-00003-0000-T', 'FARM_OPERATION', '无人机植保：戊唑醇 1:800 喷雾，作业 31.4 亩', '王强', now() - interval '22 hours'),
  ('trace-demo-011', 'TR-2026-0302', '511723-000001-01-00003-0000-T', 'PRESCRIPTION_ISSUED', '病情指数 18.2 越限，生成喷防处方', 'decision-service', now() - interval '1 days'),
  ('trace-demo-012', 'TR-2026-0303', '511723-000001-01-00003-0000-T', 'OPERATION_COMPLETED', '病虫害统防统治完成，防效复查 92%', '王强', now() - interval '16 hours'),
  ('trace-demo-013', 'TR-2026-0401', '511723-000001-01-00004-0000-N', 'FARM_OPERATION', '稻田养鸭共作投放鸭苗 25 只/亩', '李芳', now() - interval '45 days'),
  ('trace-demo-014', 'TR-2026-0402', '511723-000001-01-00004-0000-N', 'OPERATION_COMPLETED', '绿色防控阶段归档，化学农药减量 32%', '王强', now() - interval '12 days'),
  ('trace-demo-015', 'TR-2026-0501', '511723-000001-02-00005-0000-C', 'PRESCRIPTION_ISSUED', '含水率 24.6% 补灌处方：灌溉 25 mm', 'decision-service', now() - interval '6 hours'),
  ('trace-demo-016', 'TR-2026-0502', '511723-000001-02-00005-0000-C', 'FARM_OPERATION', '西区阀门 V02 开灌 90 分钟，实测进水 27 mm', '张伟', now() - interval '5 hours'),
  ('trace-demo-017', 'TR-2026-0503', '511723-000001-02-00005-0000-C', 'FARM_OPERATION', '坡耕地等高埂整治，新建田埂 260 m', '李芳', now() - interval '70 days'),
  ('trace-demo-018', 'TR-2026-0601', '511723-000001-02-00007-0000-0', 'FARM_OPERATION', '机械深松 35 cm 打破犁底层', '王强', now() - interval '88 days'),
  ('trace-demo-019', 'TR-2026-0701', '511723-000001-03-00008-0000-P', 'FARM_OPERATION', '跨村联片机收，损失率 2.1%', '张伟', now() - interval '30 days'),
  ('trace-demo-020', 'TR-2026-0702', '511723-000001-03-00008-0000-P', 'OPERATION_COMPLETED', '秸秆还田并施加腐熟剂，作业 35.3 亩', '张伟', now() - interval '28 days'),
  ('trace-demo-021', 'TR-2026-0801', '511723-000001-03-00009-0000-J', 'PRESCRIPTION_ISSUED', '抽穗期追肥处方：折纯氮 3.5 kg/亩', 'decision-service', now() - interval '3 days'),
  ('trace-demo-022', 'TR-2026-0802', '511723-000001-03-00010-0000-U', 'FARM_OPERATION', '无人驾驶拖拉机耕整地演练，作业 27.9 亩', '李芳', now() - interval '6 days')
ON CONFLICT (trace_code) DO NOTHING;

-- ---------- 系统管理：演示账号与一个自定义角色 ----------
-- password_hash 为开发期兼容散列 sha256('agri:demo123)，登录后可用 demo123；
-- 服务在下次登录成功时会按 needsRehash 自动升级为 scrypt。
INSERT INTO auth_users (id, tenant_id, username, password_hash, name, phone, direct_permissions, status, created_at, updated_at) VALUES
  ('user-demo-agronomist', 'tenant-demo', 'agronomist', '074a7427b47de6450a81dc3cf8e1823770225e2533540b4213b87eaec74a052a', '李农技', '13900000002', '[]'::jsonb, 'ACTIVE', now() - interval '120 days', now() - interval '120 days'),
  ('user-demo-operator', 'tenant-demo', 'operator01', '074a7427b47de6450a81dc3cf8e1823770225e2533540b4213b87eaec74a052a', '张农机', '13900000003', '[]'::jsonb, 'ACTIVE', now() - interval '118 days', now() - interval '118 days'),
  ('user-demo-viewer', 'tenant-demo', 'viewer01', '074a7427b47de6450a81dc3cf8e1823770225e2533540b4213b87eaec74a052a', '王巡查', '13900000004', '[]'::jsonb, 'ACTIVE', now() - interval '60 days', now() - interval '60 days'),
  ('user-demo-disabled', 'tenant-demo', 'temp01', '074a7427b47de6450a81dc3cf8e1823770225e2533540b4213b87eaec74a052a', '临时账号', '13900000005', '[]'::jsonb, 'DISABLED', now() - interval '30 days', now() - interval '2 days')
ON CONFLICT (tenant_id, username) DO NOTHING;

INSERT INTO platform_roles (id, tenant_id, name, code, description, status, created_at, updated_at) VALUES
  ('role-demo-finance', 'tenant-demo', '财务核算员', 'finance-officer', '负责投入产出登记与溯源档案核对', 'ACTIVE', now() - interval '60 days', now() - interval '60 days')
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id, permission_code) VALUES
  ('role-demo-finance', 'dashboard:read'),
  ('role-demo-finance', 'finance:read'),
  ('role-demo-finance', 'finance:write'),
  ('role-demo-finance', 'trace:read'),
  ('role-demo-finance', 'trace:write'),
  ('role-demo-finance', 'message:read')
ON CONFLICT DO NOTHING;

INSERT INTO auth_user_roles (user_id, role_code) VALUES
  ('user-demo-agronomist', 'agronomist'),
  ('user-demo-operator', 'operator'),
  ('user-demo-viewer', 'finance-officer'),
  ('user-demo-disabled', 'operator')
ON CONFLICT DO NOTHING;
