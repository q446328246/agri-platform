---
trigger: glob
glob: apps/*-service/**/*.ts
---

# 后端微服务专项规范

适用于 `apps/*-service` 的 TypeScript 代码。

## HTTP 入口与权限

- 路由统一写在 `src/http.ts`；`/health` 分支必须最先处理。
- `/health` 之后、业务路由之前调用 `@agri/shared` 的 `authorizeRequest(request, policy)`；policy（`AuthzPolicy`，见 `packages/shared/src/authz.ts`）声明 read/write 权限码及 `publicPaths` / `callbackPaths`（设备/算法回调，认 `x-device-token`）/ `sessionPaths` / `pathPermissions` 覆盖项。
- 权限码单一真相源：`packages/contracts/src/authz/permissions.ts` 的 `PERMISSION_CATALOG`；新增权限码只改该目录，platform-service 与前端引用同一份，禁止各处自造字符串。
- `/api/v1/internal/*` 内部接口只靠 `x-internal-token`（`INTERNAL_TOKEN`）保护，且必须登记在所属服务 policy 的 `publicPaths` 中，否则 enforce 模式下网关调用会被自家守卫 401 拦截。
- 服务侧守卫默认关闭（`AUTH_GUARD_MODE` 未设置即放行），对外拦截由网关承担；不得默认开启服务侧强制鉴权（会破坏服务间直连与冒烟脚本）。

## 组合根与仓储

- 仓储装配只在 `src/main.ts`，两种等价写法：`const sql = Boolean(process.env.DB_URL) && process.env.<XXX>_REPOSITORY_MODE !== "memory"` 或 `const mode = process.env.<XXX>_REPOSITORY_MODE === "memory" || !process.env.DB_URL ? "memory" : "sql"`；SQL 侧统一 `PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL))`（来自 `@agri/db`）。
- **例外 plot-service**：默认内存，须显式 `PLOT_REPOSITORY_MODE=sql` 才启用 SQL（`=== "sql" ? "sql" : "memory"`），且经 `PrismaService` 注入 `PgClientAdapter.fromUrl(appConfig.db.url)`，不走 resolveDatabaseUrl。
- 每个仓储提供 `Sql*Repository` 与 `InMemory*Repository` 双实现；`InMemory*Repository` 构造函数默认值不得塞演示种子（repository.spec 直接 new 后断言汇总数），演示条目在 main.ts 显式注入。
- 禁止把内存客户端注入 SQL 仓储（会导致列表 400 且写入不落库）。

## 错误处理与参数校验

- 业务异常优先抛 `@agri/shared` 的 `BizError` 体系（`ValidationError` 400 / `NotFoundError` 404 / `ConflictError` 409，自带 httpStatus），由 http.ts 的 try/catch 统一转 HTTP 响应；现状 file/plot 服务已接入，其余多数服务仍是 catch 后统一回 400 + message（operation 用本地 InputError），改造时向 BizError 收敛，不得新增裸 throw 字符串。
- 非法枚举查询参数直接返回 400，禁止静默筛空数据；前后端筛选参数命名与逻辑严格一致。
- 农事任务类型白名单六码：`TILLAGE / SEEDING / IRRIGATION / WEEDING / SPRAYING / FERTILIZATION`，非法类型返回 400。
- 环境变量解析函数（如 `buildQWeatherFromEnv`）必须容错：缺凭据/配置不满足时返回 undefined 由调用方跳过功能，可能抛错的构造（如 createQWeatherClient）用 try/catch 包裹后降级，严禁因配置错误导致服务启动崩溃。

## 数据映射与外部调用

- PostgreSQL 时间列读写统一用 `@agri/shared` 的 `toIsoTimestamp`（ISO 8601 UTC 字符串）；禁止对 pg 驱动的 JS Date 直接 `String()` 序列化后写回。
- URL 拼接查询参数前检查 path 是否已含 `?`：有则用 `&` 连接，否则用 `?`，防止双问号 400。
- 外部 API 失败必须解析并透传响应体错误字段（如 `error.title` / `error.detail`），不得只抛裸 HTTP 状态码。
- 气象服务：前端端点（forecast/hourly/advice/alerts）只查本地表 `weather_forecasts` / `weather_forecast_hours` / `weather_alerts`；外部和风天气数据仅由 `sync.ts` 定时同步器拉取落库，禁止在请求路径直连外部 API。