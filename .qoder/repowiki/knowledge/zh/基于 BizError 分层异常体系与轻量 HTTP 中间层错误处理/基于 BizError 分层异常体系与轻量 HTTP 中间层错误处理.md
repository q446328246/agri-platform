---
kind: error_handling
name: 基于 BizError 分层异常体系与轻量 HTTP 中间层错误处理
category: error_handling
scope:
    - '**'
source_files:
    - packages/shared/src/errors.ts
    - packages/plot-core/src/code.ts
    - packages/plot-core/src/checksum.ts
    - packages/plot-core/src/grid.ts
    - packages/plot-core/src/crs.ts
    - packages/config/src/loader.ts
    - packages/config/src/secrets.ts
    - packages/db/src/paginate.ts
    - packages/db/src/transaction.ts
    - apps/plot-service/src/http.ts
    - apps/plot-service/src/plot.service.ts
    - apps/gateway-service/src/http.ts
    - apps/file-service/src/http.ts
    - apps/file-service/src/storage.ts
---

## 1. 采用的方案

仓库没有使用 NestJS 的 `HttpException`/全局过滤器（尽管服务骨架是 NestJS，但实际运行时使用的是原生 `node:http` + 手写路由），而是自建了一个**轻量业务异常体系**：

- 统一基类 `BizError`（`packages/shared/src/errors.ts`）携带 `code: string`、`httpStatus: number` 两个字段，所有业务异常继承它。
- 派生三个常用类型：`ValidationError`（默认码 `SYS-400-001`）、`NotFoundError`（`SYS-404-001`）、`ConflictError`（`SYS-409-001`）。
- 领域包 `@agri/plot-core` 定义自己的 `PlotCodeError`，用于地块编码校验失败。
- 配置加载器 `@agri/config` 定义 `ConfigError`，携带 `issues: string[]` 问题清单，启动时直接抛出以终止进程。
- 数据库分页工具 `@agri/db` 在排序字段不在白名单时抛 `BizError("SYS-400-001", ...)`。

HTTP 层不使用框架级异常过滤器，而是在每个服务的 `src/http.ts` 中用 `try/catch` 包裹请求处理函数，把捕获到的 `Error` 转成统一的 JSON 响应体。网关 `gateway-service` 对下游不可用返回固定码 `GATEWAY-502`。

## 2. 关键文件

- `packages/shared/src/errors.ts` — `BizError` / `ValidationError` / `NotFoundError` / `ConflictError` 定义
- `packages/plot-core/src/code.ts`、`checksum.ts`、`grid.ts`、`crs.ts` — `PlotCodeError` 在各校验点抛出
- `packages/config/src/loader.ts`、`secrets.ts` — `ConfigError` 在环境变量缺失/非法时抛出
- `packages/db/src/paginate.ts`、`transaction.ts` — 基础设施层通过 `BizError` 暴露参数/事务错误
- `apps/plot-service/src/http.ts` — 业务服务统一 try/catch → `send(status, code, message, traceId, data)`
- `apps/gateway-service/src/http.ts` — 网关转发失败统一返回 `GATEWAY-502`
- 其他服务 `apps/*/src/http.ts` — 同构的 `createXxxHttpServer` + try/catch 模式

## 3. 架构与约定

### 3.1 异常分层

| 层级 | 异常类型 | 用途 | 示例位置 |
|---|---|---|---|
| 共享层 | `BizError` | 所有业务异常的根，携带 `code` + `httpStatus` | `packages/shared/src/errors.ts` |
| 共享层 | `ValidationError` / `NotFoundError` / `ConflictError` | 通用参数校验、资源不存在、状态冲突 | 同上 |
| 领域层 | `PlotCodeError` | 地块编码格式、校验位、网格行列号等校验失败 | `packages/plot-core/src/*.ts` |
| 配置层 | `ConfigError` | 环境变量缺失或类型不合法，附带 `issues[]` | `packages/config/src/loader.ts` |
| 基础设施层 | `BizError`（复用） | 分页排序字段越界、事务模型不存在 | `packages/db/src/*.ts` |

### 3.2 错误码规范

错误码采用 **`<域>-<HTTP状态>-<序号>`** 三段式字符串：

