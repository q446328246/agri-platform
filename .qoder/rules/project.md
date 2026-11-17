---
trigger: always_on
---

# 项目总约束（全局共识）

无人农场 AI 平台：pnpm workspace + Turbo 编排的 Node.js monorepo。本文件只保留全局共识；专项规范见 `.qoder/rules/` 下按路径加载的主题规则（backend-service / database / frontend-web / testing）。

## 技术栈与目录约定

- Node.js >= 24（根 `package.json` engines 硬性要求），全仓 ESM（`"type": "module"`）。
- `packages/*`：`@agri/*` 共享包（shared / config / contracts / db / mq / observability / plot-core / testing / tsconfig / eslint-config），全部 `private: true`，不对外发布。
- `apps/*-service`：NestJS 风格微服务，HTTP 入口统一在各服务 `src/http.ts`，组合根在 `src/main.ts`。
- `apps/web`：Vue3 + Vite + Element Plus + Pinia 前端（workspace 成员）。
- `zhao-guang-farm-master/`：历史遗留独立前端（自带 yarn.lock，不参与 pnpm workspace），除非明确要求，不修改、不引用其代码。
- `infra/postgres/migrations/`：编号递增 SQL 迁移；`scripts/`：纯 ESM Node.js 运维与冒烟脚本。

## 依赖约束

- 内部包引用一律 `workspace:*`，禁止硬编码版本号。
- 共享包入口由 `package.json` 的 `exports` 声明（`./dist/index.js` + `./dist/index.d.ts`），禁止深层路径导入。
- 新增带原生构建脚本的依赖须加入 `pnpm-workspace.yaml` 的 `allowBuilds` 白名单。
- 新增包参与增量构建须遵循 Turbo 契约：产出 `dist/**` 与 `*.tsbuildinfo`。

## 常用命令（提交前校验顺序）

1. `npx tsc -b` — 类型检查与增量编译
2. `pnpm exec vitest run` — 单元测试
3. `pnpm run build` — 全量后端构建（即 `tsc -b`，按根 tsconfig references 编译 packages 与全部微服务，**不含前端**）
4. 涉及前端改动时追加 `pnpm --filter @agri/web build`（内部执行 `vue-tsc -b && vite build`）

其他：
- 数据库迁移：设置 `DB_URL` 后 `node scripts/migrate-postgres.mjs`（查状态加 `--status`，等价 `pnpm db:migrate -- --status`）
- 冒烟：根 package.json 提供 `pnpm smoke:<name>` 别名；自拉起型与外部网关型脚本的前置条件不同，详见 testing 规则

## 环境与运行时约束

- Windows PowerShell：语句分隔用 `;`，禁用 `&&`。
- 环境变量不会自动加载 `.env`，须在会话显式设置（如 `$env:DB_URL = "..."`）。
- 前端构建前 `TEMP`/`TMP` 必须指向工作区 `.tmp` 目录（不存在则先 `New-Item -ItemType Directory -Force .tmp`），否则 esbuild 临时目录权限拒绝。
- 未设置 `DB_URL` 时服务降级内存模式（重启数据清空）；各服务用 `<XXX>_REPOSITORY_MODE` 切换仓储实现（plot-service 例外：须显式 `=sql`，见 backend-service 规则）。

## 安全底线

- 凭据（数据库口令、API Key、JWT 私钥）只存于本地 `.env` / infra 配置，禁止写入代码、文档、注释、测试断言或提交信息。
- 根目录 `ed25519-*.pem`、`.env` 不入库；`.env.example` 只放占位符。
- 内部接口（`/api/v1/internal/*`）仅靠 `x-internal-token`（环境变量 `INTERNAL_TOKEN`）保护，不得暴露到网关公开路由。

## 变更纪律

- 数据库结构/数据变更只能追加新迁移文件，禁止修改已应用的迁移（详见 database 规则）。
- 修改业务逻辑后必须运行 `pnpm exec vitest run`；涉及跨服务链路时补跑对应冒烟脚本。
- 开发进度以 `IMPLEMENTATION_PROGRESS.md` 等根目录文档为准，完成功能后同步更新。