-- 044：地块/管线/片区测试数据重置——按 2026-11 卫星底图重新生成小尺度田块
--
-- 背景：迁移 010 的示范地块单块 70~110 亩，与丘陵实景田块（1~5 亩梯田）尺度不符，
-- 页面手绘残留同样偏大。本迁移整体清除旧地块域（plot_records/infra_lines/plot_zones/plot_change_logs），
-- 按 Esri World Imagery z17 瓦片目视解译的田块边界重建 13 块小田、7 条管线、2 个片区；
-- 面积按边界几何现算（@agri/shared polygonAreaMu），长度按 haversine 现算，编码校验位走 @agri/plot-core。
-- 旧地块上的业务历史（设备绑定/农事任务/财务/溯源/遥测/告警/处方/指令）不删除，按映射改挂到新地块，避免悬空引用。
-- 坐标为 CGCS2000/WGS84 度（srid 4490），与高德底图显示层的 GCJ-02 转换无关。

-- ---------- 1) 旧编码业务引用改挂 ----------
-- 会话级临时表：单事务与逐句两种执行方式都成立，用完显式删除
CREATE TEMP TABLE plot_reset_mapping (old_code TEXT PRIMARY KEY, new_code TEXT NOT NULL, new_name TEXT NOT NULL);
INSERT INTO plot_reset_mapping (old_code, new_code, new_name) VALUES
  ('511723-000001-01-00001-0000-5', '511723-000001-02-00001-0000-0', '东片一号田'),
  ('511723-000001-01-00002-0000-Z', '511723-000001-02-00002-0000-U', '东片二号田'),
  ('511723-000001-01-00003-0000-T', '511723-000001-02-00003-0000-O', '东片设施棚'),
  ('511723-000001-01-00004-0000-N', '511723-000001-01-00004-0000-N', '北坡梯田一号'),
  ('511723-000001-01-08701-0000-3', '511723-000001-01-00005-0000-H', '北坡梯田二号'),
  ('511723-000001-01-13093-0000-P', '511723-000001-01-00006-0000-B', '北坡梯田三号'),
  ('511723-000001-01-26420-0000-Z', '511723-000001-02-00007-0000-0', '塘边梯田一号'),
  ('511723-000001-01-26436-0000-S', '511723-000001-02-00008-0000-U', '塘边柑橘园'),
  ('511723-000001-01-38276-0000-U', '511723-000001-02-00009-0000-O', '塘边旱作田'),
  ('511723-000001-01-40764-0000-N', '511723-000001-02-00010-0000-Z', '山坪塘虾田'),
  ('511723-000001-01-51095-0000-3', '511723-000001-01-00011-0000-Y', '北坡台地一号'),
  ('511723-000001-01-51412-0000-X', '511723-000001-01-00012-0000-S', '北坡台地二号'),
  ('511723-000001-01-80981-0000-7', '511723-000001-01-00013-0000-M', '北坡待整治田'),
  ('511723-000001-01-94350-0000-U', '511723-000001-02-00001-0000-0', '东片一号田'),
  ('511723-000001-01-98677-0000-S', '511723-000001-02-00002-0000-U', '东片二号田'),
  ('511723-000001-01-98696-0000-K', '511723-000001-02-00003-0000-O', '东片设施棚'),
  ('511723-000001-01-98714-0000-E', '511723-000001-01-00004-0000-N', '北坡梯田一号'),
  ('511723-000001-02-00005-0000-C', '511723-000001-01-00005-0000-H', '北坡梯田二号'),
  ('511723-000001-02-00006-0000-6', '511723-000001-01-00006-0000-B', '北坡梯田三号'),
  ('511723-000001-02-00007-0000-0', '511723-000001-02-00007-0000-0', '塘边梯田一号'),
  ('511723-000001-03-00008-0000-P', '511723-000001-02-00008-0000-U', '塘边柑橘园'),
  ('511723-000001-03-00009-0000-J', '511723-000001-02-00009-0000-O', '塘边旱作田'),
  ('511723-000001-03-00010-0000-U', '511723-000001-02-00010-0000-Z', '山坪塘虾田'),
  ('511723-000001-03-E7M02-0000-C', '511723-000001-01-00011-0000-Y', '北坡台地一号'),
  ('511723-000001-03-FNZNH-0000-7', '511723-000001-01-00012-0000-S', '北坡台地二号'),
  ('511723-000001-04-00011-0000-J', '511723-000001-01-00013-0000-M', '北坡待整治田'),
  ('511723-000001-04-00012-0000-D', '511723-000001-02-00001-0000-0', '东片一号田');
UPDATE devices AS t SET plot_code = m.new_code FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
UPDATE operation_tasks AS t SET plot_code = m.new_code FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
UPDATE finance_entries AS t SET plot_code = m.new_code FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
UPDATE trace_records AS t SET plot_code = m.new_code FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
UPDATE telemetry_readings AS t SET plot_code = m.new_code FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
UPDATE telemetry_alerts AS t SET plot_code = m.new_code FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
UPDATE control_commands AS t SET plot_code = m.new_code FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
UPDATE decision_prescriptions AS t SET plot_code = m.new_code, plot_name = m.new_name FROM plot_reset_mapping AS m WHERE t.plot_code = m.old_code;
DROP TABLE plot_reset_mapping;

-- ---------- 2) 清除旧地块域（含软删行与旧留痕） ----------
DELETE FROM plot_change_logs;
DELETE FROM plot_zones;
DELETE FROM infra_lines;
DELETE FROM plot_records;

-- ---------- 3) 新片区 ----------
INSERT INTO plot_zones (id, zone_code, zone_name, tenant_id, farm_id, color, description, geom) VALUES
  ('zone-demo-101', 'ZONE-01', '北坡梯田片', 'tenant-demo', 'farm-kaijiang-01', '#00d4ff', '厂区北坡梯田与台地，迁移 044 按卫星底图重划', '{"type":"Polygon","coordinates":[[[107.4221,30.9878],[107.4239,30.9878],[107.4239,30.9894],[107.4221,30.9894],[107.4221,30.9878]]],"srid":4490}'),
  ('zone-demo-102', 'ZONE-02', '塘边东片', 'tenant-demo', 'farm-kaijiang-01', '#7cff6b', '山坪塘东侧梯田与设施棚，迁移 044 按卫星底图重划', '{"type":"Polygon","coordinates":[[[107.4231,30.985],[107.4267,30.985],[107.4267,30.987],[107.4231,30.987],[107.4231,30.985]]],"srid":4490}')
ON CONFLICT (zone_code) DO NOTHING;

-- ---------- 4) 新地块：面积 = 边界几何 ----------
INSERT INTO plot_records (parcel_id, parcel_code, parcel_name, tenant_id, farm_id, area_mu, soil_type, zone_code, geom, created_at, updated_at, plot_type, plot_status, current_crop, owner_name, owner_phone, remark) VALUES
  ('plot-demo-101', '511723-000001-02-00001-0000-0', '东片一号田', 'tenant-demo', 'farm-kaijiang-01', 2.72, 'CLAY', 'ZONE-02', '{"type":"Polygon","coordinates":[[[107.42354,30.986],[107.42406,30.986],[107.42406,30.98567],[107.42354,30.98567],[107.42354,30.986]]],"srid":4490}', now() - interval '120 days', now() - interval '2 days', 'FIELD', 'ACTIVE', '水稻', '张建国', '13908187201', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-102', '511723-000001-02-00002-0000-U', '东片二号田', 'tenant-demo', 'farm-kaijiang-01', 2.73, 'LOAM', 'ZONE-02', '{"type":"Polygon","coordinates":[[[107.42356,30.98565],[107.4241,30.98565],[107.4241,30.98533],[107.42356,30.98533],[107.42356,30.98565]]],"srid":4490}', now() - interval '113 days', now() - interval '2 days', 'FIELD', 'ACTIVE', '玉米', '李秀兰', '13908187202', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-103', '511723-000001-02-00003-0000-O', '东片设施棚', 'tenant-demo', 'farm-kaijiang-01', 1.97, 'LOAM', 'ZONE-02', '{"type":"Polygon","coordinates":[[[107.42318,30.98685],[107.42372,30.98685],[107.42372,30.98662],[107.42318,30.98662],[107.42318,30.98685]]],"srid":4490}', now() - interval '106 days', now() - interval '2 days', 'GREENHOUSE', 'ACTIVE', '黄瓜', '王晓东', '13908187203', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-104', '511723-000001-01-00004-0000-N', '北坡梯田一号', 'tenant-demo', 'farm-kaijiang-01', 1.25, 'CLAY', 'ZONE-01', '{"type":"Polygon","coordinates":[[[107.42259,30.98613],[107.42298,30.98616],[107.42302,30.98596],[107.42263,30.98593],[107.42259,30.98613]]],"srid":4490}', now() - interval '99 days', now() - interval '2 days', 'FIELD', 'ACTIVE', '水稻', '陈利军', '13908187204', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-105', '511723-000001-01-00005-0000-H', '北坡梯田二号', 'tenant-demo', 'farm-kaijiang-01', 1.27, 'LOAM', 'ZONE-01', '{"type":"Polygon","coordinates":[[[107.42254,30.9859],[107.42294,30.98591],[107.42297,30.98571],[107.42257,30.9857],[107.42254,30.9859]]],"srid":4490}', now() - interval '92 days', now() - interval '2 days', 'FIELD', 'ACTIVE', '大豆', '汤秀明', '13908187207', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-106', '511723-000001-01-00006-0000-B', '北坡梯田三号', 'tenant-demo', 'farm-kaijiang-01', 1.33, 'SAND', 'ZONE-01', '{"type":"Polygon","coordinates":[[[107.42265,30.98566],[107.42305,30.98567],[107.42308,30.98546],[107.42268,30.98545],[107.42265,30.98566]]],"srid":4490}', now() - interval '85 days', now() - interval '2 days', 'FIELD', 'FALLOW', '油菜', '罗朝山', '13908187206', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-107', '511723-000001-02-00007-0000-0', '塘边梯田一号', 'tenant-demo', 'farm-kaijiang-01', 1.85, 'CLAY', 'ZONE-02', '{"type":"Polygon","coordinates":[[[107.42561,30.9863],[107.4261,30.98634],[107.42615,30.9861],[107.42566,30.98607],[107.42561,30.9863]]],"srid":4490}', now() - interval '78 days', now() - interval '2 days', 'FIELD', 'ACTIVE', '水稻', '周德丰', '13908187208', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-108', '511723-000001-02-00008-0000-U', '塘边柑橘园', 'tenant-demo', 'farm-kaijiang-01', 2.35, 'SAND', 'ZONE-02', '{"type":"Polygon","coordinates":[[[107.42593,30.98672],[107.42625,30.98685],[107.42658,30.98678],[107.4265,30.98653],[107.42605,30.98655],[107.42593,30.98672]]],"srid":4490}', now() - interval '71 days', now() - interval '2 days', 'ORCHARD', 'ACTIVE', '柑橘', '罗朝山', '13908187206', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-109', '511723-000001-02-00009-0000-O', '塘边旱作田', 'tenant-demo', 'farm-kaijiang-01', 2.94, 'LOAM', 'ZONE-02', '{"type":"Polygon","coordinates":[[[107.42453,30.98612],[107.42508,30.98616],[107.42512,30.98582],[107.42457,30.98579],[107.42453,30.98612]]],"srid":4490}', now() - interval '64 days', now() - interval '2 days', 'FIELD', 'ARCHIVED', '玉米', '邓志强', '13908187210', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-110', '511723-000001-02-00010-0000-Z', '山坪塘虾田', 'tenant-demo', 'farm-kaijiang-01', 3.85, 'CLAY', 'ZONE-02', '{"type":"Polygon","coordinates":[[[107.42555,30.98565],[107.42595,30.98562],[107.42609,30.9854],[107.42595,30.98517],[107.42558,30.98515],[107.42545,30.98538],[107.42555,30.98565]]],"srid":4490}', now() - interval '57 days', now() - interval '2 days', 'AQUACULTURE', 'ACTIVE', '小龙虾', '徐桂林', '13908187209', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-111', '511723-000001-01-00011-0000-Y', '北坡台地一号', 'tenant-demo', 'farm-kaijiang-01', 2.5, 'CLAY', 'ZONE-01', '{"type":"Polygon","coordinates":[[[107.42221,30.98838],[107.42276,30.98842],[107.4228,30.98813],[107.42225,30.9881],[107.42221,30.98838]]],"srid":4490}', now() - interval '50 days', now() - interval '2 days', 'FIELD', 'ACTIVE', '水稻', '何小平', '13908187212', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-112', '511723-000001-01-00012-0000-S', '北坡台地二号', 'tenant-demo', 'farm-kaijiang-01', 2.15, 'LOAM', 'ZONE-01', '{"type":"Polygon","coordinates":[[[107.42318,30.98921],[107.42373,30.98924],[107.42377,30.98899],[107.42322,30.98897],[107.42318,30.98921]]],"srid":4490}', now() - interval '43 days', now() - interval '2 days', 'FIELD', 'ACTIVE', '玉米', '张建国', '13908187201', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）'),
  ('plot-demo-113', '511723-000001-01-00013-0000-M', '北坡待整治田', 'tenant-demo', 'farm-kaijiang-01', 1.72, 'SAND', 'ZONE-01', '{"type":"Polygon","coordinates":[[[107.42232,30.98805],[107.42282,30.98808],[107.42286,30.98786],[107.42236,30.98784],[107.42232,30.98805]]],"srid":4490}', now() - interval '36 days', now() - interval '2 days', 'FIELD', 'DRAFT', NULL, '董建国', '13908187211', '测试数据：按 2026-11 卫星底图目视解译生成，面积按边界几何现算（迁移 044）')
ON CONFLICT (parcel_code) DO NOTHING;

-- ---------- 5) 新管线：长度 = 折线现算 ----------
INSERT INTO infra_lines (id, line_code, line_name, line_type, tenant_id, geom, length_m) VALUES
  ('infra-line-demo-101', 'LINE-ROAD-101', '北坡机耕道', 'ROAD', 'tenant-demo', '{"type":"LineString","coordinates":[[107.42157,30.98901],[107.42221,30.98915],[107.42275,30.98883],[107.42329,30.98851],[107.42377,30.98846],[107.42406,30.98828]],"srid":4490}', 268.34),
  ('infra-line-demo-102', 'LINE-ROAD-102', '梯田田间道', 'ROAD', 'tenant-demo', '{"type":"LineString","coordinates":[[107.42377,30.98846],[107.4236,30.9876],[107.4233,30.9868],[107.423,30.986],[107.4228,30.9854]],"srid":4490}', 353.26),
  ('infra-line-demo-103', 'LINE-IRR-101', '塘边灌溉主管', 'IRRIGATION_PIPE', 'tenant-demo', '{"type":"LineString","coordinates":[[107.42577,30.9854],[107.425,30.9856],[107.4242,30.9858],[107.4234,30.9859],[107.4227,30.986]],"srid":4490}', 300.85),
  ('infra-line-demo-104', 'LINE-IRR-102', '北坡灌溉支线', 'IRRIGATION_PIPE', 'tenant-demo', '{"type":"LineString","coordinates":[[107.4242,30.9858],[107.424,30.9866],[107.4236,30.9874],[107.423,30.9882],[107.4225,30.9886]],"srid":4490}', 358.71),
  ('infra-line-demo-105', 'LINE-IRR-103', '东片灌溉支线', 'IRRIGATION_PIPE', 'tenant-demo', '{"type":"LineString","coordinates":[[107.42577,30.9854],[107.4259,30.9861],[107.4262,30.9867]],"srid":4490}', 151.4),
  ('infra-line-demo-106', 'LINE-ELEC-101', '田间电力线', 'ELECTRIC_LINE', 'tenant-demo', '{"type":"LineString","coordinates":[[107.4242,30.9893],[107.42415,30.988],[107.4241,30.9865],[107.42405,30.9848]],"srid":4490}', 500.58),
  ('infra-line-demo-107', 'LINE-NET-101', '监控通信线', 'TELECOM', 'tenant-demo', '{"type":"LineString","coordinates":[[107.4213,30.9826],[107.4218,30.984],[107.4223,30.9852],[107.4226,30.986]],"srid":4490}', 397.94)
ON CONFLICT (line_code) DO NOTHING;
