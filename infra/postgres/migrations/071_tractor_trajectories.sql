-- 071：拖拉机作业轨迹
--
-- 起因：拖拉机自动作业要按轨迹运行——作业下发时要么直接传入轨迹点，要么由地块
-- 边界自动算出覆盖式作业轨迹，经 MQTT 下发给拖拉机、由 RTK 跟随。原作业只有
-- 面积与时长包络，没有轨迹这一层，支撑不了自动跟随。
--
-- 约定：
-- 1. 一次作业一条轨迹（job_id 关联，随作业级联删除）。轨迹与作业分表，不塞进
--    分步参数：轨迹是可独立查看、复算、监测的实体，分步参数只带下发用的路径点；
-- 2. 来源区分：AUTO 由地块边界 + 农具幅宽自动算（覆盖式牛耕），MANUAL 为调用方
--    直接传入的轨迹点；
-- 3. path 是连续路径折点（[经度, 纬度]），拖拉机按此跟随；lanes 为作业带（仅
--    AUTO），供展示与复核覆盖是否铺满；
-- 4. 时间列统一 TIMESTAMPTZ，建表与索引可重复执行。

CREATE TABLE IF NOT EXISTS tractor_trajectories (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES tractor_jobs (id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL,
  plot_code         TEXT NOT NULL DEFAULT '',
  /** 轨迹来源：AUTO 由地块边界自动算 / MANUAL 直接传入轨迹点 */
  source            TEXT NOT NULL CHECK (source IN ('AUTO', 'MANUAL')),
  /** 连续路径折点，[经度, 纬度] 序列 */
  path              JSONB NOT NULL,
  /** 作业带（仅 AUTO），每条带两端与里程 */
  lanes             JSONB,
  /** 作业方向（自正北顺时针，仅 AUTO） */
  heading_deg       NUMERIC(5, 1),
  /** 农具幅宽（米，仅 AUTO） */
  implement_width_m NUMERIC(6, 2),
  /** 轨迹总里程（米） */
  total_distance_m  NUMERIC(12, 1) NOT NULL DEFAULT 0,
  /** 按轨迹估算的作业时长（分钟） */
  duration_min      NUMERIC(8, 1) NOT NULL DEFAULT 0,
  warnings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tractor_trajectories_job ON tractor_trajectories (job_id);
CREATE INDEX IF NOT EXISTS idx_tractor_trajectories_tenant ON tractor_trajectories (tenant_id, created_at DESC);
