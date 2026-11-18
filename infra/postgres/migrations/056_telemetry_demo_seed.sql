-- 056 遥测演示种子（A14 验收前置，用户点名补种）
--
-- 046 清史后 telemetry_readings 为空：四情曲线空列表、长势热力与变量播种/施肥
-- 都走「无样本」降级。本迁移补两类数据：
-- 1. 环境读数序列：沿用 010 的波形口径（base + amp×sin，最近 14 天每 3 小时一点），
--    地块编码换成当前台账绑定（044 重建后的新编码），恢复监控页曲线。
-- 2. 苗情空间梯度：054 只给既有 4 台坐标设备落了地块重心，单样本 IDW 出均一网格，
--    变量方案逐带速率不会有差异——这里给 4 个有监测设备的地块各补 2 台演示遥感
--    采样节点（东西向 25%/75% 分位落点），与重心设备构成「西弱东强」三点梯度。
--    苗情四指标（株高/叶色/覆盖度/均匀度）按节点位置取不同基值，同指标同相位，
--    保证最新读数的空间排序稳定，热力图与逐带速率都能看出差异。
--
-- 直接落库不走上报链路，quality_flags 取 049 默认 '[]'（干净行）；波形逐点变化
-- 不会触发 STUCK_VALUE 口径，数值全部在 A11 量程表内。不补告警种子——告警只应
-- 由真实上报越限产生，待处置列表保持空列表可用态。
-- 主键沿用演示规范：device-demo-* / rd-demo-*，全程 ON CONFLICT DO NOTHING 可重复执行。

-- ---------- 1. 演示采样节点：每地块东西两台，坐标按外环包络盒分位落点 ----------
-- 054 已应用在前，不会给后插的设备补坐标，这里插入时一并登记 install_lng/lat。
INSERT INTO devices (id, device_no, name, type, status, plot_code, last_seen_at, install_lng, install_lat)
SELECT 'device-demo-growth-' || lpad(s.seq::text, 2, '0'),
       'DZ-G-DEM-' || lpad(s.seq::text, 2, '0'),
       '长势采样节点 G' || lpad(s.seq::text, 2, '0') || '（演示）',
       'REMOTE_SENSE', 'ONLINE', s.plot_code, now(),
       b.min_lng + s.frac * (b.max_lng - b.min_lng),
       b.avg_lat
  FROM (VALUES
    (1, '511723-000001-01-00005-0000-H', 0.25),  -- 西区一号田（既有 device-soil-004）
    (2, '511723-000001-01-00005-0000-H', 0.75),
    (3, '511723-000001-02-00001-0000-0', 0.25),  -- 东区一号田（既有 device-soil-003）
    (4, '511723-000001-02-00001-0000-0', 0.75),
    (5, '511723-000001-02-00002-0000-U', 0.25),  -- 东区二号田（既有 device-station-002 居中）
    (6, '511723-000001-02-00002-0000-U', 0.75),
    (7, '511723-000001-02-00003-0000-O', 0.25),  -- 东区三号田（既有 device-ndvi-001 居中）
    (8, '511723-000001-02-00003-0000-O', 0.75)
  ) AS s(seq, plot_code, frac)
  JOIN LATERAL (
    SELECT min((pt->>0)::double precision) AS min_lng,
           max((pt->>0)::double precision) AS max_lng,
           avg((pt->>1)::double precision) AS avg_lat
      FROM plot_records p
      CROSS JOIN LATERAL jsonb_array_elements(p.geom->'coordinates'->0) AS pt
     WHERE p.parcel_code = s.plot_code AND p.deleted_at IS NULL
  ) b ON TRUE
ON CONFLICT (id) DO NOTHING;

-- ---------- 2. 读数序列：环境指标 + 苗情空间梯度，最近 14 天每 3 小时一点 ----------
-- 波形与 010 同一套公式；md5 加 '056' 盐与 010 的历史 id 区分。
-- 苗情基值口径：西节点(f=0.25) / 重心设备(f=0.5) / 东节点(f=0.75)：
--   株高 50~85cm → 58.8/67.5/76.3；叶色 30~46SPAD → 34/38/42；
--   覆盖度 45~82% → 54.3/63.5/72.8；均匀度 58~90% → 66/74/82。
INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'rd-demo-' || md5('056|' || s.device_id || '|' || s.metric || '|' || k.n::text),
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
    -- 环境指标：恢复监控页曲线（地块编码为当前台账绑定）
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'soilMoisture',    '%',        34,   10,   0, 1, 'wave'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'soilPh',          '',          7.1,  0.3, 30, 2, 'flat'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'soilEc',          'μS/cm',  1250,  260,  50, 0, 'wave'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'airTemperature',  '°C',       22,    8,  15, 1, 'wave'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'airHumidity',     '%',        70,   18,  20, 1, 'wave'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'windSpeed',       'm/s',       4.5,  4.0, 40, 1, 'wave'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'rainfall',        'mm',        0,   18,  10, 1, 'rain'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'lightIntensity',  'lux',   34000, 28000,  5, 0, 'wave'),
    ('device-soil-003',   '511723-000001-02-00001-0000-0', 'co2Concentration','ppm',     450,   70,  25, 0, 'wave'),
    ('device-soil-004',   '511723-000001-01-00005-0000-H', 'soilMoisture',    '%',        27,    8,   5, 1, 'wave'),
    ('device-soil-004',   '511723-000001-01-00005-0000-H', 'soilPh',          '',          7.3,  0.25,40, 2, 'flat'),
    ('device-soil-004',   '511723-000001-01-00005-0000-H', 'soilEc',          'μS/cm',  1180,  240,  58, 0, 'wave'),
    ('device-soil-004',   '511723-000001-01-00005-0000-H', 'airTemperature',  '°C',       21,    7,  22, 1, 'wave'),
    ('device-station-002','511723-000001-02-00002-0000-U', 'soilMoisture',    '%',        28,    9,  12, 1, 'wave'),
    ('device-station-002','511723-000001-02-00002-0000-U', 'airTemperature',  '°C',       23,    7,   6, 1, 'wave'),
    ('device-station-002','511723-000001-02-00002-0000-U', 'airHumidity',     '%',        68,   16,  24, 1, 'wave'),
    ('device-station-002','511723-000001-02-00002-0000-U', 'windSpeed',       'm/s',       3.6,  2.4, 33, 1, 'wave'),
    ('device-station-002','511723-000001-02-00002-0000-U', 'rainfall',        'mm',        0,   14,  45, 1, 'rain'),
    ('device-station-002','511723-000001-02-00002-0000-U', 'lightIntensity',  'lux',   32000, 26000, 15, 0, 'wave'),
    ('device-weather-001','',                              'airTemperature',  '°C',       23,    9,   8, 1, 'wave'),
    ('device-weather-001','',                              'airHumidity',     '%',        66,   20,  30, 1, 'wave'),
    ('device-weather-001','',                              'windSpeed',       'm/s',       5.5,  6.0, 12, 1, 'wave'),
    ('device-weather-001','',                              'rainfall',        'mm',        0,   26,  27, 1, 'rain'),
    ('device-ndvi-001',   '511723-000001-02-00003-0000-O', 'diseaseIndex',    '',         12,    7,  35, 1, 'wave'),
    ('device-lamp-001',   '511723-000001-02-00003-0000-O', 'pestCount',       '头/百株',   5.2,  3.5,  8, 1, 'wave'),
    ('device-lamp-002',   '511723-000001-02-00009-0000-O', 'pestCount',       '头/百株',   3.4,  2.6, 28, 1, 'wave'),
    ('device-valve-001',  '511723-000001-02-00001-0000-0', 'soilMoisture',    '%',        33,    8,  55, 1, 'wave'),
    -- 苗情四指标：西区一号田（西 G01 / 东 G02，无重心苗情设备）
    ('device-demo-growth-01', '511723-000001-01-00005-0000-H', 'plantHeight',    'cm',   58.8, 2,   10, 1, 'wave'),
    ('device-demo-growth-01', '511723-000001-01-00005-0000-H', 'leafColor',      'SPAD', 34,   1,   20, 1, 'wave'),
    ('device-demo-growth-01', '511723-000001-01-00005-0000-H', 'canopyCoverage', '%',    54.3, 2,   30, 1, 'wave'),
    ('device-demo-growth-01', '511723-000001-01-00005-0000-H', 'uniformity',     '%',    66,   1.5, 40, 1, 'wave'),
    ('device-demo-growth-02', '511723-000001-01-00005-0000-H', 'plantHeight',    'cm',   76.3, 2,   10, 1, 'wave'),
    ('device-demo-growth-02', '511723-000001-01-00005-0000-H', 'leafColor',      'SPAD', 42,   1,   20, 1, 'wave'),
    ('device-demo-growth-02', '511723-000001-01-00005-0000-H', 'canopyCoverage', '%',    72.8, 2,   30, 1, 'wave'),
    ('device-demo-growth-02', '511723-000001-01-00005-0000-H', 'uniformity',     '%',    82,   1.5, 40, 1, 'wave'),
    -- 东区一号田（西 G03 / 东 G04）
    ('device-demo-growth-03', '511723-000001-02-00001-0000-0', 'plantHeight',    'cm',   58.8, 2,   10, 1, 'wave'),
    ('device-demo-growth-03', '511723-000001-02-00001-0000-0', 'leafColor',      'SPAD', 34,   1,   20, 1, 'wave'),
    ('device-demo-growth-03', '511723-000001-02-00001-0000-0', 'canopyCoverage', '%',    54.3, 2,   30, 1, 'wave'),
    ('device-demo-growth-03', '511723-000001-02-00001-0000-0', 'uniformity',     '%',    66,   1.5, 40, 1, 'wave'),
    ('device-demo-growth-04', '511723-000001-02-00001-0000-0', 'plantHeight',    'cm',   76.3, 2,   10, 1, 'wave'),
    ('device-demo-growth-04', '511723-000001-02-00001-0000-0', 'leafColor',      'SPAD', 42,   1,   20, 1, 'wave'),
    ('device-demo-growth-04', '511723-000001-02-00001-0000-0', 'canopyCoverage', '%',    72.8, 2,   30, 1, 'wave'),
    ('device-demo-growth-04', '511723-000001-02-00001-0000-0', 'uniformity',     '%',    82,   1.5, 40, 1, 'wave'),
    -- 东区二号田（西 G05 / 综合站居中 / 东 G06）
    ('device-demo-growth-05', '511723-000001-02-00002-0000-U', 'plantHeight',    'cm',   58.8, 2,   10, 1, 'wave'),
    ('device-demo-growth-05', '511723-000001-02-00002-0000-U', 'leafColor',      'SPAD', 34,   1,   20, 1, 'wave'),
    ('device-demo-growth-05', '511723-000001-02-00002-0000-U', 'canopyCoverage', '%',    54.3, 2,   30, 1, 'wave'),
    ('device-demo-growth-05', '511723-000001-02-00002-0000-U', 'uniformity',     '%',    66,   1.5, 40, 1, 'wave'),
    ('device-station-002',    '511723-000001-02-00002-0000-U', 'plantHeight',    'cm',   67.5, 2,   10, 1, 'wave'),
    ('device-station-002',    '511723-000001-02-00002-0000-U', 'leafColor',      'SPAD', 38,   1,   20, 1, 'wave'),
    ('device-station-002',    '511723-000001-02-00002-0000-U', 'canopyCoverage', '%',    63.5, 2,   30, 1, 'wave'),
    ('device-station-002',    '511723-000001-02-00002-0000-U', 'uniformity',     '%',    74,   1.5, 40, 1, 'wave'),
    ('device-demo-growth-06', '511723-000001-02-00002-0000-U', 'plantHeight',    'cm',   76.3, 2,   10, 1, 'wave'),
    ('device-demo-growth-06', '511723-000001-02-00002-0000-U', 'leafColor',      'SPAD', 42,   1,   20, 1, 'wave'),
    ('device-demo-growth-06', '511723-000001-02-00002-0000-U', 'canopyCoverage', '%',    72.8, 2,   30, 1, 'wave'),
    ('device-demo-growth-06', '511723-000001-02-00002-0000-U', 'uniformity',     '%',    82,   1.5, 40, 1, 'wave'),
    -- 东区三号田（西 G07 / 遥感节点居中 / 东 G08）
    ('device-demo-growth-07', '511723-000001-02-00003-0000-O', 'plantHeight',    'cm',   58.8, 2,   10, 1, 'wave'),
    ('device-demo-growth-07', '511723-000001-02-00003-0000-O', 'leafColor',      'SPAD', 34,   1,   20, 1, 'wave'),
    ('device-demo-growth-07', '511723-000001-02-00003-0000-O', 'canopyCoverage', '%',    54.3, 2,   30, 1, 'wave'),
    ('device-demo-growth-07', '511723-000001-02-00003-0000-O', 'uniformity',     '%',    66,   1.5, 40, 1, 'wave'),
    ('device-ndvi-001',       '511723-000001-02-00003-0000-O', 'plantHeight',    'cm',   67.5, 2,   10, 1, 'wave'),
    ('device-ndvi-001',       '511723-000001-02-00003-0000-O', 'leafColor',      'SPAD', 38,   1,   20, 1, 'wave'),
    ('device-ndvi-001',       '511723-000001-02-00003-0000-O', 'canopyCoverage', '%',    63.5, 2,   30, 1, 'wave'),
    ('device-ndvi-001',       '511723-000001-02-00003-0000-O', 'uniformity',     '%',    74,   1.5, 40, 1, 'wave'),
    ('device-demo-growth-08', '511723-000001-02-00003-0000-O', 'plantHeight',    'cm',   76.3, 2,   10, 1, 'wave'),
    ('device-demo-growth-08', '511723-000001-02-00003-0000-O', 'leafColor',      'SPAD', 42,   1,   20, 1, 'wave'),
    ('device-demo-growth-08', '511723-000001-02-00003-0000-O', 'canopyCoverage', '%',    72.8, 2,   30, 1, 'wave'),
    ('device-demo-growth-08', '511723-000001-02-00003-0000-O', 'uniformity',     '%',    82,   1.5, 40, 1, 'wave')
  ) AS s(device_id, plot_code, metric, unit, base, amp, phase, decimals, shape)
  CROSS JOIN generate_series(0, 111) AS k(n)
ON CONFLICT (id) DO NOTHING;