-- 061 农艺知识库（C4）：结构化沉淀农艺口径与处置知识，供智能问答检索引用。
--
-- 知识条目按租户隔离；D 类确认的农艺口径（灌溉定额、料液密度、越限补灌定额、
-- 多明细面积分摊）随确认结果沉淀为 CRITERIA 类条目，问答回答可追溯到条目与依据。
-- 种子只给默认租户 tenant-demo，与演示数据同口径；空表时代码侧回填默认知识。

CREATE TABLE IF NOT EXISTS agronomy_knowledge (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('CROP', 'INDICATOR', 'DISPOSAL', 'CRITERIA')),
  title TEXT NOT NULL,
  /** 检索关键词，逗号分隔；问答按关键词命中 */
  keywords TEXT NOT NULL,
  content TEXT NOT NULL,
  /** 依据来源，如「D1 农艺口径确认（2026-11-20）」 */
  source TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agronomy_knowledge_tenant ON agronomy_knowledge (tenant_id, enabled);

-- 种子：D 类确认口径 + 基础农艺知识
INSERT INTO agronomy_knowledge (id, tenant_id, category, title, keywords, content, source, sort, created_at, updated_at) VALUES
('kb-irrigation-quota', 'tenant-demo', 'CRITERIA', '灌溉定额', '灌溉,定额,灌水,水量,补水', '大田旱作作物单次灌溉参考范围 10–40 毫米：一般 10–30 毫米/次，干旱补灌可至 40–50 毫米；水肥一体随水施肥时，灌水定额与施肥定额同源。按作物与生育期分别确认后固化。', 'D1 农艺口径确认（2026-11-20）', 1, now(), now()),
('kb-fertilizer-density', 'tenant-demo', 'CRITERIA', '料液密度', '料液,密度,施肥,千克,升', '水溶肥类料液密度常见 1.0–1.3 kg/L（略高于水），以产品标签/现场配方为准；平台侧配置默认 1.0 kg/L，设备直接报千克时不使用该值。', 'D1 农艺口径确认（2026-11-20）', 2, now(), now()),
('kb-supplement-irrigation', 'tenant-demo', 'CRITERIA', '越限补灌定额', '补灌,越限,含水率,处置', '土壤含水率低于阈值触发补灌，采用固定补灌定额口径一：参考范围 10–20 毫米/次（按土壤质地与作物需水确认），平台缺省 15 毫米；按含水率缺口估算的口径二作为二期。', 'D3 农艺口径确认（2026-11-20）', 3, now(), now()),
('kb-area-allocation', 'tenant-demo', 'CRITERIA', '多明细分区面积分摊', '分摊,面积,分区,网格,明细', '一个指令对应多地块/分区时采用规则 A：明细 gridCode → 网格台账面积，多明细逐明细建分区，各分区面积取各自网格台账面积，平台不另设分摊算法。', 'D2 农艺口径确认（2026-11-20）', 4, now(), now()),
('kb-soil-moisture-threshold', 'tenant-demo', 'INDICATOR', '土壤含水率阈值', '含水率,墒情,土壤,水分', '土壤含水率低于 30% 触发补灌规则（全局默认阈值，地块可单独配置分级规则）；高于上限时自动停灌未领取的灌溉指令。', '阈值规则默认口径（迁移 008）', 5, now(), now()),
('kb-rain-probability', 'tenant-demo', 'INDICATOR', '降雨概率口径', '降雨,天气,概率,雨', '降雨概率高于 60% 时不生成补灌处方，避免浇后降雨造成深层渗漏或渍害；降雨概率取自气象服务预报。', '处方生成规则默认口径', 6, now(), now()),
('kb-canopy-coverage', 'tenant-demo', 'INDICATOR', '苗情覆盖度阈值', '苗情,覆盖度,长势,冠层', '冠层覆盖度低于 60% 触发苗情预警，提示关注长势与水肥供给；覆盖度读数来自田间设备上报。', '阈值规则默认口径（迁移 008）', 7, now(), now()),
('kb-pest-control', 'tenant-demo', 'DISPOSAL', '虫情防治处置', '虫情,虫害,防治,农药,植保', '虫口密度达到防治指标（5 头/百株）时触发虫情告警，处置走植保作业：生成植保处方并派单，药剂用量按处方与地块面积执行。', '虫情规则默认口径（迁移 008）', 8, now(), now())
ON CONFLICT (id) DO NOTHING;
