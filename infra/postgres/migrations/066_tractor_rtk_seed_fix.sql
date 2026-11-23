-- 066：B2 演示 RTK 种子地块编码修正（补丁）
--
-- 起因：065 的演示种子误用了不存在的地块编码 03-00010-0000-U——
-- 经纬度读数的 SELECT 落空未插入，已插入的 HDOP/FIX 两条读数 plot_code 也写错；
-- 演示拖拉机实际绑定地块为 02-00010-0000-Z（ACTIVE，边界完整）。
-- 本迁移修正既有读数的 plot_code，并按正确地块边界首顶点补插经纬度读数。
-- 全新库以修正后的 065 为准，本迁移仅服务已应用旧版 065 的数据库。

UPDATE telemetry_readings
   SET plot_code = '511723-000001-02-00010-0000-Z'
 WHERE device_id = 'device-tractor-001' AND plot_code = '511723-000001-03-00010-0000-U';

INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'b2-rtk-007', 'device-tractor-001', '511723-000001-02-00010-0000-Z', 'rtkLongitude',
       (geom->'coordinates'->0->0->0)::numeric, 'deg', now() - INTERVAL '2 minutes'
  FROM plot_records WHERE parcel_code = '511723-000001-02-00010-0000-Z';

INSERT INTO telemetry_readings (id, device_id, plot_code, metric, value, unit, recorded_at)
SELECT 'b2-rtk-008', 'device-tractor-001', '511723-000001-02-00010-0000-Z', 'rtkLatitude',
       (geom->'coordinates'->0->0->1)::numeric, 'deg', now() - INTERVAL '2 minutes'
  FROM plot_records WHERE parcel_code = '511723-000001-02-00010-0000-Z';
