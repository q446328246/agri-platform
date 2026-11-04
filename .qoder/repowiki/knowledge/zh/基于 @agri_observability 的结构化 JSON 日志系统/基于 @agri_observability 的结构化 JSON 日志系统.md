---
kind: logging_system
name: 基于 @agri/observability 的结构化 JSON 日志系统
category: logging_system
scope:
    - '**'
source_files:
    - packages/observability/src/logger.ts
    - packages/observability/src/decorators.ts
    - packages/observability/src/index.ts
    - packages/config/src/env-schema.ts
    - apps/plot-service/src/main.ts
    - apps/decision-service/src/main.ts
    - apps/telemetry-service/src/main.ts
---

## 1. 使用的系统与框架

仓库没有引入第三方日志库（如 winston、pino、log4js），而是自实现了一个轻量级的结构化日志器 `LoggerService`，位于公共包 `@agri/observability` 中。所有日志以**单行 JSON** 输出到标准输出（`process.stdout`），由外部采集端解析。

核心类型与常量定义在 `packages/observability/src/logger.ts`：
- `LOG_LEVELS = ["debug", "info", "warn", "error"] as const`
- `LEVEL_WEIGHT` 将级别映射为数值（debug=10, info=20, warn=30, error=40）用于过滤
- `LogRecord` 固定字段：`timestamp`、`level`、`service`、`message`，以及可选的 `traceId` 和任意扩展字段 `[key: string]: unknown`

## 2. 关键文件

- `packages/observability/src/logger.ts` — `LoggerService` 实现，包含级别过滤、上下文继承、sink 注入
- `packages/observability/src/decorators.ts` — `Traced` / `Metered` 装饰器，自动记录方法耗时并写入结构化日志
- `packages/observability/src/index.ts` — 统一导出 logger/metrics/trace/collectors/decorators
- `packages/config/src/env-schema.ts` — 通过 Zod 校验 `LOG_LEVEL`，枚举值限定为 `debug|info|warn|error`，默认 `info`
- `apps/*/src/main.ts` — 各微服务入口构造 `LoggerService` 并调用 `configureDecorators({ logger, metrics })`

## 3. 架构与约定

### 3.1 实例化与依赖注入
每个微服务的 `main.ts` 负责创建 `LoggerService` 实例，传入 `serviceName` 与 `level`（来自配置或环境变量），然后通过 `configureDecorators` 把 logger 注入给装饰器使用。例如 `plot-service`：
```ts
const logger = new LoggerService({ serviceName: appConfig.serviceName, level: appConfig.logLevel });
configureDecorators({ logger, metrics });
```

### 3.2 结构化字段约定
每条日志都是单行 JSON，固定字段包括：
- `timestamp`: ISO 8601 字符串
- `level`: debug/info/warn/error
- `service`: 服务名（构造时传入）
- `message`: 人类可读消息
- `traceId`: 可选链路标识
- 其余字段由 `base` 与调用方传入的 context 合并而来

logger.ts 注释明确约束：“所有日志必须携带服务名与链路标识，否则跨服务排查时无法把一次请求串联起来”。

### 3.3 子日志器与链路追踪
- `child(context, level?)` 派生子 logger，继承 `serviceName`、`sink`，合并 `base` 上下文，可覆盖级别
- `withTrace(traceId)` 是 `child({ traceId })` 的便捷方法，用于在一次请求内传递链路 ID
- `Traced` 装饰器在每个方法执行前后自动写入 `span`、`durationMs` 等字段的 debug/error 日志

### 3.4 Sink 抽象
`sink` 参数默认指向 `process.stdout.write(line + '\n')`，测试中可替换为收集函数，便于断言日志内容。

### 3.5 级别策略
- 应用层通过 `parseLogLevel(process.env.LOG_LEVEL)` 或配置的 `appConfig.logLevel` 设置初始级别
- `packages/config` 用 Zod schema 强制 `LOG_LEVEL` 只能取 `debug|info|warn|error`，默认 `info`
- `LoggerService.write` 内部按 `LEVEL_WEIGHT` 比较，低于当前级别的日志直接丢弃

## 4. 约定与约束

- **输出格式**：日志必须是单行 JSON，字段遵循 `LogRecord` 接口（logger.ts 注释“日志以单行 JSON 输出，字段固定”）。
- **必填字段**：每条日志必须包含 `service` 与 `traceId`（logger.ts 注释“所有日志必须携带服务名与链路标识”）。
- **级别枚举**：仅允许 `debug | info | warn | error`，由 `LOG_LEVELS` 常量与 `packages/config/src/env-schema.ts` 中的 Zod schema 共同约束。
- **初始化位置**：各服务在 `main.ts` 启动阶段构造 `LoggerService` 并调用 `configureDecorators`，装饰器才能正常工作（decorators.ts 中通过模块级 `deps` 对象注入）。
- **装饰器使用限制**：decorators.ts 注释明确警告“不要在循环体内使用，否则会产生大量跨度与指标标签，反而拖慢服务”。
- **默认落点**：未自定义 `sink` 时写标准输出；测试可通过注入 sink 捕获日志。

## 5. 与其他横切能力的关系

`@agri/observability` 同时提供 Metrics、Trace、Collectors 与 Decorators，它们共享同一套上下文标识（index.ts 注释“日志、链路与指标三者共享同一套上下文标识，保证一次请求可被完整串联”）。`Traced` 装饰器既打日志也配合 Trace 能力，`Metered` 装饰器打指标，二者常成对使用。