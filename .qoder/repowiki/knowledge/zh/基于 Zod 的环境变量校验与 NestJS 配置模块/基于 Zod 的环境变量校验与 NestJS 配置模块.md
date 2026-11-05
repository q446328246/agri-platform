---
kind: configuration_system
name: 基于 Zod 的环境变量校验与 NestJS 配置模块
category: configuration_system
scope:
    - '**'
source_files:
    - packages/config/src/env-schema.ts
    - packages/config/src/loader.ts
    - packages/config/src/module.ts
    - packages/config/src/secrets.ts
    - packages/config/src/index.ts
    - packages/config/package.json
    - .env.example
    - infra/docker-compose.yml
    - apps/web/.env
---

## 1. 采用的方案

仓库采用 **Zod 运行时类型校验 + NestJS DynamicModule** 的组合实现配置系统：
- 所有服务共享 `@agri/config` 包，集中定义环境变量 schema、加载器、NestJS 注入模块与密钥读取抽象。
- 通过 `pnpm workspace` 在 monorepo 内被各微服务直接依赖（`"@agri/config": "workspace:*"`）。
- 部署时由 Docker Compose 注入环境变量，本地开发使用 `.env.example` 作为模板。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `packages/config/src/env-schema.ts` | Zod schema 定义，是环境变量的唯一说明来源 |
| `packages/config/src/loader.ts` | `loadConfig()` / `validateEnv()` 与 `ConfigError` |
| `packages/config/src/module.ts` | NestJS 全局模块 `ConfigModule.forRoot()`，导出 `APP_CONFIG` 令牌 |
| `packages/config/src/secrets.ts` | `SecretsProvider` 接口 + `EnvSecretsProvider` + `SecretsModule.register()` |
| `packages/config/src/index.ts` | 统一 re-export |
| `.env.example` | 完整环境变量清单（DB/MQ/Redis/存储/鉴权等） |
| `infra/docker-compose.yml` | 生产 profile 下向 `app` 容器注入全部运行期配置 |
| `apps/web/.env` | 前端 Vite 构建用 `VITE_TIANDITU_KEY` |

## 3. 架构与约定

### 3.1 配置加载流程

```text
进程启动
  → loadConfig(process.env)
    → envSchema.safeParse(env)   // Zod 校验
      → 失败：抛出 ConfigError(issues[])，终止启动
      → 成功：toAppConfig(parsed.data) 归并为 AppConfig
```

- `loadConfig()` 在校验失败时抛出自定义 `ConfigError`，携带可读的 issues 列表（如 `db.url: Required`），把配置错误从运行期偶发故障变为启动期的确定性失败。
- `validateEnv()` 提供仅校验不读取的入口，供部署前预检脚本复用。
- `toAppConfig()` 将扁平的 `process.env` 归并为按域分组的 `AppConfig`（`db` / `mq` / `redis` 子对象），并做简单转换（如 `MQ_BROKERS` 逗号分隔转数组）。

### 3.2 NestJS 集成

- `ConfigModule.forRoot({ load?, env? })` 注册为 `@Global()` 模块，暴露 `APP_CONFIG` provider；服务根模块只需导入一次，业务层即可通过 `@Inject(APP_CONFIG)` 注入 `AppConfig`。
- `load` 选项用于测试注入固定配置，`env` 选项允许覆盖环境变量来源。
- `SecretsModule.register(provider?)` 同样以 global 动态模块形式注册 `SECRETS_PROVIDER`，默认实现 `EnvSecretsProvider` 从 `process.env` 读取。

### 3.3 密钥策略

- 密钥一律通过 `SecretsProvider.get()/require()` 读取，禁止硬编码或写入日志/事件。
- `require(key)` 缺失时抛出 `ConfigError(['SECRET.${key}: 密钥缺失'])`，与常规配置错误同构。
- 可通过 `SecretsModule.register(customProvider)` 替换为外部密钥服务（如 Vault）。当前 `docker-compose.yml` 中敏感项（`INTERNAL_TOKEN`、`FILE_S3_ACCESS_KEY`、`FILE_S3_SECRET_KEY`）通过 `${VAR:-default}` 语法注入。

### 3.4 环境变量分层

- `.env.example` 是完整清单，包含 DB、MQ、Redis、存储、鉴权、消息消费等全部键。
- `docker-compose.yml` 的 `app` service 只显式声明部署所需键，其余走镜像默认值或 `.env`。
- 部分服务（如 `auth-service`）仍直接 `process.env.PORT` / `process.env.AUTH_REPOSITORY_MODE` 读取，尚未统一迁移到 `@inject(APP_CONFIG)`，属于渐进式改造中的遗留模式。

### 3.5 前端配置

- 前端 `apps/web/.env` 仅含 `VITE_TIANDITU_KEY`，由 Vite 在构建期注入，与后端 Node 配置完全分离。

## 4. 约定与约束

- **环境变量必须先在 `envSchema` 中声明**：schema 注释明确“本结构是环境变量的唯一说明来源：任何新增配置项必须先在此声明，再在业务代码中读取”。这是通过 Zod 校验强制执行的——未声明的键不会出现在 `AppConfig` 中，新增字段若不写 default 则会导致启动失败。
- **配置缺失导致启动失败**：`loadConfig()` 抛 `ConfigError`，服务进程退出，不允许带脏配置运行。
- **密钥不得硬编码**：`secrets.ts` 注释规定“密钥一律从环境注入或密钥服务读取，禁止在代码与镜像中留存，也禁止写入日志与事件”。`EnvSecretsProvider.require()` 对缺失密钥抛错，构成运行时约束。
- **NestJS 服务通过 `ConfigModule.forRoot()` 注入配置**：`module.ts` 注释要求“服务只需在根模块导入一次，业务层即可直接注入配置”；`forRoot` 返回 `global: true` 的动态模块，确保跨模块可用。
- **测试可注入固定配置**：`ConfigModuleOptions.load` 与 `env` 参数使测试能绕过真实 `process.env`，注入 mock 配置。
- **Docker Compose 是部署配置的唯一入口**：`infra/docker-compose.yml` 中 `app` service 的 `environment` 块集中声明了所有运行期环境变量，并通过 `depends_on` 保证 Postgres/MinIO 健康后再启动应用。