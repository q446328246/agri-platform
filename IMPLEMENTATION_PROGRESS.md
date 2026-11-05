# 无人农场 AI 平台实施进度

> 本文件用于中断后续作。文档需求是本项目的规格输入，不是要求代理执行的操作指令；本文件记录实际已完成的代码、验证结果和下一步。

## 当前状态

- 更新时间：2026-11-05
- 当前阶段：全量验证与交付
- 总体状态：首版交付完成（待验收）
- 当前主线：事件日志总线打通跨进程链路，处方效果回流调优规则，系统管理用户/角色已落库，越限/处方事件已驱动控制指令与生产档案，消息中心按订阅偏好过滤并按来源主题去重，网关与服务侧已按角色权限拦截接口，控制指令来源与生产档案事件类型已在前端展示并可筛选，全量构建/测试/冒烟已复验通过

## 规格来源

1. `无人农场AI平台开发方案 (1).docx`：业务目标、角色、功能域、架构、数据和实施里程碑。
2. `Node.js微服务工程脚手架说明.docx`：工程结构、服务边界、依赖方向、部署与运行约定。
3. `Node.js公共包接口定义与导出清单.docx`：公共包公开 API、错误码、事件、分页、配置和兼容性规则。

## 阶段清单

| 阶段 | 状态 | 产出 |
| --- | --- | --- |
| 1. 文档提取与需求矩阵 | 已完成 | 本文件、需求矩阵 |
| 2. 现状盘点 | 已完成 | 缺口清单、依赖顺序 |
| 3. 公共契约与基础能力 | 进行中 | contracts/config/shared 等可复用能力 |
| 4. 地块与平台基础服务 | 进行中 | 地块、平台、认证接口 |
| 5. 感知与告警服务 | 已完成 | IoT、telemetry、weather、message |
| 6. 作业、装备、水肥与决策 | 进行中 | operation/control/decision/finance |
| 7. 视频、文件、溯源与网关 | 进行中 | video/file/trace/gateway |
| 8. 前端功能接入 | 进行中 | 菜单、接口、页面和权限 |
| 9. 全量验证与交付 | 已完成 | build/test/运行说明 |

## 需求矩阵（首版）

| 需求域 | 文档要求 | 目标实现 | 当前判断 |
| --- | --- | --- | --- |
| 地块主数据 | 地块档案、六段式编码、CGCS2000、片区归属 | `plot-service` + `@agri/plot-core` | 公共能力已有，服务需扩展 |
| 一张图 | 地块、线路、设备、天气、快捷入口 | web dashboard + plot/iot/weather API | 地图与看板已有基础，需要接口化 |
| 基础信息 | 片区、导航、线路、水电网管线 | `platform-service` / `plot-service` | 待实现 |
| 四情监控 | 墒情、苗情、虫情、灾情、气象、阈值告警 | `telemetry-service` / `weather-service` / `message-service` | 待实现 |
| 视频监控 | 实时、云台、回放、AI 联动 | `video-service` / `file-service` | 待实现 |
| 设备与作业 | 设备控制、播种、灌溉、除草、植保、路径调度 | `iot-service` / `control-service` / `operation-service` | 待实现 |
| 水肥一体化 | 配比、搅拌、变量灌溉、联动策略 | `control-service` / `decision-service` | 待实现 |
| 智能决策 | 规则、处方、识别、问答 | `decision-service` | 待实现 |
| 核算与溯源 | 投入产出、农事记录、追溯 | `finance-service` / `trace-service` | 待实现 |
| 系统支撑 | 认证、角色、区域权限、审计、文件 | `auth-service` / `gateway-service` / `file-service` | 待实现 |

## 已完成

