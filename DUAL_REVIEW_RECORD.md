# 双人复核记录

本记录登记需要**双人复核**的关键改动，作为交付验收流程的执行载体。**第一复核人**由本会话完成自查并填写结论；**第二复核人**须由指定的复核人逐项确认并在确认栏签字，本记录**不代填**第二复核人结论，避免臆造。

**约定**：按长期交付口径，功能改动**未跑**单元测试 / `tsc -b` / 构建 / 冒烟 / 浏览器实操，下列「未跑验证」项需第二复核人明确是否接受。

## 复核对象

| # | 改动 | 范围 | 复核要点 | 第一复核人 | 第二复核人 |
| --- | --- | --- | --- | --- | --- |
| 1 | 迁移 `039` 任务变更留痕 | `infra/postgres/migrations/039_operation_task_change_logs.sql`、`task-change-log.repository.ts`、`TaskRepository`、`GET /farm-tasks/:id/history`、前端详情「操作历史」 | ① 新表追加式留痕，动作 `CREATE/TRANSITION/ARCHIVE`；② **不建外键**，`task_id` 纯文本引用，任务归档后历史仍留存；③ `actor` 取网关 `x-user-id`，内部触发记 `system`，与地块留痕同口径；④ `create`/`transition`/`remove` 用 **CTE 同语句**写留痕，状态更新与留痕同成同败；⑤ 历史从迁移起记录，**不回填**存量任务；⑥ 幂等重放（重复置同一状态）直接回读，不重复写留痕；⑦ 归档任务也可回查历史 | 已自查，口径与实现一致，未发现阻断项 | 待确认 |
| 2 | 凹形合并手工改边界入口 | `apps/web/src/views/plot/List.vue` `submitMerge()` | ① 仅当预演 `deltaMu > 0`（凸包吞中间空地）时用 `ElMessageBox.confirm`，确认按钮跳 `/plot/edit/<merged.parcelCode>`；② 取消/关闭留在列表刷新；③ 无差额维持原提示；④ **不新增后端接口、不改合并语义** | 已自查，改动最小、无新增接口 | 待确认 |
| 3 | 处方指令执行包络（`#119`） | `decision-service` 处方生成、`control-service` `buildCommand`、`field-gateway.ts` | ① `buildCommand` 统一走**同一个** `executionPlanOf`（事件入队不再漏算包络）；② `PrescriptionIssuedPayload` 补可选 `areaMu`，由 `decision-service` 经 `fetchPlotArea` 从地块台账取，**不接受请求体自报面积**；③ 仅「单条灌溉明细 + 台账面积 > 0 + 定额 0~100 毫米」才给 `zones`，其余写 `envelopeBlocked` 说明原因；④ 网关照实回执 `envelopeBlocked`，领取之前判失败、零线圈写入 | 已自查，「宁缺不造」口径成立，施肥/多明细/补灌仍按待决口径如实阻塞 | 待确认 |
| 4 | 构建期类型修复 | `apps/operation-service/src/task.repository.ts`、`apps/web/src/views/plot/List.vue` | ① `TaskChangeLog.traceId` 在 `exactOptionalPropertyTypes` 下用条件展开 `...(traceId === undefined ? {} : { traceId })`；② 合并分组 `map((group: string[]) => …)` 标注类型（TS7006）；③ 移除 `ElMessageBox.confirm` 不存在的 `confirmButtonPosition`（TS2769） | 已自查，修复与报错一一对应 | 待确认 |
| 5 | 现场网关开关接入 compose | `infra/docker-compose.yml` | ① `app` 服务 `environment:` 新增 `FIELD_GATEWAY_ENABLED: ${FIELD_GATEWAY_ENABLED:-}`；② 服务端 `main.ts` 仅控现场协议网关启动（`gatewayEnabled ? new FieldGateway(...) : undefined`），不影响服务本身；③ 留空=默认关，与接入前一致；④ `smoke-device-protocol.mjs` 冒烟时显式设 `1` | 已自查，`docker-compose config` 校验通过 | 待确认 |
| 6 | 文档与清单同步 | `EXISTING_FEATURES.md`、`EXTERNAL_INPUTS.md`、`IMPLEMENTATION_PROGRESS.md` | ① `EXISTING_FEATURES`「现场网关开关已接入 compose」表述已同步；② `EXTERNAL_INPUTS` 只登记待决项与所需输入，**不臆造**输入值；③ 进度文档记录本轮两项 | 已自查，与代码/配置一致 | 待确认 |

## 说明

- 以上六项为 2026-11-13 及后续交付的关键改动，均属「未跑验证」口径，**第二复核人需逐项确认是否接受**；如有异议，在对应行注明，再由第一复核人修正后复验。
- 双人复核完成后，本记录随交付归档；`EXTERNAL_INPUTS.md` 中外部输入项不参与本次代码复核，仍待外部提供。
