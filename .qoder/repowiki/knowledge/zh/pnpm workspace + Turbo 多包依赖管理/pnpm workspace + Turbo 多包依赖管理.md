---
kind: dependency_management
name: pnpm workspace + Turbo 多包依赖管理
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
    - apps/web/package.json
    - zhao-guang-farm-master/package.json
---

## 1. 使用的系统/方案

仓库采用 **pnpm workspace**（`pnpm-workspace.yaml`）作为 monorepo 依赖解析与安装机制，配合 **Turbo**（`turbo.json`）做跨包的构建缓存与任务编排。根 `package.json` 声明 `workspaces: ["packages/*", "apps/*"]`，所有 Node.js 微服务（`apps/*`）与共享 TypeScript 包（`packages/*`）通过 `workspace:*` 协议互相引用。

- 包管理器：pnpm（由根 `pnpm-lock.yaml` 锁定版本）
- 构建编排：Turbo v2（`turbo run build`、`turbo run typecheck`）
- 类型检查：TypeScript project references（`tsc -b` / `tsc -b --dry`）
- 测试：Vitest（根 `vitest.config.ts`）
- 私有 npm registry：未配置 `.npmrc` 中的 `registry`，仅启用 `strict-dep-builds=false`

## 2. 关键文件

- `package.json` — 根工作区入口，声明 Node 引擎要求 `>=24.0.0`、workspace 范围、顶层脚本（build/test/smoke/db:migrate 等）及少量根级依赖（pg、@nestjs/common、turbo、typescript、vitest、zod）。
- `pnpm-workspace.yaml` — 定义 workspace 成员 `packages/*`、`apps/*`，并通过 `allowBuilds` 白名单放行 esbuild、vue-demi、@vue/devtools-api、element-plus、@parcel/watcher 的原生构建脚本，避免 `ERR_PNPM_IGNORED_BUILDS`。
- `.npmrc` — 设置 `strict-dep-builds=false`，让未被白名单命中的依赖构建失败不会导致整个安装失败。
- `turbo.json` — 定义 `build` 与 `typecheck` 两个 task，`dependsOn: ["^build"]` 确保依赖包先构建；输出产物为 `dist/**` 与 `*.tsbuildinfo`。
- `pnpm-lock.yaml` — 全仓依赖锁定文件（存在但内容未展开）。
- `packages/*/package.json` — 共享包（如 `@agri/shared`、`@agri/contracts`、`@agri/tsconfig` 等）使用 `workspace:*` 引用其他内部包，并以 `exports` 字段暴露 ESM 入口与类型声明。
- `apps/*/package.json` — 各 NestJS 微服务各自声明运行时依赖（如 pg、axios、dayjs 等），不直接引用 `workspace:*`（业务包之间通过 `@agri/*` 间接耦合）。
- `zhao-guang-farm-master/package.json` — 独立的 Vue 前端子项目，拥有自己的 `yarn.lock`，与主 workspace 解耦。

## 3. 架构与约定

- **Monorepo 分层**：`packages/*` 为纯库（无 `private: false` 发布意图，均为 `private: true`），`apps/*` 为可独立启动的微服务或前端应用。库之间通过 `workspace:*` 零拷贝链接。
- **ESM 优先**：根与各包均声明 `"type": "module"`，共享包通过 `exports` 同时提供 `types` 与 `import` 入口。
- **依赖版本策略**：外部依赖普遍使用 `^` 语义化版本（如 `"^5.9.3"`、`"^11.2.8"`），由 pnpm 在 lockfile 中固定精确版本；内部包统一使用 `workspace:*` 表示“始终使用本地最新版本”。
- **构建/类型隔离**：每个包独立维护 `tsconfig.json` 与 `tsconfig.build.json`，通过 `tsc -b` 按 project reference 顺序编译；Turbo 负责跨包并行与缓存。
- **原生模块处理**：pnpm 默认拦截依赖的构建脚本，仓库通过 `allowBuilds` 白名单显式允许特定包的原生构建，并在 `.npmrc` 中关闭严格模式以容忍非白名单构建失败。

## 4. 约定与约束

- **Workspace 成员范围**：只有 `packages/*` 与 `apps/*` 下的目录会被 pnpm 识别为 workspace 成员（来源：`pnpm-workspace.yaml` 的 `packages` 列表）。
- **Node 版本下限**：根 `engines.node` 要求 `>=24.0.0`（来源：根 `package.json`）。
- **内部包引用必须走 `workspace:*`**：所有 `@agri/*` 之间的依赖均以 `workspace:*` 声明（例如 `@agri/shared` 对 `@agri/contracts` 的依赖），禁止硬编码版本号，以保证 monorepo 内同步升级（观察到的模式）。
- **构建脚本白名单**：只有 `esbuild`、`vue-demi`、`@vue/devtools-api`、`element-plus`、`@parcel/watcher` 被允许执行安装时的构建脚本（来源：`pnpm-workspace.yaml` 的 `allowBuilds`）；其余依赖若带构建脚本，安装时会被忽略且不会阻断安装（来源：`.npmrc` 的 `strict-dep-builds=false`）。
- **Turbo 任务契约**：新增包若要参与增量构建，需遵循 `build` 产出 `dist/**` 与 `*.tsbuildinfo` 的约定（来源：`turbo.json` 的 outputs 配置）。
- **zhao-guang-farm-master 独立于 workspace**：该目录自带 `yarn.lock` 与独立 `package.json`，不参与根 pnpm workspace，属于历史遗留的独立前端工程。
- **无私有 registry 配置**：`.npmrc` 未设置 `registry` 或 `@scope:registry`，所有第三方包从公共 npm 源拉取（来源：`.npmrc` 仅含一行 `strict-dep-builds=false`）。