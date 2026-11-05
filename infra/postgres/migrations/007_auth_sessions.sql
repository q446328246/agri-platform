-- 007：登录会话持久化
--
-- 为什么不存 JWT：本平台会话需要「立即失效」（停用账号、改密、删号都要回收），
-- 无状态 token 做不到即时吊销，因此保留服务端会话，只把存储从进程内存换成表。
--
-- token_hash：token 的 sha256 散列。token 本身是 32 字节随机数，熵足够，
-- 不落明文即可防「库被读走后直接冒用」；过期判断用 expires_at，索引支持批量清理。
-- user_id 外键级联删除，删号时会话一并消失，避免残留可用 token。

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at);
