# 智慧农业平台 Node.js 工程脚手架

以**地块**为最小管理单元、不限经营规模的智慧农业平台后端工程骨架。本仓库把前一阶段的
方案文档落成可编译、可运行、可测试的代码：公共包、15 个 HTTP 微服务和 Vue 管理后台，全部通过工程引用
（Project References）串成一条构建链。

- 运行时：Node.js 24 LTS
- 服务实现：Node.js 原生 `http`（各服务自建路由与依赖注入）+ TypeScript 5.9
- 仓库形态：pnpm workspace（包关系）+ Turborepo（任务编排）+ tsc -b（跨包编译）
- 测试：Vitest 3

## 一、快速开始

```bash
# 1. 安装依赖（首次约 1 分钟）
pnpm install

# 2. 全量编译
pnpm run build

# 3. 运行测试
pnpm test

# 4. 运行示例服务：建档 → 写本地消息表 → 中继投递 → 消费幂等
pnpm run start:plot

# 5. 启动全部 HTTP 服务
pnpm start:services

# 6. 检查全部 HTTP 服务健康状态
pnpm health:services

# 7. 启动前端开发服务器（默认端口3000）
pnpm --filter @agri/web dev
```

其他脚本：

| 命令 | 用途 |
| --- | --- |
| `pnpm run build` | 全量编译（`tsc -b`，按工程引用顺序） |
| `pnpm run build:changed` | 只编译受影响的子工程（`turbo run build`） |
| `pnpm run test:watch` | 测试监听模式 |
| `pnpm run clean` | 清理各子工程的 `dist` 与增量编译信息 |
| `pnpm run start:plot` | 启动示例服务（需先 build） |
| `pnpm start:services` | 启动 15 个 HTTP 服务 |
| `pnpm health:services` | 检查 HTTP 服务健康端点 |
| `pnpm smoke:services` | 使用隔离端口启动并验证全部 HTTP 服务 |
| `pnpm smoke:gateway` | 登录 → 地块查询 → 控制二次确认的网关链路冒烟 |
| `pnpm smoke:authz` | 不建库：网关 401/403 拦截、角色权限合并与服务侧守卫 |
| `pnpm smoke:decision-telemetry` | 需 `DB_URL`：遥测历史/告警与规则热更新、处方留痕 |
| `pnpm smoke:events` | 需 `DB_URL`：遥测越限与处方事件 → 事件日志 → 消息中心 → 效果回流 |
| `pnpm smoke:consumers` | 需 `DB_URL`：越限/处方事件 → 自动水肥指令与生产档案 |
| `pnpm smoke:receipt` | 需 `DB_URL` 与迁移 031/033/034：设备领取与回执跃迁 → 结单事件（实测/推算/未上报三种口径）→ 档案、消息、处方执行回流；不含超时收口（其候选查询跨租户全表，调小阈值会误伤他人在途指令） |
| `pnpm smoke:messages` | 需 `DB_URL`：消息订阅偏好过滤与来源主题去重 |
| `pnpm smoke:identity` | 需 `DB_URL`：角色/用户落库，重启后仍可登录与查询 |
| `pnpm smoke:zones` | 片区建档/划入/凸包与机耕道导航（默认经 `https://localhost`，可用 `BASE_URL` 覆盖） |
| `pnpm smoke:demo` | 逐页校验演示数据（地块/四情/设备/任务/指令/处方/视频/消息/核算/溯源/系统管理），同样默认 `https://localhost` |
| `pnpm smoke:filters` | 逐服务校验各页面查询条的筛选参数真实生效（枚举/关键词/时间区间/分页/汇总联动），默认 `https://localhost` |
| `pnpm smoke:weather` | 气象服务冒烟：五日预报、预警、逐小时、实时气象站、农事建议、历史曲线、决策联动降雨概率来源校验，默认 `https://localhost` |
| `pnpm init:minio` | 创建 S3/MinIO bucket |
| `pnpm health:infra` | 检查 PostgreSQL 和 MinIO |
| `pnpm db:migrate` | 使用 `DB_URL` 执行 PostgreSQL 初始化迁移 |
| `pnpm seed:test-plots` | **会写演示库**：清掉早期验证地块，按边界几何现算面积重建三块测试地块；同名地块就地更新，可重复执行，示范数据不碰。默认 `https://localhost`，可用 `BASE_URL` 覆盖 |
| `pnpm --filter @agri/web dev` | 启动前端开发服务器 |
| `pnpm --filter @agri/web build` | 构建前端生产包 |

> 说明：`pnpm install` 需要放行 esbuild 的安装脚本（已在 `pnpm-workspace.yaml` 的
> `allowBuilds` 中白名单化）。若安装报 `ERR_PNPM_IGNORED_BUILDS`，检查该配置是否被改动。

### 容器化部署（可选）

仓库根目录的 `Dockerfile` 提供两个部署目标：`app`（15 个 HTTP 服务 + 网关）与 `edge`（nginx 静态资源、`/api` 反代、HTTPS 终止）。

```powershell
# 若 docker.io 不可直连，先把两个基础镜像经镜像源拉取并重打官方 tag（详见 infra/README.md）
# 首次构建包含依赖安装与全量编译
docker compose -f infra/docker-compose.yml --profile app up -d --build
# 访问 https://localhost（自签证书需浏览器确认信任），默认账号 admin / admin123
```

- 应用容器启动时先执行数据库迁移与 MinIO bucket 初始化，再拉起 15 个服务；网关是唯一对外入口。
- 部署环境固定 `AUTH_GUARD_MODE=enforce` 与 `GATEWAY_AUTH_ENABLED=true`，`INTERNAL_TOKEN`、`AUTH_SESSION_TTL_SECONDS` 可覆盖。
- 地图 Key 用 `VITE_TIANDITU_KEY` 构建参数传入；生产证书放到 `infra/certs` 并启用 `edge` 的注释卷。
- 演示数据：迁移 `010_demo_data.sql` 会灌入一套达川丘区（地图中心 `30.982425, 107.421325`）的完整数据，含 12 块地块与 3 个片区、3024 条遥测读数、告警/虫情/处方/指令/消息/投入产出/溯源记录，设备与摄像头由 iot/video 服务的内存种子提供，农事任务由迁移 `030_operation_task_demo_data.sql` 按在册地块落库（地块编码与亩数现取，不写死），各业务页面登录即有内容。演示账号：`agronomist`、`operator01`、`viewer01`（口令均为 `demo123`，`temp01` 为已停用账号）；需重置时删除主键带 `demo` 前缀的行后重跑迁移即可。
- 构建需要能访问 Docker Hub 与 npm 源；若镜像拉取超时，先配置镜像加速或代理。

### 提交前校验

```bash
# Windows 必做：把临时目录指进工作区，否则 vite/esbuild 报 "Access is denied"
export TEMP="$PWD/.tmp" TMP="$PWD/.tmp"

npx tsc -b                        # 全量类型检查与增量编译
npx vitest run                   # 全量单测
pnpm --filter @agri/web build    # 前端生产包（内部执行 vue-tsc -b && vite build）
```

- 只跑单个服务的测试：在**仓库根**执行 `npx vitest run apps/<service>`。`pnpm --filter @agri/<service> test` 会报
  `No test files found`——vitest 的 `include` 是 `apps/**/test/**/*.spec.ts` 这类仓库根相对路径。
- 前端单独校验：在 `apps/web` 目录内执行 `npx vue-tsc --noEmit -p tsconfig.json` 与 `npx vite build`；
  `vite build` 从仓库根跑会报 `Could not resolve entry module index.html`。
- 前端已去掉 `eslint` 脚本，代码风格靠上面的类型检查与构建把关。

### 镜像重建与增量上线

`app` 与 `edge` 都在 `profiles: ["app"]` 下，任何 compose 子命令都要带 `--profile app`；`postgres`/`minio` 无 profile，常驻。

```bash
# 前后端都改了：两个都要重建，只重建其一会出现「前端调用 404」
docker compose -f infra/docker-compose.yml --profile app build app edge
docker compose -f infra/docker-compose.yml --profile app up -d

# 只改前端：只重建 edge，不动 app、不动数据库
docker compose -f infra/docker-compose.yml --profile app build edge
docker compose -f infra/docker-compose.yml --profile app up -d --force-recreate --no-deps edge
```

### 上线后验证

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
docker compose -f infra/docker-compose.yml --profile app logs --tail=50 app edge

# 自签证书：从容器里取证书链，再用 curl 打网关
docker cp infra-edge-1:/etc/nginx/tls/fullchain.pem .tmp/fullchain.pem
TOKEN=$(curl -s --cacert .tmp/fullchain.pem -X POST https://localhost/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"admin123"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.token))")
curl -s --cacert .tmp/fullchain.pem -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/v1/plots/bounds | head -c 300

# 确认前端产物已含新代码（文件名带哈希，每次构建都变）
docker exec infra-edge-1 sh -lc "grep -rlF '新增阈值规则' /usr/share/nginx/html/assets | head -1"
```

页面级回归脚本默认打 `https://localhost`（可用 `BASE_URL` 覆盖）：`pnpm smoke:demo` 逐页校验演示数据、
`pnpm smoke:filters` 校验查询条筛选、`pnpm smoke:weather` 校验气象链路、`pnpm smoke:zones` 校验片区与导航。

### 本机端到端验证（不写演示库）

改动涉及写接口时，用一次性库把 15 个服务拉起来验，验完删库，演示库 `agri` 不受污染。

```bash
set -a && . ./.env && set +a                       # DB_URL 等本地配置只存在于 .env
export DB_URL=$(node -e "const u=new URL(process.env.DB_URL); u.pathname='/agri_verify'; process.stdout.write(u.toString())")
export ADMIN_URL=$(node -e "const u=new URL(process.env.DB_URL); u.pathname='/postgres'; process.stdout.write(u.toString())")
# 连 ADMIN_URL 执行 create database agri_verify，然后：
pnpm run build                # start-services.mjs 跑的是各服务 dist/main.js
node scripts/migrate-postgres.mjs
node scripts/start-services.mjs
```

- 端口用 `AGRI_<NAME>_PORT` 覆盖（如 `AGRI_GATEWAY_PORT=18081`），但 `start-services.mjs` 与
  `health-check.mjs` 读的是 `*_SERVICE_URL`，两边要一起给，否则服务间调用与网关反代仍指向默认端口。
- 本机代理常占用 3002/3003/3008/3010/8080 等端口，绑定报 `EACCES` 就把整段端口往后平移（如 13101-13114）。
- 前端另起 vite：`apps/web` 下 `npx vite --config <临时配置>`，把 `/api` 反代到本地网关；验完删除临时配置，
  `vite` 只监听 IPv6 的 `localhost`，用 `127.0.0.1` 访问会被拒。
- 收尾：`drop database agri_verify`（先 `pg_terminate_backend` 掉连接），删除临时 vite 配置与验证脚本。

## 二、目录结构

```
agri-platform-nodejs-scaffold/
├── package.json              # 根脚本与工程级开发依赖
├── pnpm-workspace.yaml       # 工作区与构建脚本白名单
├── turbo.json                # 任务编排（build / typecheck）
├── tsconfig.json             # 根工程引用清单，编译入口
├── vitest.config.ts          # 测试配置（@agri/* 直连源码，含装饰器语义）
├── scripts/clean.mjs         # 构建产物清理
├── packages/                 # 公共能力包与规范包
│   ├── tsconfig/             #   TypeScript 配置基座（base/library/nest/vue/strict）
│   ├── eslint-config/        #   代码规范与架构约束（依赖方向校验）
│   ├── shared/               #   通用工具：异常、时间、单位、分页、标识
│   ├── contracts/            #   接口契约：响应信封、事件、错误码、数据对象、枚举
│   ├── plot-core/            #   地块领域：六段式编码、校验位、网格、坐标系
│   ├── config/               #   配置加载与校验、密钥读取
│   ├── observability/        #   结构化日志、链路、指标、运行期采集器
│   ├── db/                   #   客户端生命周期、事务、分库路由、分页、软删除
│   ├── mq/                   #   事件发布订阅、本地消息表、重试死信、幂等
│   └── testing/              #   测试数据库、内存事件总线、可控时钟、夹具
└── apps/
    ├── gateway-service/      # 网关：最长前缀反向代理
    ├── plot-service/         # 地块建档、事件消费、装配示范
    ├── auth/platform/        # 认证与平台基础服务（角色、租户、审计）
    ├── iot/telemetry/weather # 感知：设备、遥测读数与告警、气象预报/预警/实时/农事建议
    ├── message-service/      # 消息中心：事件消费 + 消息落库
    ├── decision-service/     # 规则、处方、效果回流与问答
    ├── operation/control/    # 农事作业与水肥控制指令
    ├── finance/trace/video/  # 核算、溯源、视频与文件
    └── web/                  # 前端管理后台：Vue3 + Element Plus + ECharts
```

每个包的 `src/index.ts` 是该包唯一对外入口，包内其他文件不构成公开契约。

## 三、公共包清单

| 包 | 职责 | 运行时依赖 |
| --- | --- | --- |
| `@agri/tsconfig` | TypeScript 编译配置基座，全工程以继承方式引用 | — |
| `@agri/eslint-config` | 代码规范配置，含架构约束规则（依赖方向与跨层引用校验） | — |
| `@agri/shared` | 通用工具与常量：异常基类、时间、单位换算、分页、标识生成、服务侧权限守卫 | — |
| `@agri/contracts` | 接口契约与共享类型：响应信封、领域事件、错误码、权限目录、共享数据对象与枚举 | zod |
| `@agri/plot-core` | 地块领域模型与编码规则：六段式编码、校验位算法、网格换算、坐标系转换 | @agri/contracts, @agri/shared |
| `@agri/config` | 配置加载与校验：环境变量校验结构、启动期配置加载、密钥读取 | @agri/shared, @nestjs/common, zod |
| `@agri/observability` | 结构化日志、链路追踪、指标采集与运行期采集器 | @agri/shared, @nestjs/common |
| `@agri/db` | 数据访问封装：客户端生命周期、事务、分库路由、分页与软删除 | @agri/contracts, @agri/shared, @nestjs/common |
| `@agri/mq` | 消息与事件总线封装：发布订阅、本地消息表、重试死信与幂等 | @agri/contracts, @agri/shared, @nestjs/common |
| `@agri/testing` | 测试工具与夹具：测试数据库、内存事件总线、可控时钟、模块构造器 | @agri/contracts, @agri/db, @agri/plot-core, @agri/shared, @nestjs/testing |
| `@agri/plot-service` | 示例服务：地块建档、事件消费与装配示范（app，非公共包） | @agri/config, @agri/contracts, @agri/db, @agri/mq, @agri/observability, @agri/plot-core, @agri/shared, reflect-metadata, rxjs |

工程级开发依赖：`typescript`、`vitest`、`turbo`、`@types/node`、`@nestjs/common`、`rxjs`、
`reflect-metadata`、`zod`。

## 四、关键约定

- **地块编码是数据关联锚点**：六段式 `区划码-农场码-片区号-地块序号-网格号-校验位`，
  例如 `511723-000001-01-00001-0000-5`；地块级编码的网格段为空串，细分到网格时形如
  `511723-000001-01-00001-0101-Z`。业务代码不得自行拼接编码，统一走 `@agri/plot-core`。
- **契约包与能力包分离**：`@agri/contracts` 只依赖 `zod`，不依赖任何能力包，前端可低成本引用；
  能力包之间禁止循环引用。
- **空间运算下沉数据库**：`@agri/plot-core` 只做编码级与索引级计算，叠加、缓冲区一律
  落在 PostGIS 以 SQL 完成，坐标统一 CGCS2000（EPSG:4490），仅在出参方向换算为其他坐标系。
- **地块面积只有一个口径**：`plot_records.area_mu` 恒等于按边界几何重算的值，公式是
  顶点去重 → 取最大环 → 环重心平移到原点做等距圆柱鞋带 → 平方米除以 666.6667 换算亩，留 2 位。
  同一套算法有三份实现，必须一起改：`apps/web/src/utils/geo.ts` 的 `ringAreaMu`（绘制实时预览）、
  `packages/shared/src/area.ts`（后端服务与冒烟脚本）、`015_plot_area_from_boundary.sql`（存量行重算）；
  两份 TS 实现由 `apps/web/test/geo.spec.ts` 的「前后端面积口径一致」用例逐位钉住。
  地图绘制时的实时预览与保存后落库因此是同一个数；010 示范数据原先手填的面积与边界差了一半以上，
  就是靠迁移 015 统一掉的。**任何带边界的种子、夹具、脚本都不许写死面积**，一律调 `polygonAreaMu` 现算；
  地块编辑页在已绘制边界时禁用面积输入，只有尚未补边界的老地块才按申报面积记账。
- **合并要求相邻**：合并边界取源地块顶点凸包，而凸包只在地块首尾相接时才等于真并集，因此 `PlotService.mergePlots`
  先把所选地块按相邻关系分组（`merge.geometry.ts`：边相交 / 整块内含 / 间隙不超过 `PLOT_MERGE_ADJACENCY_M`，默认 5 米），
  连不成一片就 409 拒掉并回显分成几组，校验在事务前、零写入。拆分边界由操作人逐块绘制，两者面积都只认各自几何现算——
  合并**不做源面积求和**（求和会在凸包覆盖空地时造出新的台账漂移），拆分**既校验单块不超过原地块，
  也校验合计不超过原地块 + `0.01 × 子块数`**（`PlotService.splitPlot`，超限在事务前拒绝、零写入）。拆分页只把原边界
  预填进第 1 块子地块作参照，其余块从零画起：逐块复制整份原边界会让「只改一块」的切法把原面积重复计入，
  演示库曾因此多计 61.5 亩；合计超限时前端红字提示并禁用提交，与服务端同口径。
  连成一片但整体呈凹形时凸包仍会吞中间空地，所以合并弹窗先调 `POST /api/v1/plots/merge-preview`
  （`PlotService.previewMerge`，与真实合并共用 `mergeGeometry` 的相邻判定与凸包面积，只算不写）回显
  「源面积合计 / 合并后边界面积 / 凸包多出多少亩」，不相邻或顶点不足时直接禁用提交，不让操作人点了才吃 409。
  差额是台账面积之和与落库同一算法的凸包面积相减，不接受手填。差额为正时，合并成功后会直接给出
   「编辑合并后边界」入口，跳到新地块的编辑页手工改边界（面积仍按改后边界现算），避免操作人找不到改边界的路。
- **删除就是归档**：业务台账的「删除」一律是置 `deleted_at`（地块 `001`、片区 `009`、管线 `024`、种植季 `026`、农事任务 `037`），
  行留在库里，读路径（列表、详情、状态跃迁）统一带 `deleted_at IS NULL`；物理 `DELETE` 只出现在测试夹具的清理里。
  归档只盖时间戳，不改业务状态也不 bump `version`——「还在不在册」与「这单活走到哪一步」各记各的，
  历史行仍按归档前最后一次跃迁读。删除不校验业务状态（与地块口径一致），要中止一次作业用的是「取消」。
  归档行**可回查但只读**：农事任务列表用三态 `archived=NONE|ONLY|ALL`（缺省 `NONE` 只看在册）筛选，
  同一条件同时进 count 与分页查询，总数与页内行数不会各算一套；详情要显式带 `includeArchived=true` 才放行，
  状态跃迁与再次删除仍带 `deleted_at IS NULL`，前端对归档行也不给这些按钮（按了必 404）。
   任务变更另走追加式留痕（迁移 `039`）：建档 / 状态跃迁 / 归档各写一行 `operation_task_change_logs`，
   `actor` 取网关注入的 `x-user-id`（缺省 `system`），与状态更新同语句落库；`GET /api/v1/farm-tasks/:id/history`
   回看操作轨迹，归档任务同样可查，详情页以「操作历史」区块展示。
- **事件不丢也不重**：决策 / 遥测 / 农事 / 地块 / 控制服务把业务数据与待投递事件写入同一事务（各自 `*_outbox` 表），
  事务提交后由中继投递；消费侧用 `eventId` 幂等去重，重试按指数退避，超出次数转死信。
  地块建档走 `plot_outbox`（迁移 028），SQL 模式 HTTP 启动后周期性中继把 `PlotCreated` 写入共享 `event_log`，
  跨进程可靠；`message-service` 已订阅 `PlotCreated` 生成「地块建档通知」（模板渲染 → 偏好过滤 → 落库，按 `eventId` 幂等）。
  控制指令的超时收口走同一套 `control_outbox`（迁移 033）：收口任务在事务内改状态并入队，中继再投递。
  灌溉与施肥指令结单也走这一张表：`DONE` 回执在同一事务里推 `control.irrigation.finished` / `control.fertilization.finished`，状态落空（版本被抢）则不入队。
- **跨进程事件靠事件日志**：`event_log` 按主题递增位点，`event_log_offsets` 记录消费者组位点；
  生产侧用 `EventLogPublisher`，消费侧用 `EventLogConsumer` 轮询，便于横向扩容与重放。
- **处方要能被调优**：处方执行后必须回写实际效果，`evaluateOutcome` 给出阈值建议，
  由调用方决定是否写回规则，阈值调整记录随评估留痕。
- **账号与角色分域存储**：`auth_users`/`auth_user_roles` 属于认证域，`platform_roles`/
  `platform_role_permissions` 属于平台域，用户只存角色编码；口令以 scrypt 散列入库
  （每口令独立随机盐，存储格式 `scrypt$N$r$p$salt$hash`），登录时兼容并把历史 sha256 就地升级。
  `AUTH_REPOSITORY_MODE` / `PLATFORM_REPOSITORY_MODE`
  不设或设为 `sql` 时随 `DB_URL` 落库，设为 `memory` 时退回内存实现。
- **事件消费方只做翻译**：`control-service` 把「土壤含水率低于下限」与灌溉/施肥处方
  翻译成自动指令（执行人 `system:event`、保留 `sourceEventId`），`trace-service` 把处方
  写入生产档案（追溯码 `TR-PRES-<eventId>`）、把作业结单写成作业档案（灌溉 `TR-IRR-<指令id>`、施肥 `TR-FERT-<指令id>`），
  `decision-service` 消费结单事件把实际水肥用量回流到来源处方（`decision_prescription_executions`，迁移 034）；
  重复事件由幂等键、指令唯一索引与档案追溯码三层兜住。植保处方与其它指标越限不自动下令，仍由消息中心提醒人工处置。
- **指令要有回执才算下过**：控制指令走 `QUEUED → SENT → ACKED → DONE`，任一在途状态都可被 `FAILED` 收口，
  终态不可再改；跃迁表 + `version` 乐观锁在 `control.repository.ts`，设备通道 `POST /control/device/dispatch`
  领取、`POST /control/device/receipt` 回执（迁移 031 补时间戳、结果快照与时序 CHECK）。该通道与遥测、视频 AI
  回调共用 `DEVICE_CALLBACK_TOKEN`，路径特意做成扁平的 `/device/*` 而非挂在 `/commands` 下——白名单匹配是
  前缀式的，挂上去等于把建指令的写权限一起交给设备令牌。急停（`ESTOP`）的 `DONE` **必须**带
  `result.confirmed=true`，服务端拒绝「没人确认设备真停了」就结单。超时未回执**既可见、也会被自动收口**：
  `pendingMin`/`overdue` 由 `COALESCE(acked_at, sent_at, created_at)` 与 `CONTROL_RECEIPT_TIMEOUT_MIN`（默认 15 分钟）
  现算，`ControlReceiptSweeper` 每 `CONTROL_RECEIPT_SWEEP_INTERVAL_MS`（默认 60 秒）用**同一个** SQL 谓词跨租户捞出
  在途超时指令，走合法跃迁置 `FAILED`，并**在同一事务**写 `control_outbox`（迁移 033）；中继按
  `CONTROL_OUTBOX_RELAY_INTERVAL_MS` 把 `control.command.timeout` 投进共享事件日志，消息中心据此生成告警
  （急停为 CRITICAL，其余 WARNING，按指令 id 聚合不刷屏）。收口与迟到的真实回执抢同一个 `version`，
  先到先得：谁先落到终态另一边拿 409，不悄悄覆盖任何一侧的结果，「设备到底做没做」交给超时告警去人工确认。
  演示种子 `010` 里那几条一直停在 QUEUED/SENT 的指令由迁移 `036` 预先收口成 `FAILED`（只认 `cmd-demo-` 前缀且仍在途的行，
  留言按「已下发未回执」「入队未下发」分开写明是演示数据收口、不是设备故障），这样 control-service 一起来不会给演示库
  推五条没人认领的超时告警；036 **不**回填 `sent_at`/`acked_at`（031 的理由依旧成立），也**不**往 `control_outbox` 投递事件。
  现场自己下的超时指令仍归收口任务处理——它才会连带推告警。
  水肥类指令结单（`DONE` + `IRRIGATION`/`FERTILIZATION`）不再只改状态：同一事务推对应主题，把「灌了多少水、施了多少肥、
  作业多久」回流给档案与消息中心。数值只有两条正路——设备在 `result` 里实测上报（`DEVICE`），或按指令分区参数
  现算方案总量（`PLAN`：灌溉取 `totalWaterVolume`，施肥取配方千克/亩 × 分区面积合计的 `totalKg`）/按状态推进时间
  现算时长（`RUNTIME`）；两条都走不通就留空并在文案里明说「用水量/施肥量未上报」，不拿估算冒充实测。
  阈值自动指令只带含水率与阈值、施肥与多明细处方推不出分区，这些指令没有 `plan`，结单事件就带不出用量字段——这是事实，不是漏发；
  单条灌溉处方现在带台账面积与分区，结单能按 `PLAN` 现算用水量（仍缺氮磷钾配比，施肥千克数照旧留空）。
  播种、除草、急停没有可核对的作业量，不发结单事件。该档案**不支持人工补录**：
  `POST /trace/records` 收到 `IRRIGATION_FINISHED`/`FERTILIZATION_FINISHED` 直接 400，前端新增弹窗的事件下拉里也没有这两项。
  处方下发的指令会把 `prescriptionId` 一路带进结单事件，`decision-service` 据此把实际用量回流到
  `decision_prescription_executions`（`GET /api/v1/decision/executions?prescriptionId=` 可查，按指令 id 幂等）；
  人工指令没有处方标识，回流直接跳过，效果评估（`POST /prescriptions/:id/outcome`）仍由人工在拿到复测墒情后触发。
- **现场设备由平台侧网关下发**：泵、阀、水肥机讲的是 Modbus TCP——主站问、从站答，从站永远不主动连平台，
  所以「等设备回调」这条老路对它们不成立。`apps/iot-service/src/modbus-tcp.ts` 把主站一侧做实（MBAP 组帧、
  FC02 读离散输入、FC03 读保持寄存器、FC05 写线圈、异常响应与粘包定界），`field-gateway.ts` 的 `FieldGateway`
  按台账轮询 `GET /control/device/pending`，领取后写线圈、回读运行/故障反馈，**回执仍走设备回调那两条接口**，
  因此人工回填、超时收口、结单事件不必为它另开口径（`FIELD_GATEWAY_ENABLED=1` 才启动，默认关）。
  协议与接入点位入台账（迁移 `038`）：`devices.protocol` + `binding` JSONB，CHECK 与仓储校验保证**协议与绑定同生同灭**
  （改成回调式必须清掉绑定，改成现场协议必须给地址与剖面，剖面与设备类型不匹配直接 400）；线圈/反馈/故障/计量寄存器、
  32 位字序与倍率都在 `MODBUS_PROFILES` 里按剖面定义，不散落在设备地址或前端文案。
  **点位与缺省值只有一份**：`GET /api/v1/devices/field-access` 由服务端给出协议（含 `requiresBinding`）、剖面
  （含 `applicableTypes` 与计量单位）和端口/单元标识/超时缺省，前端配置弹窗只渲染这份目录（留空即由服务端补缺省），
  冒烟脚本的假从站也从同一张剖面表取点位。「开多久、开到多少」只认指令里 `parameters.plan`（入队时控制侧按分区
  面积与灌水定额现算）或显式 `parameters.durationMin`；两个都没有就在碰硬件之前判 `FAILED`——把阀门开到一个没人
  规定的时刻再收比拒绝执行更危险。包络在**入队时**就算好：人工下发与事件消费两条路都调同一个
  `executionPlanOf`（`command-spec.ts`）写 `parameters.plan`，消费侧不再只写 `items` 就入队。
  处方自动指令只有「单条灌溉明细 + 地块台账面积」能无歧义地推出分区（面积由 `decision-service` 生成处方时
  从地块服务取，随 `PrescriptionIssuedPayload.areaMu` 带出，**不接受请求体自报**；定额就是明细的毫米数，
  上限沿用 0~100），其余情况一律不猜，写 `parameters.envelopeBlocked` 说明原因，网关判 `FAILED` 时把这句话
  原样回给台账：施肥处方缺灌水定额与料液密度、多明细处方缺分区面积分摊口径、越限补灌只带含水率与阈值、
  台账面积缺测。有累计寄存器时按计划量提前
  收口并上报**作业期间的增量**（不是表计读数），故障输入置位则先把线圈收回位再报失败，不给现场留一个挂在打开位的阀门。
- **台账按租户隔离**：迁移 `032` 给 `control_commands` 补 `tenant_id`、迁移 `035` 给 `devices` 补 `tenant_id`
  （都取 `DEFAULT 'tenant-demo'`，存量行含 `010`/`014` 种子全部属演示租户，常量默认值不重写表）。仓储的读、写、
  跃迁都以 `tenantId` 为首参，跨租户的 id 一律当作不存在——查不到 404、跃不动返回 `null` 翻成 409，与
  `operation_tasks`/`video_ptz_commands` 同口径；`014` 那句「设备域按全局台账」由 `035` 注释逐字校正。
  设备编号的唯一口径随之从全局改为 `(tenant_id, device_no)`，两个农场登记同型号设备（出厂编号相同）不再互相撞号。
  归属只认网关透传的可信身份头（客户端自报的同名头在网关已被丢弃，请求体里的 `tenantId` 不参与），自动指令
  则跟着事件信封的 `tenantId`；设备回调与台账接口没有会话身份时落到进程 `TENANT_ID`，再退演示租户。
- **消息先过偏好再去重**：消息文案与去重键在 `@agri/contracts` 的 `MESSAGE_TEMPLATES` 登记，
  契约包只做纯函数渲染；`buildMessageDraft` 直接从该表取渲染函数，注册即生效，不再另写一份分支表
  （此前两套真相漏了超时主题，导致 `control.command.timeout` 告警实际发不出）。消费侧先查「租户 + 主题」偏好：关闭订阅直接跳过，低于最低级别也跳过；
  越限告警按「地块 + 指标 + 方向 + 小时」聚合，处方通知按来源事件唯一。没有偏好记录等同
  「全部启用、最低 INFO」，新增主题无需初始化数据。
- **数据库时间列统一走 `toIsoTimestamp`**：pg 驱动把 `TIMESTAMPTZ` 解析为 `Date`，直接用
  `String()` 映射会得到本地化文本，写回 SQL 时报 `invalid input syntax for type timestamp`；
  所有 SQL 仓储的时间字段一律经 `@agri/shared` 的 `toIsoTimestamp` 转为 ISO 字符串。
- **权限在网关收口**：权限目录（8 组 22 码）在 `@agri/contracts` 唯一定义，`*` 与 `领域:*` 为通配；
  网关先按「方法 + 路径」算出所需权限，再调 auth/platform 的内部接口解析会话与角色权限（短时缓存），
  未登录 401、无权限 403 直接返回，不触达下游；转发时只下发网关解析出的
  `x-user-id`/`x-tenant-id`/`x-permissions`，客户端伪造的同名头一律丢弃。
- **服务侧守卫是第二道闸**：`@agri/shared` 的 `authorizeRequest` 按同一套权限码再判一次，
  默认关闭（本地直连脚本与单测不带身份头），部署时 `AUTH_GUARD_MODE=enforce` 开启；
  内部接口放在 `/api/v1/internal/*`（不在网关路由表内），用 `x-internal-token` 保护。
- **账号权限 = 角色权限 ∪ 直授权限**：登录与 `userinfo` 返回合并后的有效权限，前端据此过滤菜单、
  拦截路由（`meta.permission` → `/403`）；平台服务不可用时退回直授权限，不阻断登录。
- **消费结果可直接核对**：设备管理下的「控制指令」页按地块与来源（自动/人工）筛选，展示指令缘由与
  `sourceEventId` 便于回溯；生产档案页可按事件类型筛选，下拉选项由
  `@/utils` 的 `traceEventOptions` 统一派生（新增弹窗用剔除设备专属事件的 `manualTraceEventOptions`，灌溉完成与施肥完成都在剔除之列），事件列以标签区分。
- **全站统一条件查询**：地块、设备、农事任务、控制指令、投入产出、溯源档案、视频监控、四情、消息等页面
  统一提供「关键词 + 枚举下拉 + 时间区间 + 重置 + 分页」查询条，筛选全部下沉服务端；
  地块台账补充类型/状态/当前作物/负责人字段（迁移 011），投入产出页汇总卡片与列表同一套条件联动。
- **错误码分段**：域缩写-分类码-序号（如 `PLOT-409-001`），含义一经发布不得修改。
- **气象数据可插拔（默认仅读本地 DB）**：`weather-service` 前端接口（`/forecast` `/forecast/hourly` `/advice` `/alerts` `/history` `/realtime`）**只读本地 `weather_forecasts` / `weather_forecast_hours` / `weather_alerts` 三张表**（无 DB 时回退 `demo.ts` 内存种子），页面刷新不会触发任何外部请求。配置 `QWEATHER_KEY` 后 `sync.ts` 定时同步器默认 **每日一次**（`forecastRefreshMinutes=1440` / `alertRefreshMinutes=1440`）拉取和风 v7 API 落库；启动时会先判断 `lastRefreshedAt`，若仍在周期内则跳过初次同步；内置 **每日调用硬上限 `dailyCallLimit=20`**（跨自然日自动清零）防止异常场景频繁重启浪费免费额度。个人开发者免费 Key 每日≈1000 次，本项目默认一天 2 次远低于额度。失败降级不抛异常，接口仍返回旧数据。`/forecast` 等端点返回 `dataSource: "demo"|"sql"|"qweather"|"local"`；运维可通过 `GET /api/v1/weather/sync-status` 查看 `todayCalls` / `dailyCallLimit` / `lastForecastSyncAt`。**管理员强制同步**：`POST /api/v1/weather/sync-now`，需 `weather:sync` 权限（admin 默认通配覆盖），**bypass `dailyCallLimit`** 不走上限判定，适合现场临时拉取最新预报；网关与服务双侧均拦截非管理员，前端 `views/weather/Index.vue` 仅对具备 `weather:sync` 的用户展示“强制同步和风天气”按钮与额度面板。实时气象站读数不取和风 `/now`，仍从 telemetry-service 取田间气象站上报。
- **时序数据不在 `@agri/db` 范围内**：由物联感知服务直连时序库；缓存由各服务自行使用缓存中间件。

## 五、已验证结果

在本机 Node.js 24.16.0 / pnpm 12.16.1 环境下实际执行；2026-11-05 按交付清单完成全量复验
（build、test、web build、9 个冒烟脚本与业务增强冒烟全部通过）；2026-11-12 回执链路与现场硬件协议
批次另做全量复验（`pnpm run build`、`npx vitest run` 651 passed / 0 失败、`vue-tsc -b --force`、
`smoke:receipt` / `smoke:events` / `smoke:consumers` / `smoke:protocol` 四条冒烟全 PASS，演示库无残留）：

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 全量编译 | `pnpm run build` | 通过 |
| 测试 | `pnpm test` | 44 个测试文件、190 个用例全部通过（带 `DB_URL` 时 SQL 用例不再跳过） |
| 前端类型检查 | `pnpm --filter @agri/web exec vue-tsc -b` | 通过 |
| 事件闭环联调 | `pnpm exec vitest run apps/message-service/test/event-closure.spec.ts` | 通过：越限/处方事件 → 消息 → 已读 → 效果回流 → 规则阈值写回 |
| 全量服务冒烟 | `pnpm smoke:services` | 15 个 HTTP 服务启动并健康检查通过 |
| 事件闭环冒烟 | `pnpm smoke:events` | 通过：越限/处方事件 → 事件日志 → 消息中心 → 效果回流（建议 30→35 写回规则） |
| 系统管理链路 | `pnpm smoke:gateway` | 通过：未登录 401 → 登录 → 地块 → 控制二次确认 → 角色/用户创建与停用拦截 → 越权 403 |
| 权限校验 | `pnpm smoke:authz` | 通过：网关 401/403 拦截、登录合并角色权限、服务侧守卫（缺身份 401/缺权限 403/有权限 200） |
| 账号角色落库 | `pnpm smoke:identity` | 通过：创建角色与用户后重启服务，仍可登录且角色权限、审计日志仍在 |
| 事件消费方 | `pnpm smoke:consumers` | 通过：越限与处方各生成一条自动指令，处方写入追溯档案，重复轮询不重复下发 |
| 消息订阅偏好 | `pnpm smoke:messages` | 通过：关闭订阅零消息、最低级别门槛、同小时去重、偏好持久化 |
| 业务增强 | `node .runtime/verify-agro.mjs` | 通过：四情规则 7 条、虫情上报与处置、视频 AI 回调、灌溉方案预演（133.34 m³ / 400 min）、水肥参数拦截、管网增删 |
| 片区与导航 | `pnpm smoke:zones` | 通过：示例片区就绪、建档/重码 409、划入与凸包、按片区过滤、机耕道沿路导航与历史方案、有地块时删片区 409、清理 |
| 演示数据逐页校验 | `pnpm smoke:demo` | 通过：37 项全 PASS（迁移 011 与条件查询改造后无回归） |
| 条件查询冒烟 | `pnpm smoke:filters` | 通过：38 项全 PASS——地块类型/状态/土壤/作物/面积/非法枚举 400、设备类型/状态/地块/分页、任务与指令枚举+时间区间、核算筛选+汇总联动、溯源、视频、四情（指标/级别/虫情/总览联动）、消息级别与时间区间 |
| 气象服务冒烟 | `pnpm smoke:weather` | 通过：13 项全 PASS——五日预报、作业提示+适宜性、逐小时 24 时次、days=2、预警、非法 level 400、实时气象站、农事建议、要素目录、历史曲线、非法 metric 400、决策处方 rainProbabilitySource=weather |
| 回执链路冒烟 | `pnpm smoke:receipt` | 通过：下发确认 → 设备领取 → ACKED → DONE（急停靠 `confirmed` 到位）→ 结单事件入 `control_outbox` 与 `event_log` → 超时收口 |
| 现场硬件协议冒烟 | `pnpm smoke:protocol` | 通过：独立实现的假 Modbus 从站 + 真实 TCP + 真实演示库——接入目录（协议/剖面/缺省值）→ 现场协议建档三种 400 → 缺省值按目录补齐 → 协议⇄绑定同生同灭 → 灌溉指令由网关写到线圈并靠反馈结单（线圈「开一次关一次」，上报量为表计增量而非累计读数，`waterVolumeSource=DEVICE`）→ 无执行包络的指令不动硬件直接失败 → 急停靠反馈消失到位 → 故障输入置位先关线圈止损 → 回调式设备网关不接管 |
| 示例服务 | `pnpm run start:plot` | 建档、中继、消费、幂等链路跑通，输出如下 |

```json
{
  "service": "plot-service",
  "parcelCode": "511723-000001-01-00001-0000-5",
  "areaMu": 12.5,
  "gridCode": "511723-000001-01-00001-0101-Z",
  "handledEventCount": 1,
  "deliveredEventCount": 1
}
```

其中事件被投递两次，`handledEventCount` 仍为 1，即幂等生效。

测试覆盖：编码生成与校验、单位换算与自然日切分、配置校验与密钥缺失、事务边界与可重试错误判定、
分页白名单与软删除条件、消息表中继与投递失败重发、幂等与重试死信、测试工具自身、示例服务建档链路、
事件日志位点续读、消息中心事件消费与未读统计、消息模板与订阅偏好过滤、处方效果评估与阈值建议、三服务事件闭环联调、
权限目录与通配判定、网关路由权限策略与会话缓存、服务侧 401/403 守卫、auth/platform 内部接口、档案按事件类型筛选。

## 六、扩展指引

- **新增业务服务**：复制 `apps/plot-service` 结构；根 `tsconfig.json` 增加一条工程引用；
  在服务根的 Nest 模块里按需导入 `ConfigModule.forRoot`、`PrismaModule.forRoot`、`MqModule.forRoot`。
- **接 HTTP 适配器**：示例服务刻意不启动监听进程，接入 `@nestjs/platform-fastify` 后由
  `AppModule.forRoot` 托管生命周期即可；高并发接入场景建议使用 Fastify 适配器。
- **新增事件**：先在 `@agri/contracts` 的 `EventTopic` 与 `events/payload.ts` 中定义主题与载荷，
  再在生产者侧用 `OutboxService.enqueue` 入队、消费者侧用 `@registerHandler` 声明处理方法。
- **新增表与仓储**：在服务内定义模式，仓储方法首参显式传入事务对象，避免事务边界静默扩大。

## 七、备份与恢复

系统备份覆盖**代码 + 数据库 + 配置**，产物落在 `BACKUP_DIR`（默认 `backups/`）下的 `<时间戳>` 目录，附 `manifest.json` 清单（提交号、各分片大小与 sha256），并按 `BACKUP_KEEP` 保留最近若干份。

```powershell
# 全量备份（代码 + 数据库 + 配置）
pnpm backup:system
# 只备份数据库 / 只备份代码
pnpm backup:system -- --db-only
pnpm backup:system -- --code-only
# 附带 .env 与私钥等敏感配置（默认不备份）
pnpm backup:system -- --include-secrets
# 列出已有备份 / 控制保留份数
pnpm backup:system -- --list
pnpm backup:system -- --keep 5
```

代码备份基于当前 Git 提交（`git archive`），**未提交的改动不在代码包内**；数据库备份优先用本机 `pg_dump`，本机没有时回退到 `docker compose exec postgres pg_dump`。

```powershell
# 查看可用备份
pnpm restore:system -- --list
# 恢复代码到指定目录
pnpm restore:system -- --from 20261114-120000 --only code --target ./restore
# 恢复数据库（默认恢复到 DB_URL 指向的库，可用 --db 指定目标库）
pnpm restore:system -- --from 20261114-120000 --only db --db agri_restore_test
```

数据库恢复同样优先用本机 `pg_restore`，其次 `docker compose exec postgres pg_restore`。备份与恢复脚本为运维脚本，不参与 `tsc -b`。

## 八、注意事项

- **装饰器元数据**：生产编译（`@agri/tsconfig/nest.json`）已开启 `experimentalDecorators` 与
  `emitDecoratorMetadata`；测试期由 esbuild 转译，仅开启前者。因此测试中构造的提供者应显式声明
  `inject`，不要依赖类型元数据自动注入。
- **数据库与消息中间件**：示例工程用内存实现替代真实中间件，仅用于验证装配关系与调用链；
  接入真实数据库时需实现 `PrismaClientFactory`，接入真实消息中间件时需实现 `EventPublisher` 与
  `EventSubscriber`。
- **Windows 下的 Vite 构建**：若 `vite build` 报 `[vite:esbuild-transpile] ... Access is denied`（esbuild 清理
  系统临时目录失败），把 `TEMP`/`TMP` 指到工作区内目录后重试：
  ```powershell
  New-Item -ItemType Directory -Force .tmp | Out-Null
  $env:TEMP = "$PWD\.tmp"; $env:TMP = "$PWD\.tmp"
  pnpm --filter @agri/web exec vite build
  ```
- **`@agri/eslint-config`**：规范包已就位，但本次未安装 ESLint 运行；启用前需先在工程内加入
  `eslint` 依赖并按需引用 `base` / `typescript` / `nest` / `vue` / `architecture` 配置。









docker compose -f infra/docker-compose.yml --profile app ps          # 状态
docker compose -f infra/docker-compose.yml logs -f app               # 应用日志
docker compose -f infra/docker-compose.yml --profile app up -d --build   # 改代码后重建
docker compose -f infra/docker-compose.yml down                      # 停应用（不加 profile 只起 PostGIS/MinIO）
