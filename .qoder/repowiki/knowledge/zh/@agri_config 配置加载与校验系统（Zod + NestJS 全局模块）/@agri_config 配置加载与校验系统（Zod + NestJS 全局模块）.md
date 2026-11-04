---
kind: configuration_system
name: '@agri/config 配置加载与校验系统（Zod + NestJS 全局模块）'
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
    - scripts/start-services.mjs
    - apps/plot-service/src/app.module.ts
    - apps/plot-service/src/main.ts
---

## 1. 使用的系统与框架

- **Zod**：作为环境变量 schema 的唯一声明来源，负责类型推断、默认值、枚举约束与解析。
- **NestJS `@Global()` 动态模块**：`ConfigModule.forRoot` 和 `SecretsModule.register` 以全局 provider 形式注入 `APP_CONFIG` 与 `SECRETS_PROVIDER`。
- **pnpm workspace 包 `@agri/config`**：将配置加载逻辑从各微服务中抽离为共享包，供所有 NestJS 应用消费。
- **`.env.example` + 进程环境变量**：运行时配置仅通过 `process.env` 注入；前端 `apps/web/.env` 使用 Vite 的 `VITE_*` 前缀变量。

## 2. 关键文件与包

- `packages/config/src/env-schema.ts` — Zod schema 定义，集中声明所有环境变量及其类型、默认值、取值范围。
- `packages/config/src/loader.ts` — `loadConfig` / `validateEnv` 与 `ConfigError`，负责解析、校验、归并为 `AppConfig`。
- `packages/config/src/secrets.ts` — `SecretsProvider` 契约、`EnvSecretsProvider` 实现、`SecretsModule` 全局注册。
- `packages/config/src/module.ts` — `ConfigModule.forRoot(options)` 全局动态模块，暴露 `APP_CONFIG` token。
- `packages/config/src/index.ts` — 统一导出入口。
- `.env.example` — 根级环境变量模板，覆盖 NODE_ENV、DB、MQ、REDIS、FILE_STORAGE_MODE 等。
- `scripts/start-services.mjs` — 本地启动脚本，向子进程注入 `SERVICE_MODE=http`、`PORT` 以及 `{NAME}_SERVICE_URL`。
- `apps/plot-service/src/app.module.ts` 与 `main.ts` — 当前唯一显式导入 `@agri/config` 的服务示例。

## 3. 架构与约定

### 3.1 配置加载流程

1. 在 `env-schema.ts` 中以 Zod 对象声明全部环境变量，每个字段附带注释说明用途与取值范围。
2. `loader.ts` 的 `loadConfig(env)` 调用 `envSchema.safeParse(env)`，失败时抛出 `ConfigError`（携带 issues 数组），成功则经 `toAppConfig` 归并为按域分组的 `AppConfig`（含 `db`、`mq`、`redis` 子对象）。
3. `validateEnv` 提供「仅校验不读取」能力，返回 `{ ok, issues }`，供部署前预检脚本使用。
4. `ConfigModule.forRoot({ load?, env? })` 在 NestJS 启动期执行加载，并通过 `@Global()` 把 `APP_CONFIG` 暴露给所有业务模块；测试场景可通过 `load: () => appConfig` 注入固定配置。
5. 密钥通过 `SecretsModule.register(provider?)` 注册，默认 `EnvSecretsProvider` 从 `process.env` 读取；`require(key)` 缺失时抛 `ConfigError`，`get(key)` 返回 `undefined`。

### 3.2 分层与环境来源

| 层级 | 来源 | 说明 |
|---|---|---|
| 后端运行时 | `process.env` | 由容器/编排平台或 `scripts/start-services.mjs` 注入 |
| 前端构建期 | `apps/web/.env`（Vite `VITE_*` 前缀） | 仅用于前端常量，如天地图 Key |
| 开发模板 | `.env.example` | 列出所有必需环境变量及默认值 |

### 3.3 领域分组约定

`AppConfig` 按基础设施域分组：
- `db.url / shardMode / poolSize / slowQueryMs`
- `mq.brokers[] / clientId / groupId / autoCommitIntervalMs`
- `redis.host / port / db`

新增配置项必须先在 `envSchema` 中声明，再在 `toAppConfig` 中映射到对应域，最后由业务代码通过 `APP_CONFIG` 注入读取。

## 4. 约定与约束

- **环境变量是配置的唯一运行时来源**：`loader.ts` 默认取 `process.env`，`ConfigModule.forRoot` 与 `SecretsModule` 均通过可选参数接受自定义 `Record<string,string|undefined>`，便于测试注入。
- **配置错误在启动期终止**：`loadConfig` 在校验失败时直接抛 `ConfigError`，注释明确「把配置错误从运行期偶发故障变为启动期的确定性失败」。
- **Zod schema 是唯一权威来源**：`env-schema.ts` 顶部注释规定「任何新增配置项必须先在此声明，再在业务代码中读取」。
- **密钥禁止硬编码**：`secrets.ts` 注释要求「密钥一律从环境注入或密钥服务读取，禁止在代码与镜像中留存，也禁止写入日志与事件」。`require(key)` 缺失时抛 `ConfigError(['SECRET.${key}: 密钥缺失'])`。
- **配置模块全局注册**：`ConfigModule` 与 `SecretsModule` 都标记 `global: true`，服务只需在根模块导入一次即可在所有子模块注入。
- **端口与连接池范围受约束**：`PORT` 限定 1–65535，`DB_POOL_SIZE` 限定 1–200，`REDIS_PORT` 限定 1–65535，`REDIS_DB` 限定 0–15。
- **消息代理地址支持多节点逗号分隔**：`toAppConfig` 对 `MQ_BROKERS` 执行 split/trim/filter 空串。
- **分片模式与日志级别为枚举**：`DB_SHARD_MODE` 限定 `single|shared|isolated`，`LOG_LEVEL` 限定 `debug|info|warn|error`，`NODE_ENV` 限定 `development|test|production`。
- **本地启动脚本强制注入 `SERVICE_MODE=http` 与 `PORT`**：见 `scripts/start-services.mjs` 中 `spawn` 调用的 env 合并逻辑。
- **当前仅有 plot-service 显式集成该配置模块**：其余服务（gateway-service 等）的 `app.module.ts` 为空壳或未引入 `@agri/config`，表明该配置系统尚未被所有微服务采用。