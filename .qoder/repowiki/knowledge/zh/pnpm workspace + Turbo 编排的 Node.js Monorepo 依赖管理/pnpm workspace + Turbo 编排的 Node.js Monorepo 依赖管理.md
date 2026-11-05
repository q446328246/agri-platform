---
kind: dependency_management
name: pnpm workspace + Turbo 编排的 Node.js Monorepo 依赖管理
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
    - apps/gateway-service/package.json
    - apps/web/package.json
---

## 1. 使用的系统/方案

仓库采用 **pnpm workspace** 作为包管理器与 monorepo 编排工具，配合 **Turbo** 做任务缓存与增量构建。根 `package.json` 声明 `workspaces: ["packages/*", "apps/*"]`，`pnpm-workspace.yaml` 同步列出相同目录，形成双清单约束。

- 包注册源：未配置私有 registry（`.npmrc` 仅设置 `strict-dep-builds=false`），默认使用 npm 官方源。
- 版本锁定：根级生成 `pnpm-lock.yaml`，所有子包的依赖版本由 pnpm 解析并落盘到该锁文件。
- 运行时引擎：根 `package.json` 通过 `engines.node >=24.0.0` 强制 Node 版本。
- 构建脚本白名单：`pnpm-workspace.yaml` 中 `allowBuilds` 显式放行 `esbuild`、`vue-demi`、`@vue/devtools-api`、`element-plus`、`@parcel/watcher`；`.npmrc` 中 `strict-dep-builds=false` 让未被白名单命中的构建失败不会导致安装整体失败。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 根工作区入口，声明 workspaces、全局 devDependencies（turbo、typescript、vitest、nestjs 等）、Node 引擎要求 |
| `pnpm-workspace.yaml` | pnpm workspace 成员列表 + `allowBuilds` 构建脚本白名单 |
| `.npmrc` | 关闭严格构建脚本检查 (`strict-dep-builds=false`) |
| `turbo.json` | Turbo 任务定义：`build` 依赖 `^build`（上游依赖先 build），输出 `dist/**` 与 `*.tsbuildinfo` |
| `pnpm-lock.yaml` | 全仓依赖解析快照（lockfile） |
| `apps/*/package.json` | 各微服务独立声明运行时依赖与 workspace 引用 |
| `packages/*/package.json` | 共享包（`@agri/shared`、`@agri/config`、`@agri/contracts`、`@agri/db`、`@agri/mq`、`@agri/observability`、`@agri/testing`、`@agri/tsconfig`、`@agri/plot-core`）各自声明 `exports` 与 `workspace:*` 引用 |
| `apps/web/package.json` | Vue 前端应用，依赖 element-plus、echarts、pinia、leaflet 等第三方库 |

## 3. 架构与约定

- **Monorepo 结构**：`packages/*` 存放共享 TypeScript 包，`apps/*` 存放 NestJS 微服务与 Vue 前端。每个子项目都是独立的 npm package，拥有自己的 `package.json`、`tsconfig.json`、`nest-cli.json`。
- **内部包引用**：子包之间通过 `workspace:*` 协议引用，例如 `gateway-service` 依赖 `@agri/config`、`@agri/contracts`、`@agri/shared`，开发时直接链接源码而非发布产物。
- **包导出契约**：共享包在 `package.json` 中使用 `exports` 字段声明 ESM 入口（如 `@agri/shared` 暴露 `./dist/index.js` 与 `./dist/index.d.ts`），限制外部可访问路径。
- **构建链**：根 `scripts.build` 调用 `tsc -b`（TypeScript project references 顺序编译），同时提供 `build:changed` 走 Turbo 增量构建。Turbo 的 `dependsOn: ["^build"]` 确保依赖包先于消费者构建。
- **测试**：统一使用 Vitest（根 `devDependencies` 声明 `vitest ^3.2.7`），各 app 也可单独覆盖版本。
- **前端工程**：`apps/web` 是独立的 Vite + Vue3 应用，不纳入 pnpm workspace（其 `package.json` 位于 `apps/web/` 下但不在 `pnpm-workspace.yaml` 的匹配范围内），有自己的 `node_modules`。

## 4. 约定与约束

- **Node 版本约束**：根 `package.json` 的 `engines.node >=24.0.0` 是硬性要求，pnpm 会在安装前校验。
- **Workspace 成员范围**：只有 `packages/*` 和 `apps/*` 下的目录会被 pnpm 识别为 workspace 成员；`zhao-guang-farm-master` 是独立的前端工程，不参与 monorepo 依赖解析。
- **构建脚本白名单**：除 `pnpm-workspace.yaml` 中列出的 `esbuild`、`vue-demi`、`@vue/devtools-api`、`element-plus`、`@parcel/watcher` 外，其他依赖的 postinstall/build 脚本不会被执行；且由于 `.npmrc` 设置了 `strict-dep-builds=false`，这类失败不会中断整个安装流程。
- **内部包版本策略**：所有 `@agri/*` 包均固定为 `version: "1.0.0"` 且标记 `private: true`，表明它们仅在 monorepo 内通过 `workspace:*` 引用，不对外发布。
- **依赖来源**：未发现私有 registry 或 `registry=` 配置，所有第三方依赖来自 npm 官方源；无 vendored 第三方代码（`node_modules` 均为符号链接）。