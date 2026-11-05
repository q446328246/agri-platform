-- 004：系统账号与角色权限持久化
-- auth_users：登录账号，password_hash 为开发期 sha256 散列（生产应替换为 bcrypt/argon2）。
-- direct_permissions：直接授予用户的权限，角色权限由 platform_role_permissions 维护，二者语义不同。
-- auth_user_roles：用户与角色编码的关联，角色删除后由权限分配接口负责清理。
-- platform_roles / platform_role_permissions：平台角色及其权限码，权限目录本体仍在代码中维护。
-- platform_audit_logs：系统管理审计日志，角色增删改都会写入。

CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  direct_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
CREATE INDEX IF NOT EXISTS idx_auth_users_tenant_created ON auth_users (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_user_roles (
  user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  role_code TEXT NOT NULL,
  PRIMARY KEY (user_id, role_code)
);
CREATE INDEX IF NOT EXISTS idx_auth_user_roles_code ON auth_user_roles (role_code);

CREATE TABLE IF NOT EXISTS platform_roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_platform_roles_tenant_created ON platform_roles (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_role_permissions (
  role_id TEXT NOT NULL REFERENCES platform_roles (id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operator TEXT NOT NULL,
  resource TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant_created ON platform_audit_logs (tenant_id, created_at DESC);
