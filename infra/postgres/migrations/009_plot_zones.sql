-- 009：片区台账与地块片区归属
--
-- 1. plot_zones：片区是六段式地块编码里 area 段的业务实体（2 位片区号），
--    原先只隐含在编码中，无法改名、配色或按片区统计，这里单独落表。
--    geom 可选：有实测边界就存 Polygon；没有时前端按成员地块外轮廓的凸包显示。
-- 2. plot_records.zone_code：地块归属哪个片区。用列而不是关联表，
--    因为归属是「一块地只属于一个片区」的一对多，列表过滤与统计都只需单表条件。
--
-- 片区编码全局唯一（含已软删记录），与 infra_lines 的 line_code 口径一致：
-- 编码一旦用过就不再分配给其他片区，避免历史单据指向漂移。

CREATE TABLE IF NOT EXISTS plot_zones (
  id TEXT PRIMARY KEY,
  zone_code TEXT NOT NULL UNIQUE,
  zone_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'tenant-demo',
  farm_id TEXT NOT NULL DEFAULT 'farm-kaijiang-01',
  color TEXT NOT NULL DEFAULT '#00d4ff',
  description TEXT,
  geom JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_plot_zones_tenant ON plot_zones (tenant_id, farm_id) WHERE deleted_at IS NULL;

ALTER TABLE plot_records ADD COLUMN IF NOT EXISTS zone_code TEXT;
CREATE INDEX IF NOT EXISTS idx_plot_records_zone ON plot_records (tenant_id, zone_code) WHERE deleted_at IS NULL;

-- 示范区两个有边界的片区与一个待划地块的空白片区
INSERT INTO plot_zones (id, zone_code, zone_name, tenant_id, farm_id, color, description, geom) VALUES
  ('zone-demo-1', 'ZONE-01', '智耘蜀芯东区示范片', 'tenant-demo', 'farm-kaijiang-01', '#00d4ff',
   '厂房东侧高标准农田，含水肥一体化示范地块',
   '{"type":"Polygon","coordinates":[[[107.4215,30.9806],[107.4292,30.9806],[107.4292,30.9858],[107.4215,30.9858],[107.4215,30.9806]]],"srid":4490}'),
  ('zone-demo-2', 'ZONE-02', '智耘蜀芯西区示范片', 'tenant-demo', 'farm-kaijiang-01', '#f3c969',
   '厂房西侧坡耕地，以旱作与苗情监测为主',
   '{"type":"Polygon","coordinates":[[[107.4132,30.9802],[107.4206,30.9802],[107.4206,30.9852],[107.4132,30.9852],[107.4132,30.9802]]],"srid":4490}'),
  ('zone-demo-3', 'ZONE-03', '达川丘区联片', 'tenant-demo', 'farm-kaijiang-01', '#69f0ae',
   '待划入地块的预留片区，用于跨村联片作业', NULL)
ON CONFLICT (zone_code) DO NOTHING;

-- 田间导航需要一条机耕道作为路网；没有测绘数据时先给一条示范路线
INSERT INTO infra_lines (id, line_code, line_name, line_type, tenant_id, geom, length_m) VALUES
  ('infra-line-demo-4', 'LINE-ROAD-001', '示范区机耕道', 'ROAD', 'tenant-demo',
   '{"type":"LineString","coordinates":[[107.4140,30.9796],[107.4205,30.9804],[107.4270,30.9812],[107.4330,30.9824]],"srid":4490}', 1830)
ON CONFLICT (line_code) DO NOTHING;
