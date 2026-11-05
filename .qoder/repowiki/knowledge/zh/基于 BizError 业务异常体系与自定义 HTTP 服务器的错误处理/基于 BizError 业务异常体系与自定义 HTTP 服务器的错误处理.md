---
kind: error_handling
name: 基于 BizError 业务异常体系与自定义 HTTP 服务器的错误处理
category: error_handling
scope:
    - '**'
source_files:
    - packages/shared/src/errors.ts
    - packages/plot-core/src/error.ts
    - packages/config/src/loader.ts
    - packages/db/src/paginate.ts
    - packages/db/src/with-transaction.ts
    - apps/gateway-service/src/http.ts
    - apps/auth-service/src/http.ts
---

## 1. 总体方案

仓库未使用 NestJS 的 `HttpException`/`@Catch` 过滤器（各微服务仅用 Node.js 原生 `http.createServer`），而是自建了一套轻量级错误模型：
- 所有**业务异常**继承 `packages/shared/src/errors.ts` 中的 `BizError`，携带稳定错误码 `code`、HTTP 状态码 `httpStatus`。
- 领域层在各自包内定义更具体的子类（如 `PlotCodeError`），统一通过 `BizError` 向上冒泡。
- 每个服务的 `src/http.ts` 自行构造响应体 `{ code, message, data, timestamp }`，并在顶层 `try/catch` 中兜底捕获未处理异常。
- 配置校验失败使用独立的 `ConfigError extends Error`（非业务异常），用于启动期终止进程。
- 数据库事务包装器 `withTransaction` 内置对并发冲突/死锁的可重试逻辑，按错误 message/code 匹配模式决定是否重试。

## 2. 关键文件

- `packages/shared/src/errors.ts` — 业务异常基类 `BizError` 及 `ValidationError` / `NotFoundError` / `ConflictError` 三个常用子类。
- `packages/plot-core/src/error.ts` — 领域异常 `PlotCodeError extends BizError`，默认码 `PLOT-422-001`。
- `packages/config/src/loader.ts` — 配置加载与 `ConfigError`，抛出包含 `issues: string[]` 的问题清单。
- `packages/db/src/paginate.ts` — 分页工具抛 `BizError("SYS-400-001", ...)` 表示排序字段非法。
- `packages/db/src/with-transaction.ts` — 事务包装器，定义 `RETRYABLE_PATTERNS = ["P2034","40001","40P01","deadlock","serialization"]`，指数退避重试。
- `apps/gateway-service/src/http.ts` — 网关统一响应格式 `reply(response, status, code, message)`，下游不可用返回 `GATEWAY-502`。
- `apps/auth-service/src/http.ts` — 认证服务自实现路由、鉴权与响应封装 `send(res, status, data, traceId, message)`，顶层 catch 返回 400。

## 3. 架构与约定

### 3.1 异常类型层次
```
Error
├── BizError (shared)
│   ├── ValidationError (SYS-400-001, httpStatus=400)
│   ├── NotFoundError (SYS-404-001, httpStatus=404)
│   ├── ConflictError (SYS-409-001, httpStatus=409)
│   └── PlotCodeError (plot-core, PLOT-422-001, httpStatus=422)
└── ConfigError (config, 非 BizError，用于启动期)
```
`BizError` 构造函数固定设置 `this.name` 与 `Object.setPrototypeOf(this, new.target.prototype)`，保证子类 instanceof 链正确。

### 3.2 错误码命名规范
- 系统级：`SYS-<HTTP>-NNN`（如 `SYS-400-001`）。
- 领域级：`<DOMAIN>-<HTTP>-NNN`（如 `PLOT-422-001`）。
- 网关级：`GATEWAY-<HTTP>`（如 `GATEWAY-404`、`GATEWAY-502`）。
- 认证服务：`AUTH-<HTTP>`（由 `send` 根据 status 自动前缀）。

### 3.3 HTTP 响应体结构
网关与服务统一返回 JSON：
```json
{"code": "...", "message": "...", "data": null|T, "timestamp": number}
```
网关额外在成功健康检查时返回 `{ code: "OK", data: { status, service }, timestamp }`。

### 3.4 可重试事务策略
`withTransaction` 仅在以下特征匹配时重试：错误对象的 `code` 或 `message`（小写）包含 `P2034`、`40001`、`40P01`、`deadlock`、`serialization`。其余错误直接上抛，避免放大业务异常。重试次数默认 2，基础退避 20ms，按 `baseBackoffMs * 2^(attempt-1)` 指数增长。

### 3.5 网关的错误传播
网关不解析下游业务错误码，直接将下游原始 body + 状态码透传给客户端；仅当 `fetch` 本身抛错（网络/超时等）时转为 `GATEWAY-502`。

## 4. 约定与约束

- **业务异常必须继承 `BizError`**：`errors.ts` 注释明确说明“所有业务异常继承自统一基类并携带错误码，全局异常过滤器只需判断一次类型”，这是共享包的文档化约定。
- **领域异常不得绕过 `BizError`**：`PlotCodeError` 继承 `BizError` 的注释写明“便于全局异常过滤器统一识别”。
- **排序字段必须走白名单校验**：`paginate.ts` 注释声明“排序字段必须命中服务端白名单……直接把前端传入的字段拼入排序会形成注入面”，并通过 `throw new BizError("SYS-400-001", ...)` 强制拒绝非法字段。
- **事务只重试并发相关错误**：`with-transaction.ts` 注释“只重试由并发冲突与死锁引起的错误……业务错误重试只会放大问题，因此一律直接抛出”，并由 `RETRYABLE_PATTERNS` 常量与 `isRetryable` 函数强制执行。
- **配置校验失败即终止启动**：`loadConfig` 注释“失败即抛出 ConfigError 终止启动”，调用方无分支处理，属于启动期不变式。
- **网关丢弃客户端身份头**：`gateway-service/src/http.ts` 注释“客户端自带的 `x-user-id` / `x-tenant-id` / `x-permissions` 一律丢弃，避免越权”，仅使用网关解析后的 session 值。
- **认证服务内部接口需凭证**：`auth-service/src/http.ts` 通过 `INTERNAL_TOKEN` 环境变量校验 `x-internal-token` 请求头，否则返回 401。

## 5. 观察到的不足

- 各服务 `http.ts` 的顶层 `catch` 将未分类异常统一映射为 400 或 502，没有区分 `BizError` 与其他运行时错误，导致业务异常码无法被上层统一消费（与 `BizError` 设计初衷存在偏差）。
- 未发现仓库范围的 ESLint/TSC 规则强制要求使用 `BizError`，该约束目前依赖代码审查与注释约定而非构建期检查。