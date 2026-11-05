---
kind: build_system
name: pnpm workspace + Turbo 多包构建与 Docker 双目标镜像编排
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - turbo.json
    - pnpm-workspace.yaml
    - .npmrc
    - vitest.config.ts
    - Dockerfile
    - infra/docker-compose.yml
    - scripts/start-services.mjs
    - apps/web/vite.config.ts
---

## 1. 使用的系统与工具

- **包管理**: pnpm 11（`pnpm@11.22.0`，通过 `Dockerfile` 全局安装），配合 `pnpm-workspace.yaml` 组织 monorepo。
- **任务编排/缓存**: Turbo (`turbo@^2.11.10`)，定义 `build`、`typecheck` 两个 task，依赖 `^build` 实现跨包增量构建与输出缓存。
- **TypeScript 编译**: TypeScript 5.9，根级使用 `tsc -b`（project references）做类型检查与增量编译；生产构建走 `turbo run build`，测试期 Vitest 通过 esbuild 直连源码跳过构建。
- **测试框架**: Vitest 3，统一入口 `vitest.config.ts`，扫描 `packages/**/test/**/*.spec.ts` 与 `apps/**/test/**/*.spec.ts`。
- **容器化**: 单 `Dockerfile` 提供两个可部署 target：`app`（Node 进程内启动全部 15 个 HTTP 服务）和 `edge`（nginx 反代 + HTTPS + 前端静态资源）。
- **本地基础设施编排**: `infra/docker-compose.yml` 编排 PostGIS、MinIO、应用 `app`、边缘 `edge`，并通过 `profiles: ["app"]` 默认只拉起基础设施。

## 2. 关键文件

- `package.json` — 根脚本入口：`build`、`build:changed`、`clean`、`typecheck`、`test`、各类 `smoke:*`、`start:services`、`db:migrate`、`health:*`。
- `turbo.json` — Turbo task 定义，`build` 产出 `dist/**` 与 `*.tsbuildinfo`。
- `pnpm-workspace.yaml` — 声明 `packages/*`、`apps/*` 为 workspace，并通过 `allowBuilds` 白名单放行 `esbuild`、`vue-demi`、`element-plus` 等原生构建脚本。
- `.npmrc` — `strict-dep-builds=false`，未命中白名单的构建脚本不导致安装失败。
- `vitest.config.ts` — 测试期别名把 `@agri/*` 指向源码目录，并开启 `experimentalDecorators` 以支持 NestJS 装饰器。
- `Dockerfile` — 双 stage 构建：`build` → `app`（Node 运行时）+ `edge`（nginx）。CMD 顺序：`migrate-postgres.mjs` → `init-minio.mjs` → `start-services.mjs`。
- `infra/docker-compose.yml` — 定义 postgres/minio/app/edge 四个 service，含 healthcheck、环境变量注入、volumes。
- `scripts/start-services.mjs` — 按 `service-registry.mjs` 注册表并行 spawn 所有微服务子进程，仅 gateway 暴露 `SERVICE_HOST=0.0.0.0`，其余监听 `127.0.0.1`。
- `apps/web/vite.config.ts` — Vue 前端开发服务器代理 `/api` 到 `localhost:8080`。

## 3. 架构与约定

### 构建管线

1. 开发者执行 `pnpm build`（等价 `tsc -b`）或 `pnpm build:changed`（等价 `turbo run build`）。
2. Turbo 根据 `dependsOn: ["^build"]` 保证依赖包先于消费者构建，产物写入各包的 `dist/` 与根 `*.tsbuildinfo`。
3. 测试由 Vitest 直接转译源码（不走 tsc 产物），通过 `resolve.alias` 将 `@agri/*` 映射到 `packages/*/src/index.ts`，避免测试依赖构建顺序。
4. 运行前需先 `pnpm run build`，再由 `scripts/start-services.mjs` 启动全部 15 个 NestJS 服务（gateway 除外均绑定回环地址）。

### 容器镜像

- `Dockerfile` 注释明确“一个 Dockerfile 两个可部署目标”：`--target app` 与 `--target edge`。
- 构建上下文必须是仓库根目录（见 Dockerfile 第 6–8 行注释）。
- 构建阶段拷贝 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`package.json`、`.npmrc`、`turbo.json`、`tsconfig.json` 以及 `packages/`、`apps/`，然后 `pnpm install --frozen-lockfile`。
- 前端地图 Key 通过 `ARG VITE_TIANDITU_KEY` 注入，未传时回落到 `apps/web/.env`。
- 运行镜像重新 `pnpm install --prod --frozen-lockfile`，剔除 devDependencies。
- CMD 在容器启动时依次执行迁移、MinIO bucket 初始化、服务启动，三者均为幂等操作。

### 本地编排

- `docker-compose.yml` 中 `postgres` 使用 `postgis/postgis:16-3.5`，`minio` 使用 `pgsty/minio`，均带 `healthcheck`。
- `app` service 通过 `depends_on` 等待 postgres/minio 健康后启动，并以 `node -e "fetch('http://127.0.0.1:8080/health')..."` 作为自身 healthcheck。
- `edge` service 基于 nginx:1.27-alpine，默认生成自签证书（CN=agri.local，SAN 包含 localhost/agri.local/127.0.0.1），生产可通过挂载 `infra/certs` 覆盖。
- 所有业务服务的 repository mode 通过环境变量显式切换为 `sql`（`*_REPOSITORY_MODE: sql`），鉴权模式设为 `enforce`。

### 冒烟测试

根 `package.json` 暴露大量 `smoke:*` 脚本（gateway/services/events/consumers/messages/authz/identity/decision-telemetry），每个都先 `pnpm run build` 再执行对应 `scripts/smoke-*.mjs`。`scripts/start-services.mjs` 负责把非 gateway 服务的 URL 注入为 `*_SERVICE_URL` 环境变量供被测服务消费。

## 4. 约定与约束

- **Node 版本**：根 `package.json` 的 `engines.node >= 24.0.0`，Dockerfile 使用 `node:24-bookworm-slim` 基础镜像，pnpm 固定为 `11.22.0`。
- **依赖锁定**：Dockerfile 与 compose 构建均使用 `pnpm install --frozen-lockfile`，禁止安装时变更 `pnpm-lock.yaml`。
- **workspace 构建脚本白名单**：`pnpm-workspace.yaml` 的 `allowBuilds` 与 `.npmrc` 的 `strict-dep-builds=false` 共同作用，只有白名单内的依赖（esbuild、vue-demi、@vue/devtools-api、element-plus、@parcel/watcher）允许执行安装脚本，其余被忽略而不报错。
- **服务暴露约定**：`scripts/start-services.mjs` 中仅 gateway 设置 `SERVICE_HOST=0.0.0.0`，其余服务强制监听 `127.0.0.1`；compose 中 `app` service 也通过 `SERVICE_HOST=0.0.0.0` 覆盖网关的默认值。
- **数据库迁移**：镜像 CMD 在启动服务前先执行 `scripts/migrate-postgres.mjs`，迁移 SQL 位于 `infra/postgres/migrations/`，按 `001_initial_schema.sql`…`007_auth_sessions.sql` 编号递增。
- **前端代理**：`apps/web/vite.config.ts` 将 `/api` 与 `/api/v1` 代理到 `http://localhost:8080`（即 gateway 端口）。
- **测试别名**：`vitest.config.ts` 显式列出 `@agri/contracts`、`@agri/plot-core`、`@agri/observability`、`@agri/db`、`@agri/mq`、`@agri/config`、`@agri/shared`、`@agri/testing` 的源码路径别名，且要求子路径导出必须排在主入口之前（见注释）。
- **Turbo 缓存键**：`turbo.json` 声明 `build` 的输出为 `dist/**` 与 `*.tsbuildinfo`，`typecheck` 无输出，两者均依赖 `^build` 确保依赖包先构建。