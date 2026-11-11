-- 026 种植季/茬口档案（开发方案：种植管理——轮作倒茬留痕）
--
-- 记录"某地块某季种了什么"，用来还原一块地多年来的茬口序列，为倒茬与连作障碍判断提供依据。
-- 与"苗情生育期"（同一季作物内部的时间轴）不同：这里以"季/茬"为单位，跨年份排一条地块的种植历史。
--
-- plot_code 引用 plots.parcel_code，纯文本、不建外键（地块可能先建档后补边界，或已软删仍需留痕）。
-- 作物、品种、栽期、采收期、产量均为农户据实手填的档案值，系统不做估算：
--   plant_date / harvest_date 用 TEXT 存 YYYY-MM-DD（空串=未定），避免时戳映射歧义；
--   season_year + season_index 决定轮作正序（同一年多季按茬次排）。
-- 这是决策支持（提示连作/空闲），不替农户决定种什么，也不伪造农事回执。
CREATE TABLE IF NOT EXISTS crop_seasons (
  id            TEXT PRIMARY KEY,
  season_code   TEXT NOT NULL UNIQUE,
  plot_code     TEXT NOT NULL,
  crop          TEXT NOT NULL,
  variety       TEXT NOT NULL DEFAULT '',
  season_year   INT  NOT NULL,
  season_index  INT  NOT NULL DEFAULT 1 CHECK (season_index >= 1),
  plant_date    TEXT NOT NULL DEFAULT '',
  harvest_date  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'growing', 'harvested')),
  yield_kg      NUMERIC,
  note          TEXT NOT NULL DEFAULT '',
  tenant_id     TEXT NOT NULL DEFAULT 'tenant-demo',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- 按地块查轮作序列（软删行不进入）
CREATE INDEX IF NOT EXISTS idx_crop_seasons_plot ON crop_seasons (plot_code) WHERE deleted_at IS NULL;
-- 按租户 + 年份检索最近茬口
CREATE INDEX IF NOT EXISTS idx_crop_seasons_tenant ON crop_seasons (tenant_id, season_year DESC, season_index DESC) WHERE deleted_at IS NULL;