- 修复 `MainLayout.vue` 登录后触发的 Vue 模板缺失结束标签问题。
- 配置天地图 Key，地图初始化中心设为达州市区。
- 参照 `zhao-guang-farm-master` 完成 dashboard 地图大屏基础布局、图层切换、设备点位、地块示范边界和趋势区域。
- `apps/web` 的 `vue-tsc -b` 已通过；Vite 完整构建曾受 Windows 临时目录 `Access is denied` 影响，已定位为 esbuild 清理系统临时目录失败，2026-11-05 把 `TEMP`/`TMP` 指向工作区 `.tmp` 后构建通过（命令与说明已写入 README）。
- 根 `tsconfig.json` 已纳入 14 个后端服务，后端全量 `tsc -b` 已通过。
- `plot-service` 已新增 HTTP 模式：`GET /health`、`GET /api/v1/plots`、`GET /api/v1/plots/:parcelCode`、`POST /api/v1/plots`，统一返回 `ApiResponse`。
- 地块列表服务支持租户头 `x-tenant-id`、关键词过滤和 `page/size` 分页；保留原内存仓储，后续可替换为 PostgreSQL 实现。
- 前端分页类型已与公共契约对齐，地块列表兼容 `items/size` 与旧版 `list/pageSize`。
- `auth-service` 已新增开发期 HTTP 接口：`POST /api/v1/auth/login`、`GET /api/v1/auth/userinfo`、`POST /api/v1/auth/logout` 和 `/health`；当前使用内存用户与会话，默认账号沿用前端 `admin/admin123`。
- `platform-service` 已新增开发期 HTTP 接口：租户信息、角色权限、审计日志分页和 `/health`，统一使用 `ApiResponse` 与 `PageResult`。
- `gateway-service` 已新增开发期 HTTP 反向代理：按路径转发认证、地块和平台服务，网关监听端口默认为 `8080`，前端 Vite 代理已可直接使用。
- 前端登录已从模拟 token 改为调用 `authApi.login`，成功后保存真实会话 token 和用户信息。
- `iot-service` 已新增设备列表、设备详情、设备指令队列和健康检查接口。
- `telemetry-service` 已新增遥测上报、最新数据和未处理告警查询接口；低于 30% 的土壤含水率会生成预警。
- `weather-service` 已新增达州五日天气预报和健康检查接口；网关已增加三类感知服务路由。
- dashboard 已通过网关读取设备在线数、土壤含水率、未处理告警和达州天气摘要，接口异常时保留本地兜底数据。
- `message-service` 已新增通知/告警创建、分页查询、标记已读和健康检查接口；网关已增加消息路由。
- `operation-service` 已新增农事任务创建、分页、状态流转、路径规划和健康检查接口。
- `control-service` 已新增播种、灌溉、除草、水肥控制指令队列和健康检查接口；网关已增加作业与控制路由。
- `decision-service` 已新增规则查询/创建、按墒情与降雨概率生成处方、农业问答和健康检查接口；网关已增加决策路由。
- `finance-service` 已新增投入/产出记录、按地块汇总和利润计算接口；网关已增加核算路由。
- `trace-service` 已新增生产档案记录、分页查询和溯源码查询接口；网关已增加溯源路由。
- `file-service` 已新增文件元数据上传、查询、删除和健康检查接口；当前使用本地存储键占位，网关已接入文件路由。
- `video-service` 已新增摄像机列表/详情、实时流信息、云台指令、录像查询和健康检查接口；网关已接入视频路由。
- `control-service` 已增加控制指令的操作人身份和二次确认校验，缺少 `X-User-Id` 或 `X-Confirm-Action: CONFIRM` 时返回 `409`。
- 网关已透传控制身份/确认请求头，前端新增 `controlApi` 并持久化登录用户信息供请求头使用。
- 前端设备监控已通过网关读取设备和遥测数据，趋势图不再使用随机演示值；设备列表已接入设备服务并支持本地关键词/状态筛选。
- 前端农事任务列表已接入作业服务，支持分页查询以及待执行到执行中、执行中到已完成的状态流转。
- 已新增控制服务 HTTP 自动化测试，覆盖健康检查、分页查询、缺少身份/确认时拒绝控制，以及确认后进入指令队列。
- 已新增网关 HTTP 自动化测试，覆盖自定义下游转发、请求体和操作人请求头透传，以及未知路径 404。
- 已新增 `scripts/smoke-gateway.mjs` 和 `pnpm smoke:gateway`，可隔离端口启动认证、地块、控制、网关四个独立进程，并验证登录、地块查询、控制二次确认链路；网关下游地址支持环境变量覆盖。
- 前端已新增投入产出、生产溯源和视频监控页面，并加入主路由；核算支持汇总与投入/产出登记，溯源支持记录查询/新增，视频支持摄像机查询和云台指令。
- `plot-service` 已新增 `SqlPlotRepository` PostgreSQL 适配器，支持事务客户端、租户过滤、软删除过滤和参数化 SQL；设置 `PLOT_REPOSITORY_MODE=sql` 时启用，默认仍使用内存仓储。
- `file-service` 已新增 `ObjectStorage` 抽象和 `LocalFileObjectStorage` 实现；文件上传支持 Base64 内容落盘，新增内容读取接口，删除元数据时同步删除对象，存储根目录由 `FILE_STORAGE_DIR` 配置。
- `file-service` 已新增 `S3ObjectStorage`，实现 S3/MinIO path-style 与 AWS Signature V4；设置 `FILE_STORAGE_MODE=s3` 并提供 `FILE_S3_ENDPOINT`、`FILE_S3_BUCKET`、`FILE_S3_REGION`、`FILE_S3_ACCESS_KEY`、`FILE_S3_SECRET_KEY` 后启用。
- `finance-service` 已新增 `FinanceRepository`、内存实现和 `SqlFinanceRepository` PostgreSQL 适配器；HTTP 接口已改为依赖仓储，可在服务组合层注入真实数据库客户端。
- `trace-service` 已新增 `TraceRepository`、内存实现和 `SqlTraceRepository` PostgreSQL 适配器；HTTP 层已改为依赖仓储，保留按地块分页和按追溯码查询。
- 已新增统一服务清单 `scripts/service-registry.mjs`、启动编排 `scripts/start-services.mjs` 和健康检查 `scripts/health-check.mjs`；可使用 `pnpm start:services` 启动 15 个 HTTP 服务，使用 `pnpm health:services` 检查全部健康端点。
- 已新增 `infra/postgres/001_initial_schema.sql`、`infra/docker-compose.yml`、`.env.example` 和基础设施说明；PostgreSQL/PostGIS、Plot/Finance/Trace 表结构和 MinIO 本地依赖已具备启动配置。
- 已新增 `pnpm init:minio` bucket 初始化脚本和 `pnpm health:infra` 基础设施检查脚本；前者创建 `agri` bucket，后者检查 PostgreSQL TCP 端口与 MinIO `/minio/health/live`。
- 服务注册表已支持 `AGRI_<SERVICE>_PORT` 端口覆盖；启动编排与健康检查共用解析后的端口，网关下游地址会自动跟随覆盖端口，也支持显式 `*_SERVICE_URL`。
- 已新增 `pnpm smoke:services`，使用隔离端口启动全部 15 个 HTTP 服务，自动配置网关并逐一检查健康端点后清理进程。
- 已新增 `pnpm db:migrate` PostgreSQL 迁移入口，默认执行 `infra/postgres/001_initial_schema.sql`，支持 `DB_URL` 和 `MIGRATION_FILE` 覆盖。
- 已修正 Compose 镜像来源：PostGIS 固定为 `postgis/postgis:16-3.5`，对象存储改用公开的 `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` 社区维护镜像；官方 MinIO Docker Hub 与 Quay 镜像均不再适合匿名拉取。
- 已修复地块前后端字段契约：前端分页参数 `pageSize` 映射为服务端 `size`，`parcelName/parcelId` 统一转换为页面使用的 `name/id`，详情、编辑和删除均使用稳定的 `parcelCode`。
- `plot-service` 已补充地块更新与软删除能力，支持 `PUT /api/v1/plots/:parcelCode` 和 `DELETE /api/v1/plots/:parcelCode`；批量删除前端改为逐条调用真实删除接口。
- 地块新增表单已适配地块编码服务入参并生成 CGCS2000 默认边界，避免页面提交前端字段后被服务端判定为非法请求。
- 农事任务列表已接入服务端关键词/状态筛选；“新建任务”改为真实表单并调用作业服务，“详情”可查看任务摘要，状态流转继续调用真实接口。
- 农事记录页面已从占位页改为调用溯源服务查询记录，支持按地块编码筛选。
- 设备管理页已接入设备详情查询、配置指令队列和状态刷新；移除了没有后端接口支撑的删除按钮。
- 系统用户页改为读取当前登录用户信息，系统角色页接入平台角色查询；移除了原先的静态假用户和“开发中”占位内容。
- 一张图看板地图已接入真实地块边界：新增 `GET /api/v1/plots/bounds` 与 `GET /api/v1/plots/stats`，前端新增地块几何解析工具，边界渲染、图层切换和加载失败提示已完善。
- 视频监控页已改为真实 `<video>` 播放：新增 hls.js 依赖按需拉流，保留原生播放与加载失败、重试、离线占位。
- 网关已改为最长前缀路由匹配，修复 `/plots` 路由抢占 `/plots/bounds` 的问题。

### 2026-11-04：决策留痕、遥测持久化与前端地图/历史曲线

- 新增 `packages/db/src/pg-client.ts`：基于 `pg` 8.x 原生驱动的 `PgClientAdapter`，实现 PrismaClientLike（含 `$queryRawUnsafe`/`$executeRawUnsafe`）；`DB_URL` → `DATABASE_URL` → 本地默认的地址解析。
- 数据库迁移改为版本化目录 `infra/postgres/migrations`：`scripts/migrate-postgres.mjs` 以单事务逐个应用并记录 `schema_migrations`，支持 `--status`/`--target`；新增 `002_decision_telemetry.sql`（决策规则/处方/本地消息表 + 遥测读数/告警/本地消息表及索引）。
- `decision-service` 接入 SQL 持久化：规则以数据形式存储，每次求值都从仓储读取最新规则集（规则热更新）；处方生成记录输入数据与命中规则，并与事件同事务写入本地消息表后由中继投递（处方留痕）。
- 决策接口补齐：`GET/POST /api/v1/decision/rules`、`GET/PUT/DELETE /rules/:id`、`GET/POST /prescriptions`、`POST /ask`；`DB_URL` 缺省回落内存实现，本地无库仍可演示。
- `telemetry-service` 接入 SQL 持久化：读数/告警落库，新增 `GET /history`、`GET /history/series`（按时间升序返回图表可直接绑定的序列）、`GET /alerts`、`POST /alerts/:id/handle`。
- 前端地块详情页去掉地图占位：新增 `PlotBoundaryMap.vue`（Leaflet + 天地图渲染单个地块边界，无边界时提示），`views/plot/Detail.vue` 已接入。
- 前端设备监控页重写：新增设备/指标下拉，历史曲线改调 `telemetryApi.getHistorySeries`，最新读数 3 秒轮询 `getLatest`，无数据时显示空态。
- 前端 API 与类型补齐：`telemetryApi` 增加 `getHistory`/`getHistorySeries`/`handleAlert`，新增 `TelemetryHistoryPoint`/`TelemetryAlert` 类型并从 `@/api` 再导出。
- 新增决策/遥测 SQL 冒烟脚本 `scripts/smoke-decision-telemetry.mjs`（`pnpm smoke:decision-telemetry`，需 `DB_URL`）：验证读数上报、历史曲线、最新值、阈值告警与处理、规则热更新（阈值 30→40 后 value=35 才命中）、处方留痕；脚本自清理测试数据，可重复执行。

### 2026-11-05：事件日志总线、消息中心与处方效果回流

- `packages/mq` 新增跨进程事件日志传输层 `event-bus.ts`：`EventLogStore` 契约、`InMemoryEventLogStore`/`PgEventLogStore`、`EventLogPublisher`（投递完整信封）与 `EventLogConsumer`（按消费者组位点轮询，位点懒加载，重启续读）；补增 4 个单元测试。
- `EventPublisher` 新增可选 `publishEnvelope`，`publishEvent` 优先走信封投递；本地消息表中继 `relayOnce` 由 `OutboxRecord` 还原 `DomainEvent` 后投递，保证 `eventId`/`traceId` 不丢。
- `message-service` 重写为“仓储 + 事件消费”双通道：新增 `MessageRepository`（内存与 `ops_messages` SQL 实现，`source_event_id` 唯一约束兼做重复投递兜底）与 `MessageEventConsumer`（订阅 `telemetry.threshold.breached` 与 `decision.prescription.issued`，分别生成 ALERT 与 NOTICE）；HTTP 接口补齐未读数与详情，启动时按 `DB_URL` 切换 SQL/内存并优雅关闭。
- `decision-service`/`telemetry-service` 改用 `EventLogPublisher(PgEventLogStore)`，删除 telemetry 重复的中继：事件从进程内总线切到数据库事件日志，才能真正到达消息中心。
- 处方效果回流：新增 `outcome.repository.ts`（`evaluateOutcome` 根据目标含水率与回升幅度给出阈值建议，区间 20~60、步长 5）与 `GET/POST /api/v1/decision/prescriptions/:id/outcome`；`applySuggestion` 时把建议写回规则条件与表达式，形成「处方留痕 → 效果评估 → 规则调优」闭环。
- 新增迁移 `infra/postgres/migrations/003_event_bus_messages.sql`：`event_log`、`event_log_offsets`、`ops_messages`、`decision_prescription_outcomes`。
- 新增 `scripts/smoke-events.mjs` 与 `pnpm smoke:events`：隔离端口启动 telemetry/decision/message 三服务，验证越限与处方事件驱动消息、效果评估与阈值 30→35 写回、重复轮询不重复生成消息，脚本自清理。
- 新增不依赖数据库的闭环联调 `apps/message-service/test/event-closure.spec.ts`：三服务同进程真实 HTTP + 共享内存事件日志，覆盖事件→消息→已读→效果评估→规则写回全链路。
- 前端新增「消息中心」页 `views/message/Index.vue`（类型/已读/地块/关键词筛选、批量标记已读、手工新建通知、分页），路由与侧边菜单加入「消息中心」，顶栏加入铃铛未读角标（30 秒轮询 `unread-count`）；同时补齐全局 `.page-container`/`.card-container` 与工具类，修复业务页内容贴边。
- `scripts/start-services.mjs` 中 telemetry 默认 `TELEMETRY_PUBLISH_EVENTS=true`，本地起服务即会产生越限事件。

### 2026-11-05（续）：SQL 事件闭环实跑与时间字段缺陷修复

- 本地基础设施就绪（Postgres/MinIO），`node scripts/migrate-postgres.mjs` 已应用 `003_event_bus_messages.sql`，`schema_migrations` 记录 001/002/003 全部为已应用。
- `pnpm smoke:events` 首次失败（消息为空），逐层排查定位到真实缺陷：pg 驱动把 `TIMESTAMPTZ` 解析为 `Date`，各 SQL 仓储用 `String(row.created_at)` 映射会得到本地化文本（如 `Thu Nov 05 2026 08:33:12 GMT+0800 (中国标准时间)`），中继写事件日志时报 `invalid input syntax for type timestamp with time zone`，事件永远发不出去。
- 修复：`@agri/shared` 新增 `toIsoTimestamp`（Date/数字/字符串 → ISO，空值返回空串，不可解析时原样返回），并在 `telemetry`/`decision` 的本地消息表、`telemetry` 读数与告警、`decision` 规则与处方、`plot`、`trace`、`finance` 的 SQL 映射处统一替换 `String(...)`。
- 新增回归测试：`packages/shared/test/shared.spec.ts` 补充时间转换用例；新增 `apps/telemetry-service/test/outbox.spec.ts` 与 `apps/decision-service/test/outbox.spec.ts`，用假客户端固定「待投递记录时间列必须是 ISO」。
- 修复后 `pnpm smoke:events` 输出 `SMOKE PASS`：越限与处方两条事件生成两条消息、效果评估建议 30→35 并写回规则、重复轮询不重复生成消息。

### 2026-11-05（续）：系统管理用户与角色

- `auth-service` 用户管理接口：新增 `GET/POST /api/v1/auth/users`、`PUT/DELETE /api/v1/auth/users/:id`、`POST /api/v1/auth/users/:id/password`；用户增加 `phone`/`status`/`createdAt`/`updatedAt` 字段，登录时拒绝停用账号，内置 `admin` 与当前登录用户不可删除，所有出参不含密码。
- `platform-service` 角色与权限：新增权限目录 `GET /api/v1/platform/permissions`（8 个分组、22 个权限码）与角色 `POST /roles`、`PUT/DELETE /roles/:id`；权限码校验只接受目录内编码，内置 `admin` 角色不可删改权限；角色变更写入审计日志，`GET /platform/audit-logs` 支持关键词过滤。
- 前端系统管理页不再是占位：`system/User.vue` 支持关键词/状态筛选、新建、编辑、启用停用、重置密码与删除，角色列按平台角色名称渲染；`system/Role.vue` 支持关键词筛选、新建/编辑/删除角色，权限按目录分组勾选，管理员角色只读展示。
- 新增 `apps/auth-service/test/http.spec.ts`、`apps/platform-service/test/http.spec.ts`，覆盖用户增改删改密与停用登录拦截、重复用户名、角色 CRUD、未知权限码、内置角色保护与审计留痕。
- `scripts/smoke-gateway.mjs` 扩展系统管理链路：网关内新建角色 → 按角色建用户 → 新用户登录 → 停用后登录 403 → 审计日志命中 → 清理用户与角色。

### 2026-11-05（续）：系统账号与角色落库

- 新增迁移 `004_identity_accounts.sql`：`auth_users`（口令散列、状态、直接授予权限）、`auth_user_roles`、`platform_roles`、`platform_role_permissions`、`platform_audit_logs`，均带租户索引与外键级联。
- `auth-service` 抽出 `UserRepository`：内存实现 + `SqlUserRepository`（账号与角色关联同事务写入、分页批量补角色、时间列统一 `toIsoTimestamp`）；口令改为 sha256 散列存储，登录与改密在两种存储下行为一致；删除账号时同步回收会话。
- `platform-service` 抽出 `RoleRepository` 与 `AuditRepository`：内存与 SQL 两套实现，角色权限码独立表存储，审计日志落库并支持关键词过滤。
- 两个服务 `main.ts` 按 `DB_URL` 与 `AUTH_REPOSITORY_MODE`/`PLATFORM_REPOSITORY_MODE` 切换存储，启动期幂等写入内置管理员与内置角色；`@agri/db` 加入两个服务的依赖与 project references。
- 修复 `PgClientAdapter.$transaction` 缺陷：回调此前拿到原生 `pg.Client`（缺 `$queryRawUnsafe`/`$executeRawUnsafe`），事务内任何仓储调用都会报 `tx.$executeRawUnsafe is not a function`；改为传入包装后的 `Tx`，并补单元测试固定该契约。
- 新增仓储测试 `apps/auth-service/test/user.repository.spec.ts`、`apps/platform-service/test/role.repository.spec.ts`，覆盖内存筛选规则、SQL 字段映射与事务写入顺序。
- 新增 `scripts/smoke-identity.mjs` 与 `pnpm smoke:identity`：SQL 模式创建角色与用户 → 重启两个进程 → 验证仍能登录、角色权限与审计日志仍在 → 清理测试数据。

### 2026-11-05（续）：事件消费方（控制指令与生产档案）

- 新增迁移 `005_control_commands.sql`：`control_commands` 表含 `origin`（MANUAL/EVENT）、`source_event_id` 与按来源事件的唯一索引，自动指令重复投递不会产生第二条。
- `control-service` 抽出 `ControlCommandRepository`（内存 + `SqlControlCommandRepository`，分页支持地块与来源过滤，时间列走 `toIsoTimestamp`）；HTTP 改为依赖注入仓储，人工指令必须带 `X-User-Id` 与 `X-Confirm-Action`，并新增 `origin=EVENT/MANUAL` 过滤。
- `control-service` 新增 `ControlCommandConsumer`：订阅 `telemetry.threshold.breached` 与 `decision.prescription.issued`，只把「土壤含水率低于下限」与灌溉/施肥处方翻译成 `IRRIGATION`/`FERTILIZATION` 自动指令（执行人 `system:event`、`sourceEventId` 留痕）；植保处方与其它指标越限不自动下令，继续由消息中心提醒人工处置。
- `trace-service` 新增 `TraceEventConsumer`：订阅处方事件写入生产档案（事件 `PRESCRIPTION_ISSUED`、追溯码 `TR-PRES-<eventId>`、执行人 `event:<producer>`）；`SqlTraceRepository.create` 改为 `ON CONFLICT (trace_code) DO NOTHING`，内存实现同码返回既有档案，保证事件重放不重复建档。
- 两个服务 `main.ts` 按 `DB_URL` 与 `CONTROL_REPOSITORY_MODE`/`TRACE_REPOSITORY_MODE` 切换存储，订阅共享事件日志并优雅关闭；`@agri/mq` 加入依赖与 project references，tsconfig 开启 `experimentalDecorators`。
- 新增消费测试 `apps/control-service/test/consumer.spec.ts`（4 用例：缺水越限下令、非缺水不下令、灌溉/施肥下发而植保跳过、重复分发不重复下令）与 `apps/trace-service/test/consumer.spec.ts`（2 用例）。
- 新增 `scripts/smoke-consumers.mjs` 与 `pnpm smoke:consumers`：隔离端口启动 telemetry/decision/control/trace，验证越限与处方各自生成自动指令、处方写入追溯档案、重复轮询不重复下发，脚本自清理。

### 2026-11-05（续）：消息中心订阅偏好与去重键

- 新增 `@agri/contracts` 消息模板：`MESSAGE_TEMPLATES` 登记越限与处方两个主题，纯函数渲染标题、级别、内容与去重键；越限按「地块 + 指标 + 方向 + 小时」聚合，处方按来源事件唯一，风速越限按 `CRITICAL` 处理。
- 新增迁移 `006_message_preferences.sql`：`ops_messages.dedupe_key` 与 `(tenant_id, dedupe_key)` 部分唯一索引，`ops_message_preferences` 表按「租户 + 主题」保存接收开关与最低级别。
- `message-service` 新增 `MessagePreferenceRepository`（内存 + SQL），缺省「全部启用、最低 INFO」，新主题上线无需初始化数据；`MessageEventConsumer` 改为模板渲染 + 偏好过滤 + `dedupeKey` 落库，关闭订阅时事件仍提交消费位点但不写消息。
- 消息仓储补齐 `dedupe_key` 读写，消费重放与同一小时重复越限由唯一索引兜底。
- HTTP 新增 `GET /api/v1/messages/preferences`（合并模板目录返回全量）与 `PUT /api/v1/messages/preferences/:topic`（未登记主题 404、非法级别 400）；偏好路由置于消息详情之前，避免被 `:id` 规则吞掉。
- 前端消息中心新增「订阅偏好」弹窗：按来源主题展示类型、接收开关与最低级别，保存后对后续事件立即生效。
- 新增契约测试 `packages/contracts/test/message-template.spec.ts`（4 用例）与偏好测试 `apps/message-service/test/preference.spec.ts`（6 用例），覆盖模板去重窗口、偏好过滤、HTTP 校验与 SQL 字段映射。
- 新增 `scripts/smoke-message-preferences.mjs` 与 `pnpm smoke:messages`：验证关闭订阅零消息、最低级别门槛、同小时去重与偏好持久化，脚本自清理。

### 2026-11-05（续）：网关与服务侧权限校验

- 权限目录上移为唯一来源：新增 `@agri/contracts/authz`（`PERMISSION_CATALOG` 8 组 22 码、`PERMISSION_CODES`、`hasPermission` 支持 `*` 与 `领域:*`、`parsePermissionHeader`/`serializePermissions`/`mergePermissions`），`platform-service` 改为引用契约目录，删除本地硬编码副本。
- 新增内部接口（不在网关路由表内，公网不可达，用 `x-internal-token` 保护）：`POST /api/v1/internal/auth/session` 凭 token 换取用户/租户/角色/权限，`POST /api/v1/internal/platform/role-permissions` 按角色编码返回启用角色的权限。
- `gateway-service` 新增 `authz.ts`：先按「方法 + 路径」解析规则（公开 / 仅登录 / 具体权限），再调内部接口解析会话与角色权限（会话缓存 5s、角色缓存 10s），失败返回 `GATEWAY-502`；登录、设备上报、健康检查公开，个人信息/租户/权限目录仅需登录，账号/角色/审计分别对应 `system:user`/`system:role`/`system:audit`，其余按前缀读写映射（文件随地块、视频随设备）。
- 网关转发时只使用解析出的身份：`x-user-id`/`x-tenant-id`/`x-permissions` 全部由会话生成，客户端伪造的头一律剥离；未登录 401、权限不足 403 在网关直接返回，不触达下游。`GATEWAY_AUTH_ENABLED=false` 仅供单元测试。
- 新增 `@agri/shared` 服务侧守卫 `authorizeRequest`：身份头缺失 401、权限不足 403，支持公开路径、仅登录路径与路径级权限覆盖；默认关闭（`AUTH_GUARD_MODE=enforce` 开启），因为本地直连脚本与单测不带身份头，网关本身始终强制。
- 12 个业务服务全部接入守卫：plot/finance/trace/operation/message/decision 读写各自领域，telemetry 上报公开，control/iot/video 用 `device:read`/`device:control`，file 跟随 `plot:*`，weather 只读，auth/platform 按守卫策略放行登录与内部接口。
- `auth-service` 登录与 `userinfo` 返回有效权限：角色权限从 platform 内部接口取得并与账号直授权限 `mergePermissions` 合并，平台不可用时退回直授权限；管理员持 `*` 不回查。
- 前端按权限收口：`utils/permission.ts` 提供与契约一致的 `checkPermission` 与本地缓存读取；路由 `meta.permission` 标注各页面，守卫未授权直接进新增的 `/403` 页；侧边菜单按权限过滤并在分组无可见子页时整组隐藏；用户信息刷新后从本地缓存恢复，未登录（401）自动清理身份回登录页，403 展示服务端提示。
- 新增测试：`packages/contracts/test/authz.spec.ts`（7 用例）、`packages/shared/test/authz.spec.ts`（6 用例）、`apps/gateway-service/test/authz.spec.ts`（11 用例，含缓存与 502）、网关 HTTP 新增 401/403 不转发与身份头剥离用例、auth/platform 内部接口用例。
- 新增 `scripts/smoke-authz.mjs` 与 `pnpm smoke:authz`：网关未登录 401、只读角色读放行/写 403、登录合并角色权限；地块服务 `AUTH_GUARD_MODE=enforce` 下直连缺身份 401、缺权限 403、带权限 200。`smoke-gateway` 同步补 401 与越权 403 断言、审计请求补 token。

### 2026-11-05（续）：控制指令来源与生产档案事件筛选

- `trace-service` 档案查询新增 `event` 条件：仓储 `list(plotCode?, event?)` 在内存与 SQL 实现中同时生效，SQL 侧按参数拼接 `plot_code`/`event` 条件，接口透传 `?event=` 查询参数。
- 前端新增「设备管理 → 控制指令」页（`views/device/Commands.vue`，路由 `device/commands`，`device:read` 可访问）：按地块与来源（自动/人工）筛选，列表展示指令类型、状态、缘由、`sourceEventId` 与操作人/下达时间，并说明自动指令的重放去重规则；`controlApi.getCommands` 补充 `plotCode`/`origin` 参数。
- 生产档案页（`views/farm/Record.vue`）新增事件类型筛选（处方生成/农事作业/作业完成）与分页，事件列改为标签展示；生产溯源页（`views/trace/Index.vue`）同步用标签展示事件类型。`utils/index.ts` 新增控制指令来源/类型/状态与档案事件的文案和标签色映射，`traceApi.getRecords` 补充 `event` 参数。
- 测试与冒烟：`apps/trace-service/test/repository.spec.ts` 新增内存按事件筛选与 SQL 组合条件用例；`scripts/smoke-consumers.mjs` 增加 `event=PRESCRIPTION_ISSUED` 筛选断言。

### 2026-11-05（续）：最终交付复验

- 基础设施：Postgres TCP 与 MinIO 健康检查均 OK，迁移 `001`~`006` 全部已应用。
- 全量编译 `pnpm run build` 通过；带 `DB_URL` 的 `pnpm test` 为 37 个测试文件、149 个用例全部通过（不再有 SQL 用例跳过）。
- 前端 `pnpm --filter @agri/web build`（`vue-tsc -b && vite build`）通过，含控制指令页与档案筛选。
- 冒烟全通过：`smoke-services`（15 个服务）、`smoke-gateway`（未登录 401 → 登录 → 地块 → 控制确认 → 角色/用户 → 越权 403）、`smoke-authz`、`smoke-decision-telemetry`、`smoke-events`、`smoke-identity`（重启后仍可登录）、`smoke-consumers`（含档案事件筛选）、`smoke-messages`。
- 运行说明已与 README 对齐：命令表、测试计数、已验证结果与消费结果展示约定同步更新。

### 2026-11-05（续）：菜单跳转与首页地图定位修复

- 侧边菜单 404：`getRoutes()` 根记录的子项仍使用相对 `path`（如 `plot/list`），而 Element Plus 菜单 `router` 模式按当前路由做相对跳转，在深层页面会拼成 `/plot/plot/list`。`MainLayout.vue` 改为统一用 `resolvePath` 生成绝对地址，单页与分组子项均从 `/` 起算。
- 首页地图：地图中心保持在四川达州（智耘蜀芯）一带（`31.2096, 107.4679`），演示边界与地块详情空态中心同步保持该坐标，仅将地图状态文案改为「天地图 · 智耘蜀芯农情中心」；上一步误改为黑龙江赵光农场的坐标、天气与地块默认值已全部回退。

## 下一步（中断后从这里继续）

首版功能已全部交付，无阻塞项。以下为上线前可选增强（未列入本轮范围）：

1. 会话与口令加固：将 auth-service 的内存会话替换为持久化/JWT 方案，口令由 sha256 换成 bcrypt/argon2。
2. 部署编排：补充容器镜像、网关 HTTPS、数据库连接池与 `AUTH_GUARD_MODE=enforce` 的部署配置。

## 验证记录

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过 |
| 2026-11-03 | `Invoke-WebRequest http://127.0.0.1:3000/` | HTTP 200 |
| 2026-11-03 | `pnpm run build` | 通过 |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过 |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（分页契约适配后） |
| 2026-11-03 | `auth-service` 独立进程冒烟 | 未完成：终端策略拦截了启动测试命令，待复验 |
| 2026-11-03 | `pnpm run build` | 通过（platform-service 接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（platform-service 接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（platform-service 接入后） |
| 2026-11-03 | `pnpm run build` | 通过（gateway-service 与真实登录接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（gateway-service 与真实登录接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（真实登录接入后） |
| 2026-11-03 | `pnpm run build` | 通过（感知服务接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（感知服务接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（感知服务接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（dashboard 感知数据接入后） |
| 2026-11-03 | `pnpm run build` | 通过（dashboard 感知数据接入后） |
| 2026-11-03 | `pnpm run build` | 通过（message-service 接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（message-service 接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（message-service 接入后） |
| 2026-11-03 | `pnpm run build` | 通过（operation/control 接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（operation/control 接入后） |
| 2026-11-03 | `pnpm run build` | 通过（decision-service 接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（decision-service 接入后） |
| 2026-11-03 | `pnpm run build` | 通过（finance/trace 接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（finance/trace 接入后） |
| 2026-11-03 | `pnpm run build` | 通过（file/video 接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（file/video 接入后） |
| 2026-11-03 | `pnpm run build` | 通过（控制安全链路接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（控制安全链路接入后） |
| 2026-11-03 | `pnpm test` | 8 个测试文件、47 个用例通过（控制安全链路接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（设备监控、设备列表、农事任务接口接入后） |
| 2026-11-03 | `pnpm run build` | 通过（设备监控、设备列表、农事任务接口接入后） |
| 2026-11-03 | `pnpm test` | 10 个测试文件、51 个用例通过（HTTP 自动化测试接入后） |
| 2026-11-03 | `pnpm run build` | 通过（HTTP 自动化测试与网关可注入路由接入后） |
| 2026-11-03 | `pnpm run smoke:gateway` | 通过（四进程真实网关链路：登录、地块查询、控制确认） |
| 2026-11-03 | `pnpm test` | 10 个测试文件、51 个用例通过（多进程脚本接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（多进程脚本接入后） |
| 2026-11-03 | `pnpm --filter web exec vue-tsc -b` | 通过（核算、溯源、视频页面接入后） |
| 2026-11-03 | `pnpm run build` | 通过（核算、溯源、视频页面接入后） |
| 2026-11-03 | `pnpm test` | 10 个测试文件、51 个用例通过（核算、溯源、视频页面接入后） |
| 2026-11-03 | `pnpm run build` | 通过（SqlPlotRepository 接入后） |
| 2026-11-03 | `pnpm test` | 11 个测试文件、53 个用例通过（SqlPlotRepository 接入后） |
| 2026-11-03 | `pnpm run build` | 通过（文件对象存储适配接入后） |
| 2026-11-03 | `pnpm test` | 12 个测试文件、54 个用例通过（文件对象存储适配接入后） |
| 2026-11-03 | `pnpm run build` | 通过（FinanceRepository 与 SQL 适配器接入后） |
| 2026-11-03 | `pnpm test` | 13 个测试文件、56 个用例通过（FinanceRepository 与 SQL 适配器接入后） |
| 2026-11-03 | `pnpm run build` | 通过（TraceRepository 与 SQL 适配器接入后） |
| 2026-11-03 | `pnpm test` | 14 个测试文件、58 个用例通过（TraceRepository 与 SQL 适配器接入后） |
| 2026-11-03 | `pnpm run build` | 通过（S3/MinIO 对象存储适配接入后） |
| 2026-11-03 | `pnpm test` | 15 个测试文件、60 个用例通过（S3/MinIO 对象存储适配接入后） |
| 2026-11-03 | `node --check scripts/service-registry.mjs; node --check scripts/start-services.mjs; node --check scripts/health-check.mjs` | 通过（统一启动与健康检查脚本） |
| 2026-11-03 | `pnpm run build` | 通过（统一启动与健康检查脚本接入后） |
| 2026-11-03 | `pnpm test` | 15 个测试文件、60 个用例通过（统一启动与健康检查脚本接入后） |
| 2026-11-04 | `pnpm run build` | 通过（PostgreSQL/PostGIS 迁移与 Compose 配置接入后） |
| 2026-11-04 | `pnpm test` | 15 个测试文件、60 个用例通过（PostgreSQL/PostGIS 迁移与 Compose 配置接入后） |
| 2026-11-04 | `docker compose -f infra/docker-compose.yml config` | 未执行：当前环境未安装 Docker CLI |
| 2026-11-04 | `pnpm run health:infra` | 未通过：当前环境 PostgreSQL `127.0.0.1:5432` 和 MinIO 均未启动（ECONNREFUSED/fetch failed） |
| 2026-11-04 | `pnpm run build` | 通过（MinIO bucket 初始化与基础设施健康检查脚本接入后） |
| 2026-11-04 | `pnpm test` | 15 个测试文件、60 个用例通过（MinIO bucket 初始化与基础设施健康检查脚本接入后） |
| 2026-11-04 | `node --check` + `getServices({ AGRI_AUTH_PORT: '3101', AGRI_GATEWAY_PORT: '8180' })` | 通过（启动/健康检查端口覆盖） |
| 2026-11-04 | `pnpm run build` | 通过（启动/健康检查端口覆盖接入后） |
| 2026-11-04 | `pnpm test` | 15 个测试文件、60 个用例通过（启动/健康检查端口覆盖接入后） |
| 2026-11-04 | `pnpm run smoke:services` | 通过：隔离端口启动并检查 15 个 HTTP 服务，全部健康后自动清理 |
| 2026-11-04 | `node --check scripts/smoke-services.mjs` | 通过 |
| 2026-11-04 | `pnpm run build` | 通过（全量服务冒烟脚本接入后） |
| 2026-11-04 | `pnpm test` | 15 个测试文件、60 个用例通过（全量服务冒烟脚本接入后） |
| 2026-11-04 | README/infra 文档同步 | 通过：补充 15 服务启动、健康检查、全量冒烟和 MinIO 初始化命令 |
| 2026-11-04 | `node --check scripts/migrate-postgres.mjs` | 通过 |
| 2026-11-04 | `pnpm run db:migrate` | 未执行迁移：当前环境未安装 `psql`，脚本已明确提示安装客户端或启动 Docker 数据库 |
| 2026-11-04 | `pnpm run build` | 通过（数据库迁移入口接入后） |
| 2026-11-04 | `pnpm test` | 15 个测试文件、60 个用例通过（数据库迁移入口接入后） |
| 2026-11-04 | `docker compose ... pull/up` | 未在 Codex 终端执行：当前终端 PATH 中未发现 Docker CLI；Compose 镜像标签已修正 |
| 2026-11-04 | Compose MinIO 镜像修正 | 已将无法匿名拉取的官方 MinIO 地址替换为公开的 `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`；待用户 Docker 环境重新拉取验证 |
| 2026-11-04 | `docker compose -f infra/docker-compose.yml up -d` | 通过：PostgreSQL、MinIO 容器成功启动，端口映射已生效 |
| 2026-11-04 | `pnpm init:minio` | 通过：`agri` bucket 已就绪 |
| 2026-11-04 | `pnpm health:infra` | 通过：PostgreSQL TCP connected，MinIO HTTP 200 |
| 2026-11-04 | `pnpm start:services` + `pnpm health:services` | 通过：15 个 HTTP 服务全部返回健康状态，网关监听 `8080` |
| 2026-11-04 | `pnpm smoke:gateway` | 通过：登录 -> 地块查询 -> 控制二次确认真实多进程链路 |
| 2026-11-04 | `pnpm run build` | 通过（地块 CRUD 与前端契约修复后） |
| 2026-11-04 | `pnpm --filter web exec vue-tsc -b` | 通过（地块 API 字段与新增表单适配后） |
| 2026-11-04 | `pnpm test` | 15 个测试文件、61 个用例通过（地块更新与软删除测试接入后） |
| 2026-11-04 | `pnpm smoke:services` | 通过：隔离端口启动并检查 15 个服务，全部健康 |
| 2026-11-04 | `pnpm test -- apps/operation-service/test/http.spec.ts` | 通过：创建任务、关键词/状态筛选、状态流转 |
| 2026-11-04 | `pnpm smoke:services` | 通过：农事功能修改后 15 个服务全部健康 |
| 2026-11-04 | `pnpm run build` | 通过（设备与系统管理页面接口接入后） |
| 2026-11-04 | `pnpm --filter web exec vue-tsc -b` | 通过（设备详情、配置、角色和当前用户页面接入后） |
| 2026-11-04 | `pnpm test` | 16 个测试文件、62 个用例通过（设备与系统管理页面接入后） |
| 2026-11-04 | `pnpm smoke:services` | 通过：设备与系统页面修改后 15 个服务全部健康 |
| 2026-11-04 | `pnpm smoke:gateway` | 通过：登录、地块和控制网关链路仍正常 |
| 2026-11-04 | `$env:DB_URL=...; pnpm db:migrate` | 通过：001、002 迁移已应用；重复执行提示已最新；`--status` 正常 |
| 2026-11-04 | `node scripts/migrate-postgres.mjs --status` | 通过：已应用 001_initial_schema、002_decision_telemetry |
| 2026-11-04 | `pnpm run build` | 通过（决策/遥测持久化与前端地图、历史曲线接入后） |
| 2026-11-04 | `pnpm test` | 18 个测试文件、68 个用例通过，SQL 冒烟用例在无 DB_URL 时跳过 |
| 2026-11-04 | `pnpm --filter @agri/web exec vue-tsc -b` | 通过（新增 TelemetryHistoryPoint/TelemetryAlert 类型与 telemetryApi 历史接口后） |
| 2026-11-04 | `$env:DB_URL=...; pnpm smoke:decision-telemetry` | 通过：读数 3 点历史 + 阈值告警与处理 + 规则热更新(30→40) + 处方留痕，测试数据已自清理 |
| 2026-11-05 | `pnpm exec vitest run packages/mq/test` | 通过：事件日志发布/订阅、位点续读等 10 个用例 |
| 2026-11-05 | `npx tsc -b` | 通过（事件总线、消息消费、效果回流接入后） |
| 2026-11-05 | `pnpm test` | 通过：22 个测试文件、78 个用例，3 个 SQL 用例因无 `DB_URL` 跳过 |
| 2026-11-05 | `pnpm --filter @agri/web exec vue-tsc -b` | 通过（消息中心页面、路由与未读角标接入后） |
| 2026-11-05 | `pnpm --filter @agri/web build` | 失败于历史环境问题：esbuild 清理系统临时目录 `Access is denied` |
| 2026-11-05 | `$env:TEMP=...\.tmp; pnpm --filter @agri/web exec vite build` | 通过：2288 模块，built in 16.13s（TEMP 指到工作区后绕过临时目录权限问题） |
| 2026-11-05 | `node --check scripts/smoke-events.mjs` | 通过 |
| 2026-11-05 | `pnpm health:infra` | 通过：PostgreSQL TCP connected，MinIO HTTP 200，解除事件闭环实跑阻塞 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/migrate-postgres.mjs --status` | 通过：001/002 已应用，003_event_bus_messages 待应用 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/migrate-postgres.mjs` | 通过：003_event_bus_messages.sql 已应用 |
| 2026-11-05 | `$env:DB_URL=...; pnpm smoke:events` | 首次失败（等待消息超时），定位并修复时间字段映射后输出 `SMOKE PASS` |
| 2026-11-05 | `npx tsc -b` + `pnpm exec vitest run packages/shared/test` | 通过：`toIsoTimestamp` 用例 7 个通过 |
| 2026-11-05 | `$env:DB_URL=...; pnpm smoke:decision-telemetry` | 通过：读数/告警/规则热更新/处方留痕 |
| 2026-11-05 | `$env:DB_URL=...; pnpm smoke:services` | 通过：15 个服务 SQL 模式下全部健康 |
| 2026-11-05 | `$env:DB_URL=...; pnpm smoke:gateway` | 通过：登录、地块、控制二次确认多进程链路 |
| 2026-11-05 | `$env:DB_URL=...; pnpm test` | 通过：26 个测试文件、84 个用例，SQL 用例不再跳过 |
| 2026-11-05 | `npx tsc -b` + `pnpm run build` | 通过（用户/角色管理接口与页面接入后） |
| 2026-11-05 | `pnpm exec vitest run apps/auth-service/test apps/platform-service/test` | 通过：6 个用例（用户 CRUD 与角色权限） |
| 2026-11-05 | `pnpm --filter @agri/web exec vue-tsc -b` | 通过（用户与角色页面重写后） |
| 2026-11-05 | `node scripts/smoke-gateway.mjs` | 通过：登录→地块→控制确认→角色/用户管理与停用拦截 |
| 2026-11-05 | `$env:DB_URL=...; pnpm test` | 通过：28 个测试文件、90 个用例 |
| 2026-11-05 | `node scripts/smoke-services.mjs` | 通过：15 个服务健康 |
| 2026-11-05 | `$env:TEMP=...\.tmp; pnpm --filter @agri/web exec vite build` | 通过：2289 模块，built in 14.10s |
| 2026-11-05 | `$env:DB_URL=...; node scripts/migrate-postgres.mjs` | 通过：004_identity_accounts.sql 已应用（66 ms） |
| 2026-11-05 | `pnpm exec vitest run packages/db/test apps/auth-service/test apps/platform-service/test` | 通过：25 个用例（含事务 Tx 回归） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-identity.mjs` | 首次失败（`tx.$executeRawUnsafe is not a function`），修复事务适配器后 `SMOKE PASS` |
| 2026-11-05 | `$env:DB_URL=...; pnpm test` | 通过：30 个测试文件、101 个用例 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-services.mjs` | 通过：15 个服务（auth/platform/message 均 SQL 模式） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-gateway.mjs` | 通过：登录→地块→控制→角色/用户管理（SQL 模式） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-events.mjs` | 通过：`SMOKE PASS`（事件闭环无回归） |
| 2026-11-05 | `npx tsc -b` | 通过（控制/追溯消费接入后） |
| 2026-11-05 | `pnpm exec vitest run apps/control-service apps/trace-service` | 通过：4 个测试文件、10 个用例 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/migrate-postgres.mjs` | 通过：005_control_commands.sql 已应用（53 ms） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-consumers.mjs` | 通过：越限+处方生成自动指令、处方写入档案、重复轮询不重复下发（`SMOKE PASS`） |
| 2026-11-05 | `pnpm run build` | 通过（exit 0） |
| 2026-11-05 | `$env:DB_URL=...; pnpm test` | 通过：32 个测试文件、107 个用例 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-services.mjs` | 通过：15 个服务（control/trace 均为 SQL 模式） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-gateway.mjs` | 通过：登录→地块→控制→角色/用户管理 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-events.mjs` | 通过：`SMOKE PASS`（消息中心无回归） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-identity.mjs` | 通过：账号角色落库无回归 |
| 2026-11-05 | `pnpm exec vitest run apps/message-service packages/contracts` | 通过：5 个测试文件、19 个用例（模板与偏好过滤） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/migrate-postgres.mjs` | 通过：006_message_preferences.sql 已应用（16 ms） |
| 2026-11-05 | `pnpm --filter @agri/web exec vue-tsc -b` | 通过（消息中心订阅偏好弹窗后） |
| 2026-11-05 | `$env:TEMP=...\.tmp; pnpm --filter @agri/web exec vite build` | 通过：built in 15.30s（订阅偏好弹窗后） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-message-preferences.mjs` | 通过：关闭订阅零消息、级别门槛、同小时去重（`SMOKE PASS`） |
| 2026-11-05 | `pnpm run build` | 通过（exit 0） |
| 2026-11-05 | `$env:DB_URL=...; pnpm test` | 通过：34 个测试文件、117 个用例 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-consumers.mjs` | 通过：`SMOKE PASS`（控制/追溯消费无回归） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-events.mjs` | 通过：`SMOKE PASS`（消息中心无回归） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-gateway.mjs` | 通过：登录→地块→控制→角色/用户管理 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-services.mjs` | 通过：15 个服务健康 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-identity.mjs` | 通过：账号角色落库无回归 |
| 2026-11-05 | `pnpm install --prefer-offline` | 通过：`packages/shared` 新增 `@agri/contracts` 依赖后的软链建立 |
| 2026-11-05 | `npx tsc -b` | 通过（契约权限目录、shared 守卫、网关鉴权、12 个服务守卫后） |
| 2026-11-05 | `pnpm exec vitest run packages/contracts packages/shared apps/gateway-service apps/auth-service apps/platform-service` | 通过：11 个测试文件、65 个用例 |
| 2026-11-05 | `node scripts/smoke-authz.mjs` | 通过：网关 401/403 拦截、角色权限合并、服务侧守卫（`AUTH_GUARD_MODE=enforce`） |
| 2026-11-05 | `node scripts/smoke-gateway.mjs` | 通过：新增未登录 401、越权 403 与角色权限合并断言 |
| 2026-11-05 | `pnpm --filter @agri/web exec vue-tsc -b` | 通过（路由 meta.permission、403 页与菜单过滤后） |
| 2026-11-05 | `$env:TEMP=...\.tmp; pnpm --filter @agri/web exec vite build` | 通过：built in 27.58s |
| 2026-11-05 | `npx vitest run` | 通过：35 个测试文件、144 个用例（2 文件/3 用例按原配置跳过） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-services.mjs` | 通过：15 个服务健康（权限校验后） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-identity.mjs` | 通过：账号角色落库无回归（权限校验后） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-events.mjs` | 通过：`SMOKE PASS`（事件闭环无回归） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-consumers.mjs` | 通过：`SMOKE PASS`（控制/追溯消费无回归） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-message-preferences.mjs` | 通过：偏好过滤/去重无回归 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-decision-telemetry.mjs` | 通过：规则热更新与处方留痕无回归 |
| 2026-11-05 | `npx tsc -b` | 通过（档案事件筛选与前端新增页面后） |
| 2026-11-05 | `npx vitest run apps/trace-service` | 通过：2 个测试文件、6 个用例 |
| 2026-11-05 | `npx vitest run` | 通过：35 个测试文件、146 个用例（2 文件/3 用例按原配置跳过） |
| 2026-11-05 | `pnpm --filter @agri/web exec vue-tsc -b` | 通过（控制指令页与档案筛选后） |
| 2026-11-05 | `$env:TEMP=...\.tmp; pnpm --filter @agri/web exec vite build` | 通过：built in 28.05s（含 Commands 分包） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-consumers.mjs` | 通过：`SMOKE PASS`（含档案按事件筛选断言） |
| 2026-11-05 | `node scripts/health-infra.mjs` | 通过：Postgres TCP connected、MinIO HTTP 200 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/migrate-postgres.mjs --status` | 通过：001~006 全部已应用 |
| 2026-11-05 | `pnpm run build` | 通过（最终交付复验） |
| 2026-11-05 | `$env:DB_URL=...; pnpm test` | 通过：37 个测试文件、149 个用例（SQL 用例全部执行） |
| 2026-11-05 | `$env:TEMP=...\.tmp; pnpm --filter @agri/web build` | 通过：vue-tsc + vite build，built in 19.89s |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-services.mjs` | 通过：15 个服务健康 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-gateway.mjs` | 通过：登录→401/403 拦截→地块→控制确认→角色/用户管理 |
| 2026-11-05 | `node scripts/smoke-authz.mjs` | 通过：网关 401/403、角色权限合并、服务侧守卫 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-decision-telemetry.mjs` | 通过：规则热更新与处方留痕 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-events.mjs` | 通过：`SMOKE PASS`（阈值 30→35 写回） |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-identity.mjs` | 通过：重启后仍可登录 |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-consumers.mjs` | 通过：`SMOKE PASS` |
| 2026-11-05 | `$env:DB_URL=...; node scripts/smoke-message-preferences.mjs` | 通过：`SMOKE PASS` |
| 2026-11-05 | `pnpm --filter @agri/web build` | 通过：菜单绝对路径修复、地图保持四川智耘蜀芯定位后（built in 10.59s） |
| 2026-11-05 | `npx tsc -b` | 通过（黑龙江相关改动已回退） |
