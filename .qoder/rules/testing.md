---
trigger: model_decision
description: 编写或修改单元测试（*.spec.ts）、scripts/ 下冒烟与运维脚本、为服务或数据库补充种子/演示数据时必须加载本规则
---

# 测试与冒烟脚本规范

## 单元测试

- 统一 Vitest（根 `vitest.config.ts`）；修改业务逻辑后必须运行 `pnpm exec vitest run`。
- 新增种子/演示数据前先读该服务既有 test 文件，名称、数量、关键字不得与既有断言冲突。
- `InMemory*Repository` 构造函数默认值保持空态（repository.spec 直接 new 后断言汇总数）；演示条目在 main.ts 组合根注入。

## 冒烟脚本（scripts/smoke-*.mjs）

两类脚本，前置条件不同：
- **自拉起型**（smoke-gateway / smoke-services / smoke-authz / smoke-identity / smoke-events / smoke-consumers / smoke-decision-telemetry / smoke-device-protocol / smoke-command-receipt / smoke-message-preferences）：脚本自己 spawn `apps/*/dist/main.js`，改源码后必须先 `pnpm run build`。其中 gateway/services/authz 不依赖数据库；identity 必须显式设置 `DB_URL`（缺失直接 SMOKE FAIL）；其余默认回退脚本内置的本地 agri 库连接常量，可用 `DB_URL` 覆盖，但库必须已执行迁移。
- **外部网关型**（smoke-filters / smoke-demo-data / smoke-zones-navigation / smoke-weather）：不拉起服务，直接打已运行部署的网关（`BASE_URL` 默认 `https://localhost`），须先经 start-services 或 Docker 启动全套服务并完成迁移。
- 根 package.json 提供别名：`pnpm smoke:gateway / smoke:services / smoke:authz / smoke:identity / smoke:events / smoke:consumers / smoke:decision-telemetry / smoke:protocol / smoke:receipt / smoke:messages / smoke:zones / smoke:demo / smoke:filters / smoke:weather`。

自拉起型脚本的编写范式（以 smoke-device-protocol.mjs 为准）：

- 纯 ESM Node.js 脚本；子进程统一经 `start(name, entry, env)` 拉起 `apps/*/dist/main.js`，注入 `DB_URL`、`SERVICE_MODE=http` 与端口配置，用 children 数组追踪并在 finally 统一 kill。
- 等待异步收敛一律 deadline + 轮询（waitHealth / waitRows / waitCommand 模式），禁止固定 `setTimeout` 赌时序。
- 断言用自实现 `assert(condition, message)`，失败消息携带当前状态 JSON。
- 外部副作用（子进程/HTTP/DB/socket）均 try/catch，失败写 `SMOKE FAIL` 日志并置 `process.exitCode = 1`，finally 统一清理资源。
- 测试数据隔离：用常量前缀（如 PLOT）标记 plot_code/parcelId，cleanData 按该前缀清理相关表，不得污染演示数据。

## 回归选择

- 跨服务事件链路改动 → smoke-events / smoke-consumers / smoke-decision-telemetry。
- 鉴权与权限改动 → smoke-authz / smoke-identity / smoke-gateway。
- 设备协议与控制指令改动 → smoke-device-protocol / smoke-command-receipt。
- 查询过滤改动 → smoke-filters；消息偏好改动 → smoke-message-preferences；片区/导航改动 → smoke-zones-navigation；气象改动 → smoke-weather；演示数据完整性 → smoke-demo-data。（后四者为外部网关型，需先有运行中的部署。）