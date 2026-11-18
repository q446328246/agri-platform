-- 058 数据字典与数据资产目录（开发方案 11.4 数据治理）
--
-- 「平台同时提供数据字典与数据资产目录，明确各数据的定义、单位、来源与更新频率，
-- 避免同一指标出现多种口径。」
--   platform_data_assets：资产目录，按方案 11.1 五类数据分类（SPATIAL 基础空间 /
--     DEVICE 设备台账 / TELEMETRY 实时感知 / BUSINESS 业务过程 / STATS 统计分析），
--     code 取真实表名，登记来源服务、存储介质、更新频率与是否归集到地块；
--   platform_data_dictionary：字典条目，挂在资产下逐指标登记定义、单位、数据类型、
--     来源与更新频率，(tenant_id, asset_code, metric_key) 唯一，杜绝同指标多口径。
-- 种子为当前仓库真实存在的表与指标（逐条对照迁移 001~057 与前端指标目录），
-- 不登记未建成的表；主键含 demo 标识，ON CONFLICT DO NOTHING 保证可重复执行。

CREATE TABLE IF NOT EXISTS platform_data_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant-demo',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('SPATIAL', 'DEVICE', 'TELEMETRY', 'BUSINESS', 'STATS')),
  description TEXT NOT NULL DEFAULT '',
  source_service TEXT NOT NULL DEFAULT '',
  storage TEXT NOT NULL DEFAULT '',
  update_frequency TEXT NOT NULL DEFAULT '',
  plot_linked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_platform_data_assets_tenant_category
  ON platform_data_assets (tenant_id, category);

CREATE TABLE IF NOT EXISTS platform_data_dictionary (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant-demo',
  asset_code TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  label TEXT NOT NULL,
  definition TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  update_frequency TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_code, metric_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_data_dictionary_tenant_asset
  ON platform_data_dictionary (tenant_id, asset_code);

-- 资产目录种子：code 与真实表名一致，描述/来源/频率按当前实现如实登记
INSERT INTO platform_data_assets (id, tenant_id, code, name, category, description, source_service, storage, update_frequency, plot_linked) VALUES
  ('asset-demo-001', 'tenant-demo', 'plot_records', '地块台账', 'SPATIAL', '地块编码、名称、权属、面积与边界几何，全平台数据归集主线', 'plot-service', 'PostgreSQL + PostGIS', '低频（建档/边界变更时）', TRUE),
  ('asset-demo-002', 'tenant-demo', 'plot_zones', '片区范围', 'SPATIAL', '片区台账与成员地块凸包范围', 'plot-service', 'PostgreSQL + PostGIS', '低频（人工调整时）', TRUE),
  ('asset-demo-003', 'tenant-demo', 'infra_lines', '线路与管线', 'SPATIAL', '机耕道/管线走向与宽度、限速、适用机型等台账属性', 'plot-service', 'PostgreSQL + PostGIS', '低频（建档/编辑时）', TRUE),
  ('asset-demo-004', 'tenant-demo', 'devices', '设备台账', 'DEVICE', '设备类型、型号厂商、安装位置、通信方式与在线状态', 'iot-service', 'PostgreSQL', '低频（建档/维护时）', TRUE),
  ('asset-demo-005', 'tenant-demo', 'telemetry_readings', '墒情与苗情读数', 'TELEMETRY', '土壤温度/湿度/EC/pH/养分与苗情长势指标读数', 'telemetry-service', 'PostgreSQL', '实时（按设备上报周期）', TRUE),
  ('asset-demo-006', 'tenant-demo', 'telemetry_pest_events', '虫情事件', 'TELEMETRY', '虫情测报与视频 AI 识别归集的害虫事件', 'telemetry-service', 'PostgreSQL', '实时（上报/识别回调）', TRUE),
  ('asset-demo-007', 'tenant-demo', 'telemetry_disasters', '灾情记录', 'TELEMETRY', '涝灾/倒伏等灾情上报记录', 'telemetry-service', 'PostgreSQL', '实时（上报时）', TRUE),
  ('asset-demo-008', 'tenant-demo', 'telemetry_alerts', '遥测告警', 'TELEMETRY', '阈值越限与 AI 识别统一收口的告警', 'telemetry-service', 'PostgreSQL', '实时（阈值判定时）', TRUE),
  ('asset-demo-009', 'tenant-demo', 'telemetry_quality_logs', '数据质量异常日志', 'TELEMETRY', '超量程/连续不变/时间戳异常三类可疑标记日志', 'telemetry-service', 'PostgreSQL', '实时（接入校验时）', TRUE),
  ('asset-demo-010', 'tenant-demo', 'weather_forecasts', '七日天气预报', 'TELEMETRY', '日粒度预报：天气现象、温度区间、风力风速、降雨概率与雨量', 'weather-service', 'PostgreSQL', '每日一次（配和风 Key 后外部同步，未配时本地种子）', FALSE),
  ('asset-demo-011', 'tenant-demo', 'weather_forecast_hours', '逐小时天气预报', 'TELEMETRY', '未来逐小时天气现象与要素预报', 'weather-service', 'PostgreSQL', '每日一次（随日预报同步）', FALSE),
  ('asset-demo-012', 'tenant-demo', 'weather_alerts', '气象灾害预警', 'TELEMETRY', '外部气象预警落库，含级别/类型/有效期', 'weather-service', 'PostgreSQL', '每日一次（随外部预警同步）', FALSE),
  ('asset-demo-013', 'tenant-demo', 'video_ai_events', '视频 AI 识别事件', 'TELEMETRY', '摄像机侧算法识别回调，七类事件白名单校验后留记录', 'video-service', 'PostgreSQL', '实时（识别回调时）', TRUE),
  ('asset-demo-014', 'tenant-demo', 'operation_tasks', '农事任务', 'BUSINESS', '六类作业任务台账：排程、优先级、执行设备与状态机', 'operation-service', 'PostgreSQL', '实时（建档/状态跃迁时）', TRUE),
  ('asset-demo-015', 'tenant-demo', 'operation_task_change_logs', '任务变更留痕', 'BUSINESS', '建档/跃迁/归档追加式留痕，含操作人与 traceId', 'operation-service', 'PostgreSQL', '实时（随变更同事务追加）', TRUE),
  ('asset-demo-016', 'tenant-demo', 'control_commands', '控制指令台账', 'BUSINESS', '十一码指令状态机与回执、超时收口留痕', 'control-service', 'PostgreSQL', '实时（事件驱动/人工下发）', TRUE),
  ('asset-demo-017', 'tenant-demo', 'control_authorizations', '指令授权范围', 'BUSINESS', '设备/地块通配 + 授权时间窗的范围管控配置', 'control-service', 'PostgreSQL', '低频（人工维护时）', TRUE),
  ('asset-demo-018', 'tenant-demo', 'decision_prescriptions', '决策处方', 'BUSINESS', '规则引擎签发的灌溉/施肥/配比调整处方与执行回流', 'decision-service', 'PostgreSQL', '实时（规则命中签发时）', TRUE),
  ('asset-demo-019', 'tenant-demo', 'decision_rules', '阈值与处方规则', 'BUSINESS', '遥测越限阈值与处方动作规则配置', 'decision-service', 'PostgreSQL', '低频（人工维护时）', FALSE),
  ('asset-demo-020', 'tenant-demo', 'trace_records', '生产档案', 'BUSINESS', '作业结单回流与人工巡田登记的生产链条时间线', 'trace-service', 'PostgreSQL', '实时（结单/登记时）', TRUE),
  ('asset-demo-021', 'tenant-demo', 'plot_change_logs', '地块变更留痕', 'BUSINESS', '建档/编辑/合并/拆分/流转追加式留痕', 'plot-service', 'PostgreSQL', '实时（随变更同事务追加）', TRUE),
  ('asset-demo-022', 'tenant-demo', 'crop_seasons', '种植季档案', 'BUSINESS', '地块按季登记作物品种与生育期安排', 'plot-service', 'PostgreSQL', '低频（按季建档时）', TRUE),
  ('asset-demo-023', 'tenant-demo', 'ops_messages', '消息中心', 'BUSINESS', '事件订阅生成的告警/通知消息与处置留痕', 'message-service', 'PostgreSQL', '实时（事件消费时）', FALSE),
  ('asset-demo-024', 'tenant-demo', 'video_recording_archives', '录像留档档案', 'BUSINESS', '告警/识别时刻前后应留片段的档案，片源由流媒体侧回填', 'video-service', 'PostgreSQL', '实时（AI 事件自动登记/人工补登）', TRUE),
  ('asset-demo-025', 'tenant-demo', 'variable_rate_plans', '变量作业方案', 'BUSINESS', '覆盖路径逐带速率映射与用量汇总的方案落库', 'operation-service', 'PostgreSQL', '按需（方案预演生成时）', TRUE),
  ('asset-demo-026', 'tenant-demo', 'finance_entries', '投入产出流水', 'STATS', '人工记账的投入/产出流水，监管统计报表前端聚合', 'finance-service', 'PostgreSQL', '低频（人工记账时）', TRUE)
ON CONFLICT DO NOTHING;

-- 字典条目种子：指标 key 与单位对照遥测/气象/前端指标目录，定义按当前实现如实描述
INSERT INTO platform_data_dictionary (id, tenant_id, asset_code, metric_key, label, definition, unit, data_type, source, update_frequency) VALUES
  ('dict-demo-001', 'tenant-demo', 'telemetry_readings', 'soilTemperature', '土壤温度', '田间传感器上报的土壤温度读数', '°C', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-002', 'tenant-demo', 'telemetry_readings', 'soilMoisture', '土壤湿度', '土壤含水量读数，灌溉阈值判定与自动停灌的依据', '%', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-003', 'tenant-demo', 'telemetry_readings', 'soilEc', '土壤EC', '土壤电导率读数，反映盐分水平，EC/pH 偏离联动配比调整', 'μS/cm', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-004', 'tenant-demo', 'telemetry_readings', 'soilPh', '土壤pH', '土壤酸碱度读数，无量纲', '', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-005', 'tenant-demo', 'telemetry_readings', 'soilNitrogen', '氮含量', '土壤氮含量读数', 'mg/kg', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-006', 'tenant-demo', 'telemetry_readings', 'soilPhosphorus', '磷含量', '土壤磷含量读数', 'mg/kg', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-007', 'tenant-demo', 'telemetry_readings', 'soilPotassium', '钾含量', '土壤钾含量读数', 'mg/kg', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-008', 'tenant-demo', 'telemetry_readings', 'soilOrganicMatter', '有机质', '土壤有机质含量读数', 'mg/kg', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-009', 'tenant-demo', 'telemetry_readings', 'airTemperature', '空气温度', '田间气象站空气温度读数', '°C', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-010', 'tenant-demo', 'telemetry_readings', 'airHumidity', '空气湿度', '田间气象站空气相对湿度读数', '%', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-011', 'tenant-demo', 'telemetry_readings', 'windSpeed', '风速', '田间气象站风速读数，喷药适宜性判定要素', 'm/s', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-012', 'tenant-demo', 'telemetry_readings', 'rainfall', '降雨量', '田间气象站降雨量读数', 'mm', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-013', 'tenant-demo', 'telemetry_readings', 'plantHeight', '株高', '苗情长势株高读数', 'cm', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-014', 'tenant-demo', 'telemetry_readings', 'leafColor', '叶色', '苗情叶色读数（SPAD 值）', 'SPAD', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-015', 'tenant-demo', 'telemetry_readings', 'canopyCoverage', '苗情覆盖度', '冠层覆盖度读数，长势网格热力插值输入之一', '%', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-016', 'tenant-demo', 'telemetry_readings', 'uniformity', '均匀度', '苗情长势均匀度读数', '%', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-017', 'tenant-demo', 'telemetry_readings', 'pestCount', '虫口密度', '害虫虫口密度读数', '头/百株', 'number', '虫情测报/视频 AI 识别 → telemetry-service', '实时（上报/识别回调）'),
  ('dict-demo-018', 'tenant-demo', 'telemetry_readings', 'diseaseIndex', '病情指数', '病害发生程度指数，无量纲', '', 'number', '田间设备上报 → telemetry-service', '实时（按设备上报周期）'),
  ('dict-demo-019', 'tenant-demo', 'weather_forecasts', 'rainProbability', '降雨概率', '日预报降雨概率，灌溉推迟与喷防改期判定要素', '%', 'number', '和风天气每日同步 / 本地演示种子', '每日一次'),
  ('dict-demo-020', 'tenant-demo', 'weather_forecasts', 'rainAmount', '预报雨量', '日预报降水量', 'mm', 'number', '和风天气每日同步 / 本地演示种子', '每日一次'),
  ('dict-demo-021', 'tenant-demo', 'weather_forecasts', 'tempMax', '最高温度', '日预报最高气温', '°C', 'number', '和风天气每日同步 / 本地演示种子', '每日一次'),
  ('dict-demo-022', 'tenant-demo', 'weather_forecasts', 'tempMin', '最低温度', '日预报最低气温', '°C', 'number', '和风天气每日同步 / 本地演示种子', '每日一次'),
  ('dict-demo-023', 'tenant-demo', 'weather_forecasts', 'windLevel', '风力等级', '日预报风力等级（级），喷药适宜性判定要素', '级', 'number', '和风天气每日同步 / 本地演示种子', '每日一次'),
  ('dict-demo-024', 'tenant-demo', 'plot_records', 'areaMu', '地块面积', '地块几何面积权威值，PostGIS 现算，不接受请求体自报', '亩', 'number', 'plot-service 几何现算', '边界变更时现算'),
  ('dict-demo-025', 'tenant-demo', 'operation_tasks', 'finishedAreaMu', '完成作业面积', '任务完工回执填报的实际作业面积', '亩', 'number', 'operation-service 任务回执', '任务完工时'),
  ('dict-demo-026', 'tenant-demo', 'control_commands', 'waterVolume', '灌溉用水量', '灌溉指令结单回执上报的用水量；缺测时由处方定额推算并标注来源', 'm³', 'number', 'control-service 结单回执', '指令 DONE 回执时')
ON CONFLICT DO NOTHING;