---
kind: error_handling
name: 基于 BizError 分层与 HTTP try/catch 的轻量错误处理体系
category: error_handling
scope:
    - '**'
source_files:
    - packages/shared/src/errors.ts
    - apps/auth-service/src/http.ts
    - apps/plot-service/src/http.ts
    - apps/plot-service/src/plot.service.ts
    - apps/gateway-service/src/http.ts
    - apps/file-service/src/storage.ts
    - packages/db/src/paginate.ts
    - packages/db/src/transaction.ts
    - packages/plot-core/src/error.ts
---

## 1. 采用的系统/方案

仓库没有引入 NestJS 的 HttpException 或 Express/Koa 的全局异常过滤器，而是采用自研业务异常基类 + 每个微服务 HTTP 层 try/catch 的轻量方案：
- 统一异常定义集中在 packages/shared/src/errors.ts，提供 BizError 基类以及 ValidationError、NotFoundError、ConflictError 三个常用子类。
- 所有业务代码通过 throw new XxxError(message, code) 抛出；HTTP 层在 createXxxHttpServer 的顶层 catch 中捕获并转换为统一的 ApiResponse JSON 响应。
- 网关 (apps/gateway-service) 对下游不可用单独返回 GATEWAY-502，不依赖被代理服务的错误码。

## 2. 关键文件与包

- packages/shared/src/errors.ts — 定义 BizError、ValidationError、NotFoundError、ConflictError 及 ErrorDetail 类型。
- apps/*/src/http.ts — 各微服务（auth/control/file/finance/iot/message/operation/plot 等）的 HTTP 入口，统一实现 traceId 提取、send 响应封装、请求体解析和顶层 catch。
- apps/plot-service/src/plot.service.ts — 业务层抛出自定义领域错误（如 PLOT-409-001、PLOT-404-001）的典型示例。
- apps/gateway-service/src/http.ts — 反向代理网关的错误处理，将下游异常统一映射为 GATEWAY-502。
- packages/db/src/paginate.ts、packages/db/src/transaction.ts — 基础设施层也使用 @agri/shared 的 BizError。
- packages/plot-core/src/error.ts — 地块领域核心包同样继承 BizError，说明该异常体系是跨包共享契约。

## 3. 架构与约定

### 3.1 异常层次
Error 基类之上定义 BizError(code: string, httpStatus: number)，其下派生 ValidationError（默认 SYS-400-001）、NotFoundError（默认 SYS-404-001）、ConflictError（默认 SYS-409-001）。BizError 构造函数显式设置 this.name 并通过 Object.setPrototypeOf(this, new.target.prototype) 修复子类 instanceof 链，使上层 catch 能正确识别具体子类。

### 3.2 错误码命名约定
- 通用错误码前缀：SYS-xxx-yyy（errors.ts 注释“与契约包错误码定义保持一致”）。
- 领域服务自定义错误码：PLOT-409-001、PLOT-404-001 等，以 <SERVICE>-<HTTP_CODE>-<SEQ> 形式组织。
- 网关错误码：GATEWAY-404、GATEWAY-502。
- 其他服务在 http.ts 中按 "<SERVICE>-<status>" 动态拼接，例如 AUTH-${status}、PLOT-${status}。

### 3.3 HTTP 响应格式
所有服务统一返回 ApiResponse<T>（来自 @agri/contracts），结构为 { code, message, data, traceId, timestamp }。traceId 优先取自请求头 x-request-id，否则生成 UUID，贯穿整个请求链路。

### 3.4 全局异常转换策略
- 普通微服务（auth/control/file/finance/iot/message/operation 等）：catch 中一律返回 400，message 取 error.message。
- plot-service 特殊化：根据消息文本判断 message.includes("不存在") ? 404 : 400，属于按语义回退而非类型判断。
- gateway-service：catch 中固定返回 502 + GATEWAY-502 错误码。

### 3.5 事务与 Outbox 中的错误传播
plot.service.ts 使用 Prisma withTransaction 包裹数据写入与 outbox 投递；若业务校验失败（如重复编码）直接抛 ConflictError，事务会回滚，错误继续向 HTTP 层冒泡。

## 4. 观察到的约定与约束

- 业务异常必须继承 BizError：errors.ts 注释明确“所有业务异常继承自统一基类并携带错误码”，且 ValidationError/NotFoundError/ConflictError 均如此实现。
- 错误码必须随 BizError 构造传入：基类要求 (code, message, httpStatus?)，子类通过默认值覆盖（如 SYS-404-001），业务层可覆盖为领域码（如 PLOT-404-001）。
- HTTP 层必须提供 /health 健康检查：所有 http.ts 都包含 GET /health 返回 { status: "ok", service: "<name>" }。
- 请求体解析失败统一抛 new Error("请求体必须是 JSON 对象")：多个服务的 readJson/json 函数使用完全相同的校验逻辑。
- 下游存储/网络错误向上抛出原始 Error：file-service/storage.ts 中 MinIO 调用失败时 throw new Error(...)，由 HTTP 层 catch 转为 400。
- 网关对下游异常不做透传：无论下游返回什么状态，gateway 自身 catch 后固定返回 502 + GATEWAY-502，避免把内部细节暴露给上游。
- 未找到资源在 plot-service 中通过字符串匹配降级：message.includes("不存在") 判断返回 404，这是一种非类型安全的回退约定，仅在该服务生效。

## 5. 缺失/不一致点

- 并非所有服务都使用 BizError 子类：plot-service 的 plot.consumer.ts、plot.service.ts 中仍出现裸 throw new Error(...)（如面积非法、中继后未找到记录），这些不会被 http.ts 的 message.includes("不存在") 判定为 404，而是落入 400。
- 部分服务（如 decision-service、telemetry-service、trace-service）的 http.ts 使用 try/catch 但内部未见到 @agri/shared 的异常导入，可能仍抛裸 Error。
- 没有统一的 API 错误码枚举或常量表，错误码散落在业务代码中（PLOT-409-001、SYS-404-001、GATEWAY-502 等）。
- 前端 apps/web/src/utils/request.ts 未在本文范围内验证是否消费了统一的 code 字段做错误展示。

总体而言，这是一个以 @agri/shared 的 BizError 为中心、由各微服务 HTTP 层自行 try/catch 兜底的轻量错误处理模式，适合当前规模较小的 Node.js 微服务集合，但在错误码集中化和领域异常覆盖率上仍有提升空间。