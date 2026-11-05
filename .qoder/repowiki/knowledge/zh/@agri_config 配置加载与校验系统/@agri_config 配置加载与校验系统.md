---
kind: configuration_system
name: '@agri/config 配置加载与校验系统'
category: configuration_system
scope:
    - '**'
source_files:
    - packages/config/src/env-schema.ts
    - packages/config/src/loader.ts
    - packages/config/src/secrets.ts
    - packages/config/src/module.ts
    - packages/config/src/index.ts
    - packages/config/package.json
    - .env.example
    - apps/plot-service/src/main.ts
    - apps/plot-service/src/app.module.ts
    - apps/web/.env
    - zhao-guang-farm-master/.env.development
    - zhao-guang-farm-master/.env.production
---

## 1. 采用的系统与方案

仓库使用自研的 `@agri/config` 包作为统一的运行时配置中心，核心依赖为：
- **Zod**（`z`）用于环境变量 schema 声明与类型推断；
- **NestJS DI**（`@nestjs/common` 的 `Module` / `DynamicModule` / `Global`）将配置以全局 Provider 注入到微服务容器；
- 纯函数式加载器 `loadConfig` / `validateEnv` 供非 Nest 入口（如示例脚本、冒烟测试）直接调用。

前端部分（`apps/web` 与 `zhao-guang-farm-master`）各自通过 Vite 原生 `.env*` 文件 + `VITE_*` 前缀变量进行构建期配置，与后端 Node 微服务的运行时配置体系相互独立。

## 2. 关键文件与包

- `packages/config/src/env-schema.ts` — Zod schema 定义，是环境变量的唯一说明来源；导出 `EnvRaw`、`AppConfig`、`DbEnvConfig`、`MqEnvConfig`、`RedisEnvConfig` 等类型。
- `packages/config/src/loader.ts` — 提供 `ConfigError`、`validateEnv`、`loadConfig` 三个入口；负责把 raw env 归并为按域分组的 `AppConfig`。
- `packages/config/src/secrets.ts` — 密钥抽象 `SecretsProvider`（`get`/`require`）、默认实现 `EnvSecretsProvider`、以及可全局注册的 `SecretsModule.register()`。
- `packages/config/src/module.ts` — Nest 全局模块 `ConfigModule.forRoot(options)`，暴露 `APP_CONFIG` 注入令牌。
- `packages/config/src/index.ts` — 统一 re-export。
- `packages/config/package.json` — 包元信息，描述为「配置加载与校验：环境变量校验结构、启动期配置加载、密钥读取」。
- `.env.example` — 根级环境变量模板，覆盖 NODE_ENV、DB_*、MQ_*、REDIS_*、FILE_S3_*、PLOT_REPOSITORY_MODE 等。
- `apps/plot-service/src/main.ts` — 示例服务入口，演示用 `loadConfig({ ...defaults, ...process.env })` 合并并启动。
- `apps/plot-service/src/app.module.ts` — 示例 Nest 模块，演示 `ConfigModule.forRoot({ load: () => appConfig })` 注入。
- `apps/web/.env`、`zhao-guang-farm-master/.env.development`、`zhao-guang-farm-master/.env.production` — 前端 Vite 构建期配置。

## 3. 架构与约定

### 3.1 分层与职责

| 层次 | 文件 | 职责 |
|---|---|---|
| Schema 层 | `env-schema.ts` | 用 Zod 声明每个环境变量的类型、枚举值、范围、默认值；同时产出 TS 类型。 |
| Loader 层 | `loader.ts` | 解析 → 校验 → 归并；失败抛 `ConfigError`，成功返回强类型的 `AppConfig`。 |
| Secrets 层 | `secrets.ts` | 抽象密钥读取接口，默认从进程环境变量读取，支持替换为外部密钥服务。 |
| DI 层 | `module.ts` | 将 `loadConfig` 结果注册为全局 Provider `APP_CONFIG`，供业务模块通过依赖注入消费。 |

### 3.2 加载流程

1. 应用启动时调用 `loadConfig(envSource)`（或 Nest 中通过 `ConfigModule.forRoot` 间接调用）。
2. 对传入的 `EnvSource`（默认 `process.env`）执行 `envSchema.safeParse`。
3. 校验失败 → 抛出 `ConfigError`，携带 issues 清单（形如 `path.join("."): message`），终止启动。
4. 校验成功 → 经 `toAppConfig` 归并为 `{ env, serviceName, port, logLevel, db, mq, redis }` 结构体。
5. Nest 场景下，该对象作为 `APP_CONFIG` 注入到任意 Provider。

### 3.3 密钥策略

- 所有密钥一律通过 `SecretsProvider.require(key)` 读取，缺失时抛 `ConfigError`。
- 默认实现 `EnvSecretsProvider` 从 `process.env` 取值；可通过 `SecretsModule.register(provider)` 替换为外部密钥服务。
- 代码注释明确禁止在代码与镜像中留存密钥，也禁止写入日志与事件。

### 3.4 前端配置

- `apps/web/.env` 与 `zhao-guang-farm-master/.env.*` 使用 Vite 约定的 `VITE_*` 前缀变量，由构建期注入到浏览器端。
- 前后端配置完全解耦：Node 侧不感知 `VITE_*` 变量，前端也不读取 `DB_URL` 等后端变量。

## 4. 约定与约束

以下规则来自代码中的注释、schema 定义与实现逻辑：

- **环境变量唯一说明来源**：`env-schema.ts` 注释写明「本结构是环境变量的唯一说明来源：任何新增配置项必须先在此声明，再在业务代码中读取」。新增配置必须先在 Zod schema 中添加字段，否则无法被 `loadConfig` 解析。
- **配置错误即启动失败**：`loader.ts` 注释「配置校验失败异常，携带问题清单」，`loadConfig` 在校验失败时抛 `ConfigError` 终止启动，把「配置错误」从运行期偶发故障变为启动期的确定性失败。
- **部署预检**：`validateEnv` 是「仅校验不读取，供部署前预检脚本使用」的 API，返回 `{ ok, issues }`，便于 CI 提前发现缺失变量。
- **枚举与范围约束**：`NODE_ENV` 仅限 `development|test|production`；`LOG_LEVEL` 仅限 `debug|info|warn|error`；`DB_SHARD_MODE` 仅限 `single|shared|isolated`；端口、池大小、Redis DB 编号均有数值范围校验。
- **默认值策略**：多数可选配置在 schema 上通过 `.default(...)` 提供默认值（如 `PORT=3000`、`LOG_LEVEL="info"`、`REDIS_HOST="127.0.0.1"`），强制必填项（如 `DB_URL`、`MQ_BROKERS`、`MQ_GROUP_ID`）不提供 default。
- **MQ brokers 多节点**：`MQ_BROKERS` 以逗号分隔字符串输入，loader 中按 `,` 拆分、trim、过滤空串后转为 `string[]`。
- **Nest 全局注入**：`ConfigModule` 标注 `@Global()`，服务只需在根模块导入一次即可在任何子模块注入 `APP_CONFIG`。
- **测试友好**：`ConfigModule.forRoot` 接受 `load` 选项允许注入固定配置；`loadConfig` 接受自定义 `env` 参数，便于单元测试注入假环境变量。
- **密钥不得落盘或入日志**：`secrets.ts` 注释「密钥一律从环境注入或密钥服务读取，禁止在代码与镜像中留存，也禁止写入日志与事件」。
- **前端构建期隔离**：前端使用 Vite 的 `VITE_*` 命名空间，与 Node 运行时环境变量互不干扰。