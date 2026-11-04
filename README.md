# 智慧农业平台 Node.js 工程脚手架

以**地块**为最小管理单元、不限经营规模的智慧农业平台后端工程骨架。本仓库把前一阶段的
方案文档落成可编译、可运行、可测试的代码：公共包、15 个 HTTP 微服务和 Vue 管理后台，全部通过工程引用
（Project References）串成一条构建链。

- 运行时：Node.js 24 LTS
- 框架：NestJS 11 + TypeScript 5.9
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
| `pnpm init:minio` | 创建 S3/MinIO bucket |
| `pnpm health:infra` | 检查 PostgreSQL 和 MinIO |
| `pnpm db:migrate` | 使用 `DB_URL` 执行 PostgreSQL 初始化迁移 |
| `pnpm --filter @agri/web dev` | 启动前端开发服务器 |
| `pnpm --filter @agri/web build` | 构建前端生产包 |

> 说明：`pnpm install` 需要放行 esbuild 的安装脚本（已在 `pnpm-workspace.yaml` 的
> `allowBuilds` 中白名单化）。若安装报 `ERR_PNPM_IGNORED_BUILDS`，检查该配置是否被改动。

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
    ├── plot-service/         # 地块建档、事件消费、装配示范
    └── web/                  # 前端管理后台：Vue3 + Element Plus + ECharts
```

每个包的 `src/index.ts` 是该包唯一对外入口，包内其他文件不构成公开契约。

## 三、公共包清单

| 包 | 职责 | 运行时依赖 |
| --- | --- | --- |
| `@agri/tsconfig` | TypeScript 编译配置基座，全工程以继承方式引用 | — |
| `@agri/eslint-config` | 代码规范配置，含架构约束规则（依赖方向与跨层引用校验） | — |
| `@agri/shared` | 通用工具与常量：异常基类、时间、单位换算、分页、标识生成 | — |
| `@agri/contracts` | 接口契约与共享类型：响应信封、领域事件、错误码、共享数据对象与枚举 | zod |
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
- **空间运算下沉数据库**：`@agri/plot-core` 只做编码级与索引级计算，叠加、缓冲区、面积一律
  落在 PostGIS 以 SQL 完成，坐标统一 CGCS2000（EPSG:4490），仅在出参方向换算为其他坐标系。
- **事件不丢也不重**：业务数据与待投递事件写入同一事务（本地消息表），事务提交后由中继投递；
  消费侧用 `eventId` 幂等去重，重试按指数退避，超出次数转死信。
- **软删除统一字段**：`deletedAt`；分页每页上限 200，排序字段必须命中服务端白名单。
- **错误码分段**：域缩写-分类码-序号（如 `PLOT-409-001`），含义一经发布不得修改。
- **时序数据不在 `@agri/db` 范围内**：由物联感知服务直连时序库；缓存由各服务自行使用缓存中间件。

## 五、已验证结果

在本机 Node.js 24.16.0 / pnpm 12.16.1 环境下实际执行：

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 全量编译 | `pnpm run build` | 通过 |
| 测试 | `pnpm test` | 15 个测试文件、60 个用例全部通过 |
| 全量服务冒烟 | `pnpm smoke:services` | 15 个 HTTP 服务启动并健康检查通过 |
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
分页白名单与软删除条件、消息表中继与投递失败重发、幂等与重试死信、测试工具自身、示例服务建档链路。

## 六、扩展指引

- **新增业务服务**：复制 `apps/plot-service` 结构；根 `tsconfig.json` 增加一条工程引用；
  在服务根的 Nest 模块里按需导入 `ConfigModule.forRoot`、`PrismaModule.forRoot`、`MqModule.forRoot`。
- **接 HTTP 适配器**：示例服务刻意不启动监听进程，接入 `@nestjs/platform-fastify` 后由
  `AppModule.forRoot` 托管生命周期即可；高并发接入场景建议使用 Fastify 适配器。
- **新增事件**：先在 `@agri/contracts` 的 `EventTopic` 与 `events/payload.ts` 中定义主题与载荷，
  再在生产者侧用 `OutboxService.enqueue` 入队、消费者侧用 `@registerHandler` 声明处理方法。
- **新增表与仓储**：在服务内定义模式，仓储方法首参显式传入事务对象，避免事务边界静默扩大。

## 七、注意事项

- **装饰器元数据**：生产编译（`@agri/tsconfig/nest.json`）已开启 `experimentalDecorators` 与
  `emitDecoratorMetadata`；测试期由 esbuild 转译，仅开启前者。因此测试中构造的提供者应显式声明
  `inject`，不要依赖类型元数据自动注入。
- **数据库与消息中间件**：示例工程用内存实现替代真实中间件，仅用于验证装配关系与调用链；
  接入真实数据库时需实现 `PrismaClientFactory`，接入真实消息中间件时需实现 `EventPublisher` 与
  `EventSubscriber`。
- **`@agri/eslint-config`**：规范包已就位，但本次未安装 ESLint 运行；启用前需先在工程内加入
  `eslint` 依赖并按需引用 `base` / `typescript` / `nest` / `vue` / `architecture` 配置。
