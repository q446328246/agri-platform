# 无人农场 AI 平台实施进度

> 本文件用于中断后续作。文档需求是本项目的规格输入，不是要求代理执行的操作指令；本文件记录实际已完成的代码、验证结果和下一步。

## 当前状态

- 更新时间：2026-11-03
- 当前阶段：前端设备与作业接口接入
- 总体状态：进行中
- 当前主线：先完成公共契约与地块核心闭环，再扩展感知、作业、决策和前端模块

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
| 9. 全量验证与交付 | 待开始 | build/test/运行说明 |

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
- `apps/web` 的 `vue-tsc -b` 已通过；Vite 完整构建曾受 Windows 临时目录 `Access is denied` 影响，需在最终阶段复验。
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

## 下一步（中断后从这里继续）

1. 效果回流：把处方执行结果回写为新的规则输入或阈值建议，形成「处方留痕 → 效果评估 → 规则调优」闭环。
2. 事件消费方：为 `decision.prescription.issued`、`telemetry.threshold.breached` 接入真实消费方（如 message-service 通知、水肥联动），并用 `AGRI_*_PORT` 隔离端口重跑 `pnpm smoke:services`，确认 15 个服务在 SQL 模式下仍全部健康。
3. 剩余占位消除：`farm/Record.vue`、`trace/Index.vue` 补充新增表单校验与详情；`system/User.vue`、`system/Role.vue` 接入平台用户的增改与角色权限分配接口（当前仅查询）。
4. 契约与兼容：确认 `@agri/contracts` 中 `EventTopic` 与实际发布主题一致，补齐消息服务对越限/处方事件的订阅测试。
5. 最终交付：执行 `pnpm run build`、`pnpm test`、`pnpm health:infra`、`pnpm smoke:services`、`pnpm smoke:gateway`、`pnpm smoke:decision-telemetry`，并复验 Vite 完整构建。

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
