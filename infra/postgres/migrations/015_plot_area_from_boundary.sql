-- 015：地块面积一律按边界几何重算
--
-- 动机：010 的示范地块面积是手填的整数，边界是随手画的，两者差了一半以上
-- （东区一号田申报 26.50 亩、边界实际 80.86 亩）。于是一旦在一张图上拖动一个顶点，
-- 面积会被前端按边界重算并静默写回，客户看到的数字凭空翻倍的量级不可解释；
-- 片区合计与看板统计都按 area_mu 求和，也跟着失真。这里把已有行的面积统一成边界算出来的值，
-- 让「面积 = 边界」成为唯一口径。
--
-- 约定：
-- 1. 公式与 apps/web/src/utils/geo.ts 的 ringAreaMu、packages/shared/src/area.ts 逐位一致：
--    环重心平移到原点后做等距圆柱近似（kx=111320·cos(重心纬度)、ky=110540）的鞋带公式，
--    平方米除以 666.6667 换算亩，保留 2 位小数。改任一处算法时三处要一起改，
--    否则再次重算又会出现两套数（TS 两份由 apps/web/test/geo.spec.ts 的一致性用例钉住）；
-- 2. 只处理 Polygon：一张图建档与编辑（MapShapeEditor.toPolygonGeom）产出的就是单环 Polygon，
--    MultiPolygon 目前没有写入方，宁可跳过也不要用一套没验证过的分支去覆盖面积；
-- 3. 顶点去重和「丢掉与首点重合的闭合点」必须照搬前端 dedupe：闭合重复点虽然对鞋带本身贡献 0，
--    但会把重心纬度拉偏，kx 一变面积就差出去零点几亩；
-- 4. 多环取面积最大的那个环（同前端 primaryRing），内环、洞不会把面积算小；
-- 5. 带 area_mu IS DISTINCT FROM 条件，已经是正确值的行不重写，重复执行与已人工修正过的库都安全；
--    同时不改 updated_at，避免一次数据口径修正把地块的「最近更新」时间全部冲掉。

UPDATE plot_records AS p
   SET area_mu = chosen.area_mu
  FROM (
    WITH ring_points AS (
      -- 展开外环顶点：GeoJSON 顺序是 [经度, 纬度]
      SELECT p0.parcel_code,
             pt.ord AS ord,
             (pt.elem ->> 0)::float8 AS lng,
             (pt.elem ->> 1)::float8 AS lat
        FROM plot_records p0
       CROSS JOIN LATERAL jsonb_array_elements(p0.geom -> 'coordinates' -> 0)
             WITH ORDINALITY AS pt(elem, ord)
       WHERE p0.geom IS NOT NULL
         AND p0.geom ->> 'type' = 'Polygon'
         AND jsonb_typeof(p0.geom -> 'coordinates' -> 0) = 'array'
    ),
    dedup AS (
      -- 连续重合顶点只留一个，并重新编号
      SELECT parcel_code,
             row_number() OVER (PARTITION BY parcel_code ORDER BY ord) AS n,
             lng,
             lat
        FROM (
              SELECT parcel_code, ord, lng, lat,
                     LAG(lng) OVER (PARTITION BY parcel_code ORDER BY ord) AS prev_lng,
                     LAG(lat) OVER (PARTITION BY parcel_code ORDER BY ord) AS prev_lat
                FROM ring_points
             ) stepped
       WHERE prev_lng IS NULL OR prev_lng <> lng OR prev_lat <> lat
    ),
    trimmed AS (
      -- 闭合点与首点重合时去掉：前端 dedupe 同样会 pop 掉它
      SELECT n, lng, lat, parcel_code
        FROM (
              SELECT parcel_code, n, lng, lat,
                     first_value(lng) OVER w AS head_lng,
                     first_value(lat) OVER w AS head_lat,
                     last_value(lng) OVER w AS tail_lng,
                     last_value(lat) OVER w AS tail_lat,
                     count(*) OVER w AS total
                FROM dedup
               WINDOW w AS (PARTITION BY parcel_code ORDER BY n
                            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
             ) framed
       WHERE total < 2
          OR NOT (n = total AND head_lng = tail_lng AND head_lat = tail_lat)
    ),
    centroid AS (
      SELECT parcel_code, avg(lat) AS lat0, avg(lng) AS lng0
        FROM trimmed
       GROUP BY parcel_code
      HAVING count(*) >= 3
    ),
    edges AS (
      -- 鞋带公式的单项：x1·y2 - x2·y1，末点回连首点
      SELECT t.parcel_code,
             (t.lng - c.lng0) * 111320 * cos(radians(c.lat0)) *
             (COALESCE(lead(t.lat) OVER w, first_value(t.lat) OVER w) - c.lat0) * 110540
           - (COALESCE(lead(t.lng) OVER w, first_value(t.lng) OVER w) - c.lng0) * 111320 *
             cos(radians(c.lat0)) * (t.lat - c.lat0) * 110540 AS term
        FROM trimmed t
        JOIN centroid c ON c.parcel_code = t.parcel_code
       WINDOW w AS (PARTITION BY t.parcel_code ORDER BY t.n
                    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
    ),
    ring_area AS (
      SELECT parcel_code,
             round((abs(sum(term) / 2) / 666.6667)::numeric, 2) AS area_mu
        FROM edges
       GROUP BY parcel_code
    ),
    chosen_area AS (
      -- 多环地块取面积最大的环，退化环不会盖掉真实面积
      SELECT DISTINCT ON (parcel_code) parcel_code, area_mu
        FROM ring_area
       ORDER BY parcel_code, area_mu DESC
    )
    SELECT parcel_code, area_mu FROM chosen_area
  ) AS chosen
 WHERE chosen.parcel_code = p.parcel_code
   AND p.area_mu IS DISTINCT FROM chosen.area_mu;
