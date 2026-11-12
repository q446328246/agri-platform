import type { PrismaClientLike, Tx } from "@agri/db";
import { toIsoTimestamp, ulid } from "@agri/shared";

/**
 * 处方执行回流。
 *
 * 处方下发后由控制服务转成灌溉/施肥指令，指令 DONE 回执再发出结单事件。
 * 这张留痕把「哪条处方由哪条指令执行、实际用了多少水肥、作业多久」记回决策侧，
 * 使「处方生成 → 指令执行 → 效果评估」成为可查询的完整链条。
 *
 * 用量口径与结单事件一致：设备实测优先，其次按指令参数现算的方案总量，
 * 两条路都走不通就留空——把估算当实测写进来，后续的用水用肥统计会全歪。
 */

/** 处方动作类型，与契约 PrescriptionIssuedPayload.planType 同一口径 */
export type PrescriptionPlanType = "irrigation" | "fertilization";

/** 执行回流记录 */
export interface PrescriptionExecution {
  id: string;
  prescriptionId: string;
  /** 结单的指令标识，一条指令只记一次 */
  commandId: string;
  plotCode: string;
  planType: PrescriptionPlanType;
  deviceId: string;
  /** 用水量（立方米），缺省表示设备未上报且方案推不出总量 */
  waterVolume?: number;
  waterVolumeSource?: "DEVICE" | "PLAN";
  /** 施肥量（千克，氮磷钾合计），缺省口径同上 */
  fertilizerKg?: number;
  fertilizerSource?: "DEVICE" | "PLAN";
  durationMin: number;
  durationSource: "DEVICE" | "RUNTIME";
  finishedAt: string;
  /** 来源事件标识，便于回溯事件日志原始行 */
  eventId: string;
  recordedAt: string;
}

/** 执行记录查询条件 */
export interface ExecutionQuery {
  prescriptionId?: string;
  plotCode?: string;
  limit?: number;
}

/** 执行记录仓储 */
export interface ExecutionRepository {
  /** 幂等写入：指令已记录过时返回 null，不覆盖首次留痕 */
  record(input: PrescriptionExecution): Promise<PrescriptionExecution | null>;
  list(query?: ExecutionQuery): Promise<PrescriptionExecution[]>;
  findByCommandId(commandId: string): Promise<PrescriptionExecution | null>;
}

const COLUMNS = `id, prescription_id, command_id, plot_code, plan_type, device_id,
       water_volume, water_volume_source, fertilizer_kg, fertilizer_source,
       duration_min, duration_source, finished_at, event_id, recorded_at`;

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toExecution(row: Record<string, unknown>): PrescriptionExecution {
  const execution: PrescriptionExecution = {
    id: String(row.id),
    prescriptionId: String(row.prescription_id),
    commandId: String(row.command_id),
    plotCode: String(row.plot_code),
    planType: row.plan_type === "fertilization" ? "fertilization" : "irrigation",
    deviceId: String(row.device_id),
    durationMin: Number(row.duration_min),
    durationSource: row.duration_source === "DEVICE" ? "DEVICE" : "RUNTIME",
    finishedAt: toIsoTimestamp(row.finished_at),
    eventId: String(row.event_id),
    recordedAt: toIsoTimestamp(row.recorded_at),
  };
  const waterVolume = optionalNumber(row.water_volume);
  if (waterVolume !== undefined) execution.waterVolume = waterVolume;
  if (row.water_volume_source !== null && row.water_volume_source !== undefined) {
    execution.waterVolumeSource = String(row.water_volume_source) === "DEVICE" ? "DEVICE" : "PLAN";
  }
  const fertilizerKg = optionalNumber(row.fertilizer_kg);
  if (fertilizerKg !== undefined) execution.fertilizerKg = fertilizerKg;
  if (row.fertilizer_source !== null && row.fertilizer_source !== undefined) {
    execution.fertilizerSource = String(row.fertilizer_source) === "DEVICE" ? "DEVICE" : "PLAN";
  }
  return execution;
}

/** PostgreSQL 实现，表结构由迁移 034 管理 */
export class SqlExecutionRepository implements ExecutionRepository {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    return (tx as Tx | undefined) ?? this.client;
  }

  async record(input: PrescriptionExecution): Promise<PrescriptionExecution | null> {
    const affected = await this.executor(undefined).$executeRawUnsafe(
      `INSERT INTO decision_prescription_executions
       (id, prescription_id, command_id, plot_code, plan_type, device_id,
        water_volume, water_volume_source, fertilizer_kg, fertilizer_source,
        duration_min, duration_source, finished_at, event_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (command_id) DO NOTHING`,
      input.id,
      input.prescriptionId,
      input.commandId,
      input.plotCode,
      input.planType,
      input.deviceId,
      input.waterVolume ?? null,
      input.waterVolumeSource ?? null,
      input.fertilizerKg ?? null,
      input.fertilizerSource ?? null,
      input.durationMin,
      input.durationSource,
      input.finishedAt,
      input.eventId,
      input.recordedAt,
    );
    return affected > 0 ? input : null;
  }

  async list(query: ExecutionQuery = {}): Promise<PrescriptionExecution[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.prescriptionId !== undefined && query.prescriptionId !== "") {
      values.push(query.prescriptionId);
      conditions.push(`prescription_id = $${values.length}`);
    }
    if (query.plotCode !== undefined && query.plotCode !== "") {
      values.push(query.plotCode);
      conditions.push(`plot_code = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(Math.min(200, Math.max(1, query.limit ?? 50)));
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM decision_prescription_executions ${where}
       ORDER BY finished_at DESC, id DESC LIMIT $${values.length}`,
      ...values,
    );
    return rows.map(toExecution);
  }

  async findByCommandId(commandId: string): Promise<PrescriptionExecution | null> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM decision_prescription_executions WHERE command_id = $1 LIMIT 1`,
      commandId,
    );
    const row = rows[0];
    return row ? toExecution(row) : null;
  }
}

/** 内存实现：本地模式与测试用，同样按 commandId 幂等 */
export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly rows: PrescriptionExecution[] = [];

  async record(input: PrescriptionExecution): Promise<PrescriptionExecution | null> {
    if (this.rows.some((row) => row.commandId === input.commandId)) return null;
    this.rows.unshift({ ...input });
    return input;
  }

  async list(query: ExecutionQuery = {}): Promise<PrescriptionExecution[]> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    return this.rows
      .filter((row) => (query.prescriptionId ? row.prescriptionId === query.prescriptionId : true))
      .filter((row) => (query.plotCode ? row.plotCode === query.plotCode : true))
      .slice(0, limit);
  }

  async findByCommandId(commandId: string): Promise<PrescriptionExecution | null> {
    return this.rows.find((row) => row.commandId === commandId) ?? null;
  }

  /** 全部记录，供测试断言 */
  all(): PrescriptionExecution[] {
    return [...this.rows];
  }
}

/** 生成执行记录标识 */
export function newExecutionId(): string {
  return ulid();
}
