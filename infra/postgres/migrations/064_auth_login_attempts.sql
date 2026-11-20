-- 064：认证登录尝试台账（F2 等保登录失败处置）
--
-- 动机：等保基线要求对登录失败进行处置——连续失败达到阈值锁定账号，
-- 并留存登录行为供审计。原登录仅单次 401 比对，无尝试记录、无锁定。
--
-- 约定：
-- 1. 按（租户, 用户名）一条台账：累计连续失败次数与锁定截止时间，
--    登录成功即清零；阈值与锁定时长由环境变量配置（默认 5 次 / 15 分钟），不写死；
-- 2. locked_until 为空表示未锁定，非空表示锁定至该时刻；
-- 3. last_ip 记录最近尝试来源，供审计与运维排查；
-- 4. 全部可重复执行（IF NOT EXISTS），时间列统一 TIMESTAMPTZ。

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  username        TEXT NOT NULL,
  last_ip         TEXT NOT NULL DEFAULT '',
  fail_count      INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  locked_until    TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);

-- 锁定中的台账单独索引，便于运维按锁定窗口巡检
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_locked
  ON auth_login_attempts (locked_until) WHERE locked_until IS NOT NULL;
