---
kind: build_system
name: pnpm + Turbo Monorepo 构建与本地开发编排
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - turbo.json
    - tsconfig.json
    - vitest.config.ts
    - infra/docker-compose.yml
    - scripts/start-services.mjs
    - apps/plot-service/nest-cli.json
    - apps/web/vite.config.ts
---

## 1. 使用的系统与工具

仓库采用 **pnpm workspace** 作为包管理根，配合 **Turbo** 做任务编排、**TypeScript project references (`tsc -b`)** 做增量编译、**Vitest** 做跨包测试，前端（apps/web）使用 **Vite** 单独构建。基础设施通过 **Docker Compose** 在本地启动 PostgreSQL(PostGIS) 与 MinIO。

没有发现 CI 流水线文件（`.github/workflows`、Jenkinsfile、Makefile、Dockerfile），因此本仓库的“构建系统”主要覆盖本地开发与冒烟验证阶段。

## 2. 关键文件

- `package.json`：顶层脚本入口（`build`、`typecheck`、`test`、`start:services`、`smoke:*`、`db:migrate` 等）。
- `pnpm-workspace.yaml`：声明 `packages/*` 与 `apps/*` 两个 workspace 目录，并通过 `allowBuilds` 白名单放行 esbuild/vue-demi/element-plus 等依赖的原生构建脚本。
- `turbo.json`：定义 `build` 与 `typecheck` 两个任务，`dependsOn: ["^build"]` 保证依赖先于消费者构建，输出产物为 `dist/**` 与 `*.tsbuildinfo`。
- `tsconfig.json`：以 `files: []` + `references` 形式显式列出所有 package 与 app 路径，是 `tsc -b` 的单一入口。
- `vitest.config.ts`：将 `@agri/*` 别名直接解析到源码目录，跳过构建顺序；开启 `experimentalDecorators` 以支持 NestJS 装饰器。
- `infra/docker-compose.yml`：编排 `postgis/postgis:16-3.5` 与 `pgsty/minio`，挂载 `./postgres` 初始化脚本并配置 healthcheck。
- `scripts/start-services.mjs`：基于 `service-registry.mjs` 启动所有微服务子进程，注入 `SERVICE_MODE=http`、`PORT` 以及各服务的 `*_SERVICE_URL` 环境变量。
- `apps/*/nest-cli.json`：每个 NestJS 应用统一配置 `sourceRoot: src`、`outDir: ./dist`、`tsConfigPath: ./tsconfig.json`。
- `apps/web/vite.config.ts`：Vue3 前端构建配置，含 `/api` 代理到 `localhost:8080`。

## 3. 架构与约定

### 3.1 分层结构

```
packages/*   → @agri/* 公共 TypeScript 库（shared/config/contracts/db/mq/observability/plot-core/testing/tsconfig/eslint-config）
apps/*       → NestJS 微服务 + apps/web (Vue3)
infra/*      → Docker Compose + Postgres 迁移 SQL
scripts/*    → Node ESM 辅助脚本（启动/健康检查/清理/冒烟/DB 迁移）
.runtime/*   → 运行时补丁脚本（patch-*.*）与冒烟产物
```

### 3.2 构建流程

1. **类型检查**：`pnpm typecheck` → `tsc -b --dry`，失败回退到 `tsc -b`，利用 project references 按引用拓扑增量编译。
2. **全量构建**：`pnpm build` → `tsc -b`，产物写入各包的 `dist/` 与 `*.tsbuildinfo`。
3. **增量构建**：`pnpm build:changed` → `turbo run build`，仅重构建受变更影响的包及下游消费者。
4. **测试**：`pnpm test` → Vitest 扫描 `packages/**/test/**/*.spec.ts` 与 `apps/**/test/**/*.spec.ts`，通过别名直连源码，不要求先构建。
5. **前端**：`apps/web` 独立 Vite 构建，开发时通过 proxy 转发 `/api*` 到后端 `localhost:8080`。

### 3.3 依赖图与版本策略

- 所有包共享同一份 `pnpm-lock.yaml`，Node 引擎锁定 `>=24.0.0`。
- 顶层 `package.json` 中 `version: "1.0.0"` 且 `private: true`，未发布到 npm registry；各子包各自维护自己的 `package.json`。
- 包间依赖通过 pnpm workspace 解析，无硬编码版本号跳转。

### 3.4 本地运行与冒烟

- `pnpm start:services`：先 `pnpm run build`，再执行 `scripts/start-services.mjs`，按 `service-registry.mjs` 注册的端口表并行启动所有微服务。
- `pnpm smoke:gateway` / `pnpm smoke:services`：构建后运行对应冒烟脚本，验证 gateway-service 与各业务服务 HTTP 接口。
- `pnpm health:services`：调用 `scripts/health-check.mjs` 轮询各服务健康端点。
- `pnpm db:migrate`：执行 `scripts/migrate-postgres.mjs` 跑 `infra/postgres/migrations/*.sql`。
- `.runtime/` 下的 `patch-*.mjs/.cjs` 在构建/启动前对第三方源码进行字符串级补丁（如 `patch-alert-type.mjs`、`patch-monitor.cjs` 等），由 `.runtime/gateway-smoke.mjs` 等脚本触发。

### 3.5 基础设施

- `docker compose up` 启动 `postgres`（PostGIS 扩展）和 `minio`，数据持久化到命名卷 `agri-postgres` / `agri-minio`。
- 数据库初始化脚本位于 `infra/postgres/001_initial_schema.sql`，迁移脚本位于 `infra/postgres/migrations/001_initial_schema.sql`、`002_decision_telemetry.sql`。

## 4. 约定与约束

- **构建入口唯一**：所有 TS 代码通过根 `tsconfig.json` 的 `references` 列表参与 `tsc -b`，新增包需同时注册到该列表（见 `tsconfig.json` lines 3-27）。
- **NestJS 应用模板一致**：每个 `apps/*` 都包含 `nest-cli.json`、`tsconfig.build.json`、`src/main.ts`、`src/app.module.ts`、`src/http.ts`、`src/index.ts` 五件套，产出到 `dist/`。
- **测试绕过构建顺序**：`vitest.config.ts` 通过 `resolve.alias` 把 `@agri/*` 指向源码，注释明确说明“避免测试依赖构建顺序”，因此测试用例可直接 import 未构建的公共包。
- **装饰器语义**：生产侧由 `@agri/tsconfig/nest.json` 开启装饰器元数据，测试侧在 Vitest 的 `esbuild.tsconfigRaw` 中额外启用 `experimentalDecorators`（见 `vitest.config.ts` lines 11-19）。
- **pnpm 原生构建白名单**：`pnpm-workspace.yaml` 的 `allowBuilds` 只放行 esbuild、vue-demi、@vue/devtools-api、element-plus、@parcel/watcher，其余依赖的构建脚本被拦截，否则安装会报 `ERR_PNPM_IGNORED_BUILDS`（见 `pnpm-workspace.yaml` lines 5-13）。
- **服务启动协议**：`scripts/start-services.mjs` 强制注入 `SERVICE_MODE="http"` 与 `PORT`，并对除 gateway 外的服务注入 `*_SERVICE_URL` 环境变量指向 `http://127.0.0.1:<port>`，服务必须消费这些变量完成自注册。
- **无 CI/Dockerfile**：仓库未发现 GitHub Actions、Jenkinsfile、Makefile 或任何 `Dockerfile`，部署与持续集成不在当前仓库内实现。
- **Node 版本**：`engines.node >= 24.0.0`，构建与运行均要求 Node ≥ 24。
- **前端 API 代理**：`apps/web/vite.config.ts` 将 `/api/v1` 与 `/api` 代理到 `http://localhost:8080`，开发期前端与后端必须同机运行。