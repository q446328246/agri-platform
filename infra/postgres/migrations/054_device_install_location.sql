-- 054 设备安装坐标（A14 地块内网格长势分布热力层的空间样本基础）
--
-- 开发方案 6.2：「按地块生成长势分布图，直观显示同一地块内不同区域的差异」。
-- IDW 插值需要「带坐标的读数样本」，而遥测读数只关联设备不存坐标——
-- 这里给设备台账补安装坐标（可空：未登记坐标的设备不参与插值，不拿地块中心冒充），
-- 演示设备按绑定地块外环重心落点（与 coverage.ts planeOf 同一口径），
-- 同地块多台设备沿东西向错开 0.00004°（约 4 米），避免样本完全重合导致 IDW 权重退化。
-- 坐标为 CGCS2000/WGS84 度，与地块 geom 同系；多光谱影像反演输入属 B 类，
-- 长势网格端点已留 samples 覆盖口，届时由算法节点直接给样本不必依赖本列。

ALTER TABLE devices ADD COLUMN IF NOT EXISTS install_lng DOUBLE PRECISION;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS install_lat DOUBLE PRECISION;

-- 演示种子：按绑定地块外环顶点均值定重心（geom 为 GeoJSON JSONB，coordinates[0] 是外环）
UPDATE devices d
SET install_lng = sub.lng + sub.off,
    install_lat = sub.lat,
    updated_at = now()
FROM (
  SELECT d2.id,
         AVG((pt->>0)::double precision) AS lng,
         AVG((pt->>1)::double precision) AS lat,
         (ROW_NUMBER() OVER (PARTITION BY d2.plot_code ORDER BY d2.id) - 1) * 0.00004 AS off
  FROM devices d2
  JOIN plot_records p ON p.parcel_code = d2.plot_code AND p.deleted_at IS NULL
  CROSS JOIN LATERAL jsonb_array_elements(p.geom->'coordinates'->0) AS pt
  WHERE d2.plot_code <> ''
    AND d2.type IN ('SOIL_SENSOR', 'INTEGRATED_STATION', 'REMOTE_SENSE', 'WEATHER_STATION')
  GROUP BY d2.id, d2.plot_code
) sub
WHERE d.id = sub.id
  AND d.install_lng IS NULL;