---
trigger: glob
glob: infra/postgres/**/*.sql
---

# 数据库迁移与 Schema 规范

适用于 `infra/postgres/migrations/` 下的 SQL 文件（当前编号已至 039，新增从下一编号继续）。

## 迁移文件纪律

- 命名 `NNN_描述.sql`，编号三位递增，按序执行；每个文件只执行一次（已应用记录写入 `schema_migrations`）。
- 结构或数据变更一律追加新文件，禁止修改已应用的迁移。
- 若确需向已应用文件追加段落：必须把同段 SQL 单独提取，对既有库手工补跑（`docker cp` 进 postgres 容器后 `psql -v ON_ERROR_STOP=1 -f`），并在文档中说明该差异。
- 应用命令：设置 `DB_URL` 后 `node scripts/migrate-postgres.mjs`；查状态加 `--status`；Docker 部署时 app 容器启动自动执行迁移。

## Schema 约定

- 主键统一 `TEXT`（UUID 或业务编码字符串，如 parcel_code 形态的 `511723-…`）。
- 时间字段统一 `TIMESTAMPTZ`，配合 `created_at` / `updated_at` / `deleted_at` 软删除语义。
- 复杂配置字段（规则表达式、条件、动作、输入输出等）统一 `JSONB` 列。
- 查询热点表建组合索引，常见模式 `(tenant_id|plot_code|device_id, created_at DESC)` 或 `recorded_at DESC` 时间倒序。
- 枚举值扩展须同步处理数据库 CHECK 约束（先删旧约束再加新约束），不能只改代码枚举。

## 演示/种子数据

- 演示数据主键统一含 `demo` 标识，形态为 `<实体>-demo-*`（如 `plot-demo-01` / `cmd-demo-001` / `rd-demo-<md5>`），插入全程 `ON CONFLICT DO NOTHING`，保证可重复执行。
- 新增种子前必须先读对应服务的 test 文件：名称、数量、关键字不得与既有断言的过滤条件冲突（如 operation-service 断言 keyword=示范田 + status=PENDING 恰好 1 条，新任务名称须避开「示范田」）。