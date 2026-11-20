# 无人农场 D 类（农艺口径）确认方案（D1–D3）

> 配套文档：[`无人农场开发需求与待办.md`](./无人农场开发需求与待办.md)（D 类待办）、[`EXTERNAL_INPUTS.md`](./EXTERNAL_INPUTS.md)（外部输入待决项登记）
>
> 统一原则：**农艺口径不臆造**。本方案只登记「需要农艺/现场确认什么、确认后落到代码哪里」；
> 本版起 D1–D3 的确认结果已由农艺口径给出并接入代码，文末附接入状态。

## 背景

D 类是 B 类设备接入与变量作业绕不开的输入：控制指令的定量参数、处方多明细的面积分摊、越限补灌的处置量，都依赖农艺口径。本方案的任务是逐条确认这三处「待确认」并打通。

## 代码落点总览

| 口径 | 代码落点 | 确认前行为 |
| --- | --- | --- |
| D1 灌溉定额 | [`apps/control-service/src/command-spec.ts`](./apps/control-service/src/command-spec.ts) `IrrigationZone.targetMm`、`waterVolumeOf` | 定额（毫米）由指令/处方入参给出，校验 0–100；面积×定额现算用水量与阀门时长 |
| D1 料液密度 | [`apps/iot-service/src/device-binding.ts`](./apps/iot-service/src/device-binding.ts) `FERTILIZER_L` 剖面、[`apps/control-service/src/command-finished.ts`](./apps/control-service/src/command-finished.ts) `resolveFertilizerKg` | 设备计量剖面按升（L）计，回执千克数换算缺密度，设备报千克路径可用 |
| D2 面积分摊 | [`apps/control-service/src/consumer.ts`](./apps/control-service/src/consumer.ts) `prescriptionExecution` | 多明细处方一律 `envelopeBlocked`，分区面积无权威分摊口径 |
| D3 补灌定额 | [`apps/control-service/src/consumer.ts`](./apps/control-service/src/consumer.ts) `onThresholdBreached`、[`apps/decision-service/src/rule.repository.ts`](./apps/decision-service/src/rule.repository.ts) 默认补灌规则 | 越限只带含水率与阈值，自动补灌指令 `envelopeBlocked`，需人工确认作业量 |

## D1 灌溉定额、料液密度

### 确认结果（已确认）

1. **灌溉定额**：大田旱作作物单次灌溉参考范围 **10–40 mm**（一般 10–30 mm/次，干旱补灌可至 40–50 mm）；水肥一体随水施肥时，**灌水定额与施肥定额同源**；按作物与生育期分别固化为后续工作。
2. **料液密度**：水溶肥类料液 **1.0–1.3 kg/L**（略高于水），以产品标签/现场配方为准；平台侧配置默认 **1.0 kg/L**，按实际配方调整，**设备直接报千克时不使用该值**。

### 接入方式（已接入）

- 灌溉定额：定额即处方明细用量（毫米），经 `command-spec.ts` 的分区用水量与阀门时长现算，现有 `targetMm` 校验边界 0–100 覆盖确认范围；作物×生育期定额规则库待按口径固化后接入，不在代码里硬编数值。
- 料液密度：`FERTILIZER_DENSITY_KG_L` 环境变量（缺省 1.0 kg/L）；`resolveFertilizerKg` 在设备按升计量（`FERTILIZER_L` 剖面回执 `fertilizerLiters`）时按密度换算千克，设备实报 `fertilizerKg` 路径不变。

## D2 多明细分区面积分摊规则

### 确认结果（已确认）

采用**规则 A**：明细 `gridCode` → 网格台账面积；多明细逐明细建分区，各分区面积取各自网格台账面积，与单明细处方的现行口径一致，平台侧不另设分摊算法。

### 接入方式（已接入）

- 契约 `PrescriptionItem` 增加 `areaMu`（分区台账面积，亩）；决策侧生成处方时明细自带网格台账面积（引擎明细 `gridCode` 即地块，面积取地块台账值）。
- 控制侧 `prescriptionExecution` 逐明细建分区：分区面积取明细自带 `areaMu`，明细 `gridCode` 即地块时回落用事件带出的地块台账面积；网格非地块且不带面积、或定额越界时保持 `envelopeBlocked` 并说明原因，不猜面积。

## D3 越限补灌处置定额

### 确认结果（已确认）

采用**口径一**：固定补灌定额，参考范围 **10–20 mm/次**（按土壤质地与作物需水确认）；口径二（按含水率缺口估算，需田间持水量等土壤参数）作为二期。

### 接入方式（已接入）

- `AUTO_SUPPLEMENT_IRRIGATION_MM` 环境变量（缺省 15，在确认的 10–20 范围内，按土壤质地与作物需水调整）。
- 遥测发布越限事件时从地块台账带出 `areaMu`；控制侧 `onThresholdBreached` 拿到定额与面积后直接生成带执行包络的自动补灌指令，去掉人工确认环节；事件未带出面积时保持 `envelopeBlocked`，不猜面积。

## 确认流程与回填机制

1. **发起确认**：将本方案的「待确认问题」按条目提交农艺/现场负责人，逐条给出口径（数值、规则、边界）。
2. **回填登记**：确认结果回填 [`EXTERNAL_INPUTS.md`](./EXTERNAL_INPUTS.md) 对应条目，标记「已补全」并移出待决清单；本方案同步更新为确认口径。
3. **接入代码**：按各条「接入方式」落地（规则种子、配置参数、分摊算法、补灌包络），改动后跑单测与对应冒烟脚本。
4. **验收**：口径落库后核对「指令包络现算 → 网关执行 → 结单回流」链路与演示数据一致。

D1–D3 已完成第 1–3 步（确认、回填、接入），验收随交付批次执行。

## 设备类型参数推断（D 类落地）

D1–D3 的口径按设备类型挂接到控制指令参数：设备能执行什么动作，指令就需要什么参数，包络只由已确认的口径现算，不猜。

| 设备类型 | 指令类型 | 推断参数 | 执行包络 |
| --- | --- | --- | --- |
| IRRIGATION_PUMP / IRRIGATION_VALVE | IRRIGATION | 分区面积、灌水定额、供水流量 | 用水量 + 阀门时长 |
| FERTILIZER_VALVE | FERTILIZATION | 氮磷钾配比、水肥一体灌水定额、面积、流量、搅拌 | 投肥量 + 用水量 + 时长 |
| AUTO_TRACTOR | SEEDING / TILLAGE / WEEDING | 作业面积、作业时长 | 作业时长（按入参，不臆造作业速度） |
| AGRICULTURAL_DRONE | SEEDING / WEEDING | 作业面积、作业时长 | 作业时长（按入参） |
| INSECT_LAMP | 开关型 | 作业时长（平台暂无专属指令码，按时长控制） | 作业时长 |

暂停/恢复/急停/断电/返航/换具等联动指令对所有设备通用，不在此列。

**接入**（已落地）：

- 契约 `PrescriptionItem` 增加 `targetMm`（水肥一体灌水定额，与灌溉处方同源）；施肥处方带出该值时控制侧按灌溉口径建分区，缺定额或缺面积保持 `envelopeBlocked` 不猜。
- `command-spec.ts` 增加设备类型 → 指令类型映射（`OPERATION_COMMAND_TYPES_BY_DEVICE`）与作业类指令校验（`areaMu` + `durationMin` 必填）、包络现算（时长按入参）。
- 前端下发表单按指令类型展示对应参数项（水肥分区/配比、作业面积/时长、联动目标）。

## 范围说明

本方案覆盖 D1–D3；D4（变量作业执行硬件落地）属外部硬件依赖，不在此确认范围内。