- `SYS-400-001`：系统级参数校验失败（`ValidationError`、分页 sortBy 白名单）
- `SYS-404-001`：资源未找到（`NotFoundError`）
- `SYS-409-001`：状态冲突（`ConflictError`）
- `PLOT-409-001`：地块编码重复（`plot.service.ts` 中覆盖默认码）
- `PLOT-404-001`：地块不存在（`plot.service.ts` 中覆盖默认码）
- `GATEWAY-502`：网关下游不可用（`gateway-service`）
- `GATEWAY-404`：网关路由未匹配（`gateway-service`）

### 3.3 HTTP 响应结构

所有服务通过 `send(response, status, data, requestTraceId, message)` 输出统一结构：

```json
{
  "code": "OK" | "PLOT-400" | "GATEWAY-502" | ...
  , "message": "..."
  , "data": null | T
  , "traceId": "x-request-id"
  , "timestamp": 171...
}
```

`traceId` 从请求头 `x-request-id` 透传，缺失时由 `crypto.randomUUID()` 生成；网关会透传上游的 `x-request-id`、`x-tenant-id`、`x-user-id`、`x-confirm-action` 到下游。

### 3.4 服务内错误传播

各业务服务（auth/control/file/finance/iot/message/operation/platform/video/weather 等）的 `http.ts` 遵循同一模板：

```ts
export function createXxxHttpServer(...): Server {
  return createServer(async (req, res) => {
    const traceId = trace(req);
    try { /* 路由处理 */ }
    catch (error) {
      send(res, 400, null, traceId, error instanceof Error ? error.message : "请求处理失败");
    }
  });
}
```

`plot-service` 是唯一例外：其 catch 分支根据 `error.message` 是否包含“不存在”来区分 404 与 400，属于硬编码判断而非基于 `instanceof BizError` 的类型分发。

### 3.5 网关错误处理

`gateway-service` 对下游调用失败统一返回：

```json
{"code":"GATEWAY-502","message":"下游服务不可用","data":null,"timestamp":...}
```

未匹配路由返回 `GATEWAY-404`。网关本身不解析下游的业务错误码，只是透传下游原始响应体（成功路径）或包装为 502（失败路径）。

## 4. 约定与约束

- **业务异常必须继承 `BizError`**：`BizError` 的注释明确说明“所有业务异常继承自统一基类并携带错误码，全局异常过滤器只需判断一次类型”，这是设计意图；当前各服务确实通过 `throw new NotFoundError(...)`、`throw new ConflictError(...)` 等方式使用。
- **错误码采用 `<域>-<状态>-<序号>` 三段式**：观察到的 `SYS-*`、`PLOT-*`、`GATEWAY-*` 均符合该模式，且 `plot.service.ts` 显式传入自定义码（如 `PLOT-409-001`）覆盖默认值。
- **HTTP 层统一通过 `send()` 输出 ApiResponse**：除 `gateway-service` 外，所有业务服务都使用 `send(response, status, data, traceId, message)`，保证响应体结构一致。
- **traceId 透传**：每个服务从 `x-request-id` 读取，缺失则生成 UUID；网关将 `x-request-id`、`x-tenant-id`、`x-user-id`、`x-confirm-action` 透传给下游。
- **分页 sortBy 必须走白名单**：`paginate.ts` 注释明确说明“直接把前端传入的字段拼入排序会形成注入面”，实现上通过 `allowedSortFields` 白名单校验，否则抛 `BizError("SYS-400-001", ...)`。
- **配置校验失败即终止启动**：`loadConfig` 在 `envSchema.safeParse` 失败时直接 `throw new ConfigError(issues)`，没有降级逻辑，部署脚本可据此预检。
- **文件存储层的 ENOENT 被吞掉**：`file-service/storage.ts` 的 `get` 对 `ENOENT` 返回 `null`，`delete` 对 `ENOENT` 静默忽略，其余错误向上抛出——这是一种针对文件系统语义的特判，不是通用的错误转换策略。
- **未观察到 panic/recover 或 NestJS 全局异常过滤器**：仓库使用原生 `node:http`，错误通过 `try/catch` 在每层手动捕获，没有 `process.on('uncaughtException')` 或 `process.on('unhandledRejection')` 的全局兜底。