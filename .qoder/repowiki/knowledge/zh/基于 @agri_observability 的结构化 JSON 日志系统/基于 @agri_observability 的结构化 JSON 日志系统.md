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
    - packages/observability/package.json
    - apps/decision-service/src/main.ts
    - apps/telemetry-service/src/main.ts
    - apps/plot-service/src/app.module.ts
    - apps/plot-service/src/main.ts
---

## 1. 使用的框架与工具

- 自研 `@agri/observability` 包提供结构化日志、指标采集、链路追踪与方法装饰器，不依赖第三方日志库（如 winston/pino/bunyan），仅依赖 `@nestjs/common`。
- 日志输出为**单行 JSON**，直接写入 `process.stdout`（测试场景可通过 `sink` 选项替换为采集函数）。
- 微服务统一通过 NestJS 模块注入 `LoggerService`，部分服务在 `main.ts` 中直接构造实例。

## 2. 核心文件与包

- `packages/observability/src/logger.ts`：定义 `LOG_LEVELS`、`LogLevel`、`LogRecord`、`LoggerOptions` 与 `LoggerService` 类。
- `packages/observability/src/decorators.ts`：`Traced` / `Metered` 方法装饰器，自动记录耗时并调用 `deps.logger.debug/error`。
- `packages/observability/src/index.ts`：统一导出 logger/metrics/trace/collectors/decorators。
- `apps/*/src/main.ts` 与各服务的 `app.module.ts`：构造 `LoggerService` 并注册到 DI 容器。

## 3. 架构与约定

### 3.1 日志记录结构

`LogRecord` 固定字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `timestamp` | string (ISO) | 记录时间 |
| `level` | `debug`\|`info`\|`warn`\|`error` | 级别 |
| `service` | string | 服务名（构造时传入） |
| `message` | string | 业务消息 |
| `traceId` | string? | 链路标识（可选） |
| `[key: string]` | unknown | 扩展上下文字段 |

所有字段以 `JSON.stringify` 序列化后换行输出，便于外部采集端解析。

### 3.2 级别策略

- 内置四级：`debug` (10)、`info` (20)、`warn` (30)、`error` (40)，数值越大越严重。
- 默认级别为 `info`；服务启动时通过 `parseLogLevel(process.env.LOG_LEVEL)` 从环境变量覆盖。
- `write` 内部按权重比较，低于当前级别的日志直接丢弃。

### 3.3 上下文与子日志器

- `child(context, level?)` 合并 base 上下文，支持派生带固定上下文的子 Logger。
- `withTrace(traceId)` 是 `child({ traceId })` 的便捷方法，用于跨服务请求串联。
- 每个 Logger 实例携带 `serviceName`、`base`、`sink`，通过构造函数注入。

### 3.4 可观测性集成

- `configureDecorators({ logger, metrics })` 将全局 logger/metrics 注入装饰器。
- `@Traced()` 自动记录方法起止耗时，成功写 debug，失败写 error，附带 `span`、`durationMs`、`reason`。
- `@Metered()` 记录 HTTP 请求时长与错误计数，标签取类名与方法名。
- 文档注释明确：**不要在循环体内使用装饰器**，否则会产生大量跨度与指标标签拖慢服务。

### 3.5 服务侧装配模式

- `decision-service`、`telemetry-service`：在 `main.ts` 中直接 `new LoggerService({ serviceName, level })`。
- `plot-service`：在 `AppModule` 中以 `provide: LoggerService, useFactory` 形式注册，并通过 `exports` 暴露给其他模块。
- 各服务均通过 `@agri/observability` 导入 `LoggerService`、`MetricsService`、`configureDecorators`。

## 4. 约定与约束

- **每条日志必须携带 `service` 与 `traceId`**：logger.ts 顶部注释明确要求“所有日志必须携带服务名与链路标识，否则跨服务排查时无法把一次请求串联起来”。
- **日志级别由 `LOG_LEVELS` 常量枚举控制**，新增级别需同时更新 `LEVEL_WEIGHT` 映射。
- **结构化字段扩展通过 `context` 参数传入**，而非拼接 message。
- **sink 默认写 stdout**，测试或生产可替换为自定义采集函数（如写入文件、远端收集器）。
- **装饰器需在应用启动时通过 `configureDecorators` 注入依赖**，否则装饰器内 `deps.logger` 为空，不会输出日志。
- **禁止在循环体中使用 `@Traced` / `@Metered`**：decorators.ts 注释显式警告会产生大量跨度与指标标签拖慢服务。