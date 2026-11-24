-- 075：拖拉机作业轨迹唯一约束
--
-- 约定：一次作业只能有一条轨迹。约束按 IF NOT EXISTS 思路可重复执行；
-- 历史库若已存在同一 job_id 的多条轨迹，不删除、不合并、不选主，保留既有数据并跳过加约束，
-- 输出 NOTICE 供运维先核查。空库或无重复的库直接建立 UNIQUE(job_id)。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tractor_trajectories
    GROUP BY job_id
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'tractor_trajectories 存在重复 job_id，075 保留历史数据并跳过 UNIQUE 约束，请先核查重复轨迹';
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'tractor_trajectories'::regclass
      AND conname = 'uq_tractor_trajectories_job_id'
  ) THEN
    BEGIN
      ALTER TABLE tractor_trajectories
        ADD CONSTRAINT uq_tractor_trajectories_job_id UNIQUE (job_id);
    EXCEPTION WHEN unique_violation THEN
      -- 并发写入恰好引入重复时同样不破坏数据，留给下一次迁移/人工核查。
      RAISE NOTICE 'tractor_trajectories 加唯一约束时发现重复 job_id，075 未删除任何历史数据';
    END;
  END IF;
END $$;
