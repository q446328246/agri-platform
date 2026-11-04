---
kind: dependency_management
name: pnpm + Turbo Monorepo 依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - .npmrc
    - turbo.json
    - pnpm-lock.yaml
    - packages/shared/package.json
    - apps/auth-service/package.json
    - apps/web/package.json
---

## 1. 使用的系统/方案

仓库采用 **pnpm workspace** 作为包管理器与工作区编排，配合 **Turbo** 做跨包构建缓存与任务调度；TypeScript 通过 `tsc -b`（project references）进行增量编译；测试统一使用 **Vitest**。所有 Node.js 代码以 ESM (`"type": "module"`) 编写，根 `package.json` 通过 `engines.node >=24.0.0` 锁定运行时版本。

## 2. 关键文件

- `package.json`：根工作区入口，声明 `workspaces: ["packages/*", "apps/*"]`、全局脚本（build/typecheck/test/smoke/start-services/db:migrate 等）以及顶层 devDependencies（@nestjs/common、turbo、typescript、vitest、zod、pg 等）。
- `pnpm-workspace.yaml`：定义 pnpm workspace 成员目录，并通过 `allowBuilds` 白名单放行 esbuild、vue-demi、@vue/devtools-api、element-plus、@parcel/watcher 的原生构建脚本，避免 `ERR_PNPM_IGNORED_BUILDS`。
- `.npmrc`：设置 `strict-dep-builds=false`，让未被白名单命中的依赖的构建失败不导致整个安装失败。
- `turbo.json`：定义 `build` 与 `typecheck` 两个 task，`dependsOn: ["^build"]` 确保依赖包先构建，输出产物为 `dist/**` 与 `*.tsbuildinfo`。
- `packages/*/package.json`：公共包（如 `@agri/shared`、`@agri/config`、`@agri/contracts`、`@agri/db`、`@agri/mq`、`@agri/observability`、`@agri/plot-core`、`@agri/testing`、`@agri/tsconfig`、`@agri/eslint-config`）各自声明 `exports` 字段（types + import），并以 `workspace:*` 引用其他 @agri/* 包。
- `apps/*/package.json`：每个 NestJS 微服务应用（auth-service、control-service、decision-service、file-service、finance-service、gateway-service、iot-service、message-service、operation-service、platform-service、plot-service、telemetry-service、trace-service、video-service、weather-service）均通过 `workspace:*` 引入共享包，并各自维护自己的依赖。
- `apps/web/package.json`：Vue3 + Vite 前端工程，独立依赖集（vue、pinia、element-plus、echarts、leaflet 等）。
- `zhao-guang-farm-master/package.json` + `yarn.lock`：独立的 Vue2/Vue3 混合旧前端，使用 yarn 管理，与主 monorepo 解耦。
- `pnpm-lock.yaml`：pnpm 锁文件，用于锁定所有 workspace 内包的解析结果。

## 3. 架构与约定

- **Monorepo 结构**：`packages/*` 存放横切公共包（领域契约、配置加载、数据库访问、消息总线、可观测性、地块模型、测试夹具、ESLint 配置、TS 基础配置），`apps/*` 存放业务微服务与前端。根 `package.json` 仅声明工具链依赖，业务依赖下沉到各子包。
- **内部包引用**：所有 @agri/* 包之间通过 `workspace:*` 协议引用，由 pnpm 在本地解析，无需发布到 npm registry。
- **构建管线**：根级 `pnpm run build` 调用 `tsc -b`；也可用 `pnpm run build:changed` 走 Turbo 增量构建。Turbo 的 `build` task 依赖上游包的 `^build`，保证依赖顺序。
- **类型检查**：根级 `typecheck` 脚本优先尝试 `tsc -b --dry`，失败时回退全量 `tsc -b`。
- **测试**：根级 `test` 直接调用 `vitest run`，由各子包自行配置 vitest。
- **运行脚本**：根级提供 `start:services`、`smoke:gateway`、`smoke:services`、`health:services`、`init:minio`、`db:migrate` 等编排脚本，统一启动/冒烟/健康检查/迁移流程。
- **Node 版本约束**：根 `package.json` 的 `engines.node >=24.0.0` 是显式约束；部分子包（如 apps/web）devDependencies 中仍出现较旧的 `@types/node` 版本（22.x），但运行时由根 engines 控制。

## 4. 约定与约束

- **包名命名空间**：所有公共包与应用均以 `@agri/` 前缀命名（如 `@agri/shared`、`@agri/auth-service`、`@agri/web`），便于在 workspace 内按命名空间识别。
- **workspace 协议**：内部依赖统一使用 `workspace:*` 版本号（见 `packages/shared/package.json`、`apps/auth-service/package.json` 等），禁止对内部包使用语义化版本范围。
- **构建脚本白名单**：`pnpm-workspace.yaml` 的 `allowBuilds` 明确列出允许执行原生构建的依赖（esbuild、vue-demi、@vue/devtools-api、element-plus、@parcel/watcher），其余依赖的构建脚本被拦截；`.npmrc` 的 `strict-dep-builds=false` 使这些失败不会中断整体安装。
- **Turbo 任务输出**：`turbo.json` 规定 `build` 的输出目录为 `dist/**` 和 `*.tsbuildinfo`，这是 Turbo 缓存有效性的依据。
- **私有仓库/认证**：未发现 `.npmrc` 中配置私有 registry、token 或 `@scope:` 映射；也未发现 `GOPRIVATE`、`vendor/` 目录或其他语言的依赖锁定文件（Go/Rust/Python 等）。依赖来源均为公共 npm registry。
- **锁文件策略**：使用 `pnpm-lock.yaml` 作为唯一锁定文件；`zhao-guang-farm-master/` 下的 `yarn.lock` 属于独立项目，不与主 monorepo 共享。
- **Node 引擎锁定**：根 `package.json` 的 `engines.node >=24.0.0` 是仓库内唯一的运行时版本约束点。