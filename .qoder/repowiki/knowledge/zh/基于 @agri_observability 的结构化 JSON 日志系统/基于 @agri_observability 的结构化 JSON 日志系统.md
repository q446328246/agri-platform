---
kind: logging_system
name: 基于 @agri/observability 的结构化 JSON 日志系统
category: logging_system
scope:
    - '**'
source_files:
    - packages/observability/src/logger.ts
    - packages/observability/src/index.ts
    - packages/observability/package.json
    - packages/config/src/env-schema.ts
    - apps/decision-service/src/main.ts
    - apps/telemetry-service/src/main.ts
    - apps/plot-service/src/app.module.ts
    - apps/plot-service/src/main.ts
---

## 1. 使用的系统与框架

仓库没有引入第三方日志库（winston、pino、bunyan、log4js 等），而是自实现了一个轻量级的结构化日志器，封装在共享包 `@agri/observability` 中。所有业务微服务通过该包的 `LoggerService` 类统一输出日志。

日志格式为**单行 JSON**，字段固定，便于外部采集端解析与检索。日志级别采用数字权重过滤：`debug=10, info=20, warn=30, error=40`，默认级别为 `info`。

## 2. 关键文件

- `packages/observability/src/logger.ts` — 核心日志器实现，定义 `LogRecord` 结构、`LoggerService` 类、`LOG_LEVELS` 常量与 `LogLevel` 类型。
- `packages/observability/src/index.ts` — 统一导出 `logger`、`metrics`、`trace`、`collectors`、`decorators`。
- `packages/observability/package.json` — 包名 `@agri/observability`，依赖 `@nestjs/common`（用于装饰器注入）。
- `apps/*/src/main.ts` — 各微服务入口，实例化 `LoggerService` 并传入 `serviceName` 与 `level`。
- `apps/plot-service/src/app.module.ts` — NestJS 模块中将 `LoggerService` 注册为可注入的 Provider，供 Service/Controller 使用。
- `packages/config/src/env-schema.ts` — 通过 Zod 校验 `LOG_LEVEL` 环境变量，限定枚举值为 `debug|info|warn|error`，默认 `info`。

## 3. 架构与设计约定

### 3.1 结构化记录模型

每条日志对应一个 `LogRecord` 对象，字段如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `timestamp` | string (ISO) | 写入时间 |
| `level` | `debug\|info\|warn\|error` | 日志级别 |
| `service` | string | 服务名（构造时传入） |
| `message` | string | 人类可读消息 |
| `traceId` | string? | 链路追踪标识（可选） |
| `[key: string]` | unknown | 任意扩展字段（context） |

所有字段最终通过 `JSON.stringify(record)` 输出到 sink。

### 3.2 输出 Sink 与测试替换

`sink` 选项默认为 `process.stdout.write(line + '\n')`，即标准输出。构造函数允许传入自定义 `sink: (line: string) => void`，以便在单元测试中捕获日志内容而不污染控制台。

### 3.3 上下文继承与链路追踪

- `child(context, level?)` — 派生子日志器，合并 `base` 上下文，支持覆盖级别。
- `withTrace(traceId)` — 便捷方法，等价于 `child({ traceId })`。
- 注释明确要求：**所有日志必须携带服务名与链路标识**，否则跨服务排查无法串联请求。

### 3.4 级别过滤

`write()` 内部比较 `LEVEL_WEIGHT[level]` 与当前 logger 的 `LEVEL_WEIGHT[this.level]`，低于阈值的日志直接丢弃，不进入序列化流程。

### 3.5 与 NestJS 集成

`@agri/observability` 同时提供 `configureDecorators` 与 `@Loggable` 等装饰器（见 `decorators.ts`），可在方法执行前后自动打点；`plot-service` 将其作为 NestJS Provider 注入，其他服务也可按需复用。

## 4. 约定与约束

- **日志级别来源**：服务启动时从 `process.env.LOG_LEVEL` 读取，并通过 `parseLogLevel` 函数归一化为 `debug|info|warn|error` 之一，非法值回退为 `info`（见 `apps/decision-service/src/main.ts`、`apps/telemetry-service/src/main.ts`）。
- **环境变量校验**：`packages/config/src/env-schema.ts` 用 Zod schema 强制 `LOG_LEVEL` 只能取 `debug|info|warn|error`，默认 `info`。
- **结构化输出**：`logger.ts` 注释明确“日志以单行 JSON 输出，字段固定”，且 `write()` 始终调用 `JSON.stringify(record)`，因此任何非结构化输出都需绕过 LoggerService。
- **必填字段**：`LogRecord` 接口要求 `timestamp`、`level`、`service`、`message` 四个字段，由 `LoggerService.write()` 自动填充；`traceId` 可选但被注释强调为跨服务排查必需。
- **服务名绑定**：每个 `LoggerService` 实例构造时必须传入 `serviceName`，并在每条记录中固定写入，避免不同 logger 混用导致归属不清。
- **扩展字段安全**：`LogRecord` 开放索引签名 `[key: string]: unknown`，允许业务代码附加任意 context 字段，但建议仅包含可序列化的基础类型或简单对象。
- **无第三方依赖**：该日志子系统不依赖任何外部日志库，仅依赖 Node.js 内置 `process.stdout` 与 `Date`，降低运行时耦合。

## 5. 观察到的使用模式

各微服务在 `main.ts` 中统一创建 logger 并启动 HTTP 服务后记录启动信息，例如：

```ts
const logger = new LoggerService({ serviceName: "decision-service", level: parseLogLevel(process.env.LOG_LEVEL) });
server.listen(port, "127.0.0.1", () => logger.info("decision-service HTTP 已启动（SQL 持久化）", { port }));
```

NestJS 模块（如 `plot-service`）则通过 `useFactory` 将 `LoggerService` 注册为 Provider，使业务类可通过依赖注入获取 logger 实例。