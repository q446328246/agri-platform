---
kind: build_system
name: pnpm workspace + Turbo 编排的 Node.js 微服务 Monorepo 构建系统
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - turbo.json
    - pnpm-workspace.yaml
    - .npmrc
    - vitest.config.ts
    - scripts/start-services.mjs
    - infra/docker-compose.yml
    - packages/tsconfig/nest.json
    - packages/tsconfig/library.json
    - apps/auth-service/package.json
    - apps/auth-service/tsconfig.build.json
    - apps/web/vite.config.ts
---

## 1. 使用的系统与工具

- **包管理器**: pnpm workspace（`pnpm-workspace.yaml`），根 `package.json` 声明 `workspaces: ["packages/*", "apps/*"]`。
- **任务编排与增量缓存**: Turbo（`turbo.json`，版本 ^2.11.10）。
- **TypeScript 编译**: TypeScript project references（`tsc -b`），由根脚本 `build` 触发；各子包通过 `tsconfig.build.json` 继承 `@agri/tsconfig` 下的共享配置。
- **测试运行器**: Vitest（`vitest.config.ts`），统一在 monorepo 根目录配置。
- **容器化基础设施**: Docker Compose（`infra/docker-compose.yml`），仅用于本地 PostGIS 与 MinIO，**未见业务服务的 Dockerfile / CI 流水线文件**。
- **Node 运行时约束**: 根 `package.json` 中 `engines.node >= 24.0.0`，所有脚本均为 ESM（`.mjs` / `"type": "module"`）。

## 2. 关键文件

- `package.json` — 根工作区入口，集中定义 `build`/`clean`/`test`/`smoke:*`/`start:*`/`health:*`/`db:migrate` 等顶层脚本。
- `turbo.json` — 定义 `build` 与 `typecheck` 两个任务，`dependsOn: ["^build"]` 实现依赖包先构建、产物缓存到 `dist/**` 与 `*.tsbuildinfo`。
- `pnpm-workspace.yaml` — 声明 packages/apps 两族工作区，并通过 `allowBuilds` 白名单放行 esbuild/vue-demi/@vue/devtools-api/element-plus/@parcel/watcher 的原生构建脚本。
- `.npmrc` — `strict-dep-builds=false`，避免未白名单的依赖构建脚本导致安装失败。
- `vitest.config.ts` — 全局测试配置：别名 `@agri/*` 直连源码（跳过构建顺序）、开启 `experimentalDecorators`、扫描 `packages/**/test/**/*.spec.ts` 与 `apps/**/test/**/*.spec.ts`。
- `scripts/start-services.mjs` — 本地启动全部微服务进程，注入 `SERVICE_MODE=http`、`PORT` 及各非 gateway 服务的 `*_SERVICE_URL`。
- `infra/docker-compose.yml` — 本地 PostGIS (`postgis/postgis:16-3.5`) 与 MinIO (`pgsty/minio`) 容器编排。
- `packages/tsconfig/` — 共享 tsconfig（`base.json`/`library.json`/`nest.json`/`strict.json`/`vue.json`），被各 app 与 package 继承。
- `apps/*/package.json` + `apps/*/tsconfig.build.json` + `apps/*/nest-cli.json` — 每个 NestJS 微服务独立包，产出 `dist/main.js`。
- `apps/web/package.json` + `vite.config.ts` — Vue 前端应用，使用 Vite 构建。

## 3. 架构与约定

### 构建管线

1. **类型检查优先**: `pnpm typecheck` 执行 `tsc -b --dry`，失败时回退到完整 `tsc -b`。Turbo 的 `typecheck` 任务同样依赖 `^build`，保证依赖包先产出生成代码。
2. **增量构建**: `pnpm build` 调用 `tsc -b`，利用 TypeScript project references 按引用图增量编译；Turbo 将 `dist/**` 与 `*.tsbuildinfo` 标记为输出，跨任务复用缓存。
3. **变更感知构建**: `pnpm build:changed` 走 `turbo run build`，仅重建受影响的包。
4. **测试隔离源码**: Vitest 通过 `resolve.alias` 把 `@agri/*` 直接解析到 `packages/*/src/index.ts`，注释明确说明“避免测试依赖构建顺序”。
5. **服务启动**: `pnpm start:services` → 先 `pnpm run build`，再执行 `scripts/start-services.mjs`，该脚本从 `service-registry.mjs` 读取服务清单，用 `child_process.spawn` 拉起每个 `apps/<svc>/dist/main.js`，并注入 `SERVICE_MODE=http`、`PORT` 以及其它服务的 HTTP URL。
6. **冒烟测试**: `smoke:gateway`、`smoke:services`、`smoke:decision-telemetry` 等脚本在构建后对已启动的服务发起 HTTP 探测。
7. **数据库迁移**: `pnpm db:migrate` 执行 `scripts/migrate-postgres.mjs`，配合 `infra/postgres/migrations/*.sql` 编号递增迁移文件。
8. **清理**: `pnpm clean` 同时执行 `tsc -b --clean` 与 `node scripts/clean.mjs`，删除 dist 与临时产物。

### 基础设施编排

- 本地开发通过 `docker compose -f infra/docker-compose.yml up` 启动 PostGIS 与 MinIO，端口映射 `5432`、`9000`、`9001`。
- Postgres 通过 `./postgres:/docker-entrypoint-initdb.d:ro` 挂载初始 SQL，健康检查使用 `pg_isready`。
- MinIO 通过 `mc ready local` 进行健康检查。

### 包结构约定

- 共享库位于 `packages/`，业务微服务位于 `apps/`，前端单页应用 `apps/web`。
- 每个 NestJS 微服务遵循统一脚手架：`src/main.ts` → `src/app.module.ts` → `src/http.ts` → `src/index.ts`，构建产物 `dist/main.js`。
- 每个包拥有独立的 `package.json`、`tsconfig.json`、`tsconfig.build.json`、`nest-cli.json`。

## 4. 约定与约束

- **Node 版本要求**: 根 `package.json` 的 `engines.node >= 24.0.0`，这是硬性约束。
- **ESM 强制**: 根 `package.json` 声明 `"type": "module"`，所有顶层脚本使用 `.mjs` 后缀。
- **构建命令约定**: 根脚本 `build` 固定为 `tsc -b`，`build:changed` 固定为 `turbo run build`；新增包的构建任务需同步在 `turbo.json` 中注册（参考现有 `build`/`typecheck` 任务）。
- **Turbo 缓存约定**: 所有需要被 Turbo 缓存的 task 必须声明 `outputs`，当前 `build` 任务输出 `dist/**` 与 `*.tsbuildinfo`。
- **pnpm 原生构建白名单**: `pnpm-workspace.yaml` 的 `allowBuilds` 与 `.npmrc` 的 `strict-dep-builds=false` 共同作用——只有白名单内的依赖才允许执行安装脚本，其余依赖的构建脚本被静默忽略而非报错。
- **测试路径约定**: Vitest 只扫描 `packages/**/test/**/*.spec.ts` 与 `apps/**/test/**/*.spec.ts`，测试文件必须以 `.spec.ts` 结尾并放在 `test/` 目录下。
- **服务发现约定**: `scripts/start-services.mjs` 通过 `getServices()` 返回 `[name, port, entry]` 三元组来启动服务；新增服务需在 service registry 中注册，并以 `http://127.0.0.1:${port}` 形式暴露给 gateway。
- **环境变量约定**: 非 gateway 服务通过 `NAME_SERVICE_URL` 环境变量互相发现；gateway 接收这些变量并转发到下游服务。
- **基础设施镜像版本**: PostGIS 固定 `postgis/postgis:16-3.5`，MinIO 固定 `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`，均通过 docker-compose 管理。

## 5. 尚未发现的设施

仓库中未发现 CI/CD 配置文件（如 GitHub Actions `.github/workflows`、Jenkinsfile、GitLab CI 等）、Dockerfile、Makefile 或发布脚本。因此本仓库的构建系统目前覆盖本地开发与测试阶段，生产打包与部署流程不在本仓库内。