-- 013：一张图新增「通信网线」线路类型（TELECOM），补齐参考图的「网线」图层
--
-- 背景：008 给 infra_lines.line_type 建了 CHECK 约束，只允许灌溉/施肥/电力/机耕道四类。
-- 首页「一张图驾驶舱」的图例含「水线 / 电线 / 网线」，其中「网线」对应通信线路，
-- 需要放开约束纳入 TELECOM，并补两条示范通信线，使图层在未接入真实测绘时也有内容。
-- 迁移只追加新文件、不改旧文件；重建约束用 DROP + ADD 保证幂等（IF NOT EXISTS 语义靠先删后加）。

ALTER TABLE infra_lines DROP CONSTRAINT IF EXISTS infra_lines_line_type_check;
ALTER TABLE infra_lines
  ADD CONSTRAINT infra_lines_line_type_check
  CHECK (line_type IN ('IRRIGATION_PIPE', 'FERTILIZATION_PIPE', 'ELECTRIC_LINE', 'ROAD', 'TELECOM'));

-- 示范区通信网线：监控/物联网基站与田间设备间的通信线路（srid 4490，坐标落在既有示范田范围）
INSERT INTO infra_lines (id, line_code, line_name, line_type, tenant_id, geom, length_m) VALUES
  ('infra-line-net-1', 'LINE-NET-001', '示范区监控通信主干', 'TELECOM', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4150,30.9800],[107.4205,30.9822],[107.4262,30.9845],[107.4310,30.9862]],"srid":4490}', 1620),
  ('infra-line-net-2', 'LINE-NET-002', '东南片区物联网支线', 'TELECOM', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4262,30.9845],[107.4288,30.9886],[107.4305,30.9922]],"srid":4490}', 860)
ON CONFLICT (line_code) DO NOTHING;
