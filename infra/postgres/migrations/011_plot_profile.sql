-- 011：地块档案字段（类型 / 状态 / 当前作物 / 负责人）
--
-- 动机：前端地块列表有「地块类型」「地块状态」下拉筛选，表格有「当前作物」「负责人」列，
-- 编辑页也能填这些字段，但 plot_records 从来没有这些列，导致筛选是假筛选、列恒为空、
-- 编辑提交即丢失。这里补列并回填 010 的十二块示范地块，让筛选与展示真实可用。
--
-- 约定：
-- 1. 全部建为可空列（CHECK 对 NULL 恒通过）。历史数据与只填必填项的建档请求都不会被拦，
--    新建档由服务层给默认值（大田 / 种植中），避免出现一堆空类型地块；
-- 2. 取值集合与前端 apps/web/src/types/index.ts 的 PlotType、PlotStatus 枚举严格一致，
--    服务层入参另有白名单校验，非法值返回 400 而不是撞数据库约束报 500；
-- 3. 回填条件带 AND plot_status IS NULL，重复执行不报错，也不会覆盖用户在页面上改过的值。

ALTER TABLE plot_records ADD COLUMN IF NOT EXISTS plot_type TEXT CHECK (plot_type IN ('FIELD', 'GREENHOUSE', 'ORCHARD', 'AQUACULTURE'));
ALTER TABLE plot_records ADD COLUMN IF NOT EXISTS plot_status TEXT CHECK (plot_status IN ('DRAFT', 'ACTIVE', 'FALLOW', 'ARCHIVED'));
ALTER TABLE plot_records ADD COLUMN IF NOT EXISTS current_crop TEXT;
ALTER TABLE plot_records ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE plot_records ADD COLUMN IF NOT EXISTS owner_phone TEXT;
ALTER TABLE plot_records ADD COLUMN IF NOT EXISTS remark TEXT;

-- 列表页默认按「状态 + 类型」过滤，面积区间筛选走服务层内存过滤（示范数据量级无需表达式索引）
CREATE INDEX IF NOT EXISTS idx_plot_records_profile ON plot_records (tenant_id, plot_status, plot_type) WHERE deleted_at IS NULL;

-- ---------- 示范地块档案：四种类型、四种状态都要有样本，筛选下拉才可选出结果 ----------
UPDATE plot_records AS p
   SET plot_type    = v.plot_type,
       plot_status  = v.plot_status,
       current_crop = v.current_crop,
       owner_name   = v.owner_name,
       owner_phone  = v.owner_phone,
       remark       = v.remark
  FROM (VALUES
    ('plot-demo-01', 'FIELD',      'ACTIVE',   '水稻',     '张建国', '13908187201', '东区高标准农田，水肥一体化主管网覆盖'),
    ('plot-demo-02', 'FIELD',      'ACTIVE',   '油菜',     '李秀兰', '13908187202', '与东区一号田轮作，秋种油菜'),
    ('plot-demo-03', 'GREENHOUSE', 'ACTIVE',   '黄瓜',     '王晓东', '13908187203', '连栋温室两栋，承担设施蔬菜育苗示范'),
    ('plot-demo-04', 'FIELD',      'FALLOW',   '玉米',     '陈利军', '13908187204', '上一季种植玉米，当前休耕养地'),
    ('plot-demo-05', 'FIELD',      'ACTIVE',   '玉米',     '陈利军', '13908187204', '西区旱作示范，坡耕地改造后第一年'),
    ('plot-demo-06', 'ORCHARD',    'ACTIVE',   '柑橘',     '罗朝山', '13908187206', '晚熟柑橘四十年生树，兼做无人机植保对照'),
    ('plot-demo-07', 'FIELD',      'ACTIVE',   '大豆',     '汤秀明', '13908187207', '大豆玉米带状复合种植示范地块'),
    ('plot-demo-08', 'FIELD',      'ACTIVE',   '水稻',     '周德丰', '13908187208', '跨村联片作业区，农机调度演练主场地'),
    ('plot-demo-09', 'AQUACULTURE','ACTIVE',   '小龙虾',   '徐桂林', '13908187209', '稻虾共作田，水位与溶氧监测点位在案'),
    ('plot-demo-10', 'FIELD',      'ARCHIVED', '油菜',     '邓志强', '13908187210', '地块并入联片一号田统一管理，档案留存'),
    ('plot-demo-11', 'FIELD',      'DRAFT',    NULL,       '董建国', '13908187211', '丘陵整治项目验收中，尚未确定种植方案'),
    ('plot-demo-12', 'FIELD',      'ACTIVE',   '水稻',     '何小平', '13908187212', '农机手培训与作业质量监测用地')
  ) AS v(parcel_id, plot_type, plot_status, current_crop, owner_name, owner_phone, remark)
 WHERE p.parcel_id = v.parcel_id AND p.plot_status IS NULL;
