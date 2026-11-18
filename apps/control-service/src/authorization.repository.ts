import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 控制指令作业授权仓储（A8，开发方案 14.3 范围管控，迁移 051）。
 *
 * 一条授权 = 「哪些设备 + 哪些地块 + 哪段时间」允许人工作业：device_id/plot_code
 * 为空表示通配。人工下发指令前由 HTTP 层调 `covers` 校验，命中任一授权即放行。
 *
 * 空表语义是「未启用范围管控」而不是「全部拒绝」：存量演示与测试没有授权数据，
 * 升级即拒掉所有下发会把平台锁死。启用管控必须先显式建档，`count` 就是这道开关。
 * 事件自动指令不走这里——越限/处方联动是平台自身的安全处置，范围管控只约束人工下发。
 */

/** 一条作业授权记录 */
export interface ControlAuthorization {
  id: string;
  tenantId: string;
  /** 授权设备；缺省表示全部设备 */
  deviceId?: string;
  /** 授权地块；缺省表示全部地块 */
  plotCode?: string;
  /** 授权窗口起点（ISO） */
  validFrom: string;
  /** 授权窗口终点（ISO），必须晚于起点 */
  validTo: string;
  /** 授权依据，如调度单号/负责人批示 */
  note?: string;
  createdBy: string;
  createdAt: string;
}

export interface ControlAuthorizationRepository {
  /** 租户全部授权，按创建时间倒序，供前端管理列表 */
  list(tenantId: string): Promise<ControlAuthorization[]>;
  create(record: ControlAuthorization): Promise<ControlAuthorization>;
  /** 删除授权；不存在或跨租户返回 false */
  remove(tenantId: string, id: string): Promise<boolean>;
  /** 租户授权条数；0 表示未启用范围管控 */
  count(tenantId: string): Promise<number>;
  /** 是否存在覆盖「设备 + 地块 + 时刻」的授权（通配字段按命中算） */
  covers(tenantId: string, deviceId: string, plotCode: string, atIso: string): Promise<boolean>;
}

const COLUMNS = "id, tenant_id, device_id, plot_code, valid_from, valid_to, note, created_by, created_at";

function toRecord(row: Record<string, unknown>): ControlAuthorization {
  const record: ControlAuthorization = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    validFrom: toIsoTimestamp(row.valid_from),
    validTo: toIsoTimestamp(row.valid_to),
    createdBy: String(row.created_by),
    createdAt: toIsoTimestamp(row.created_at),
  };
  if (row.device_id !== null && row.device_id !== undefined && row.device_id !== "") record.deviceId = String(row.device_id);
  if (row.plot_code !== null && row.plot_code !== undefined && row.plot_code !== "") record.plotCode = String(row.plot_code);
  if (row.note !== null && row.note !== undefined && row.note !== "") record.note = String(row.note);
  return record;
}

/** 授权是否覆盖一次下发：通配字段不限制，窗口按闭区间判定（与 SQL 谓词同口径） */
function coversOf(record: ControlAuthorization, deviceId: string, plotCode: string, atMs: number): boolean {
  if (record.deviceId !== undefined && record.deviceId !== deviceId) return false;
  if (record.plotCode !== undefined && record.plotCode !== plotCode) return false;
  return Date.parse(record.validFrom) <= atMs && atMs <= Date.parse(record.validTo);
}

/** PostgreSQL 实现，表结构由迁移 051 建立 */
export class SqlControlAuthorizationRepository implements ControlAuthorizationRepository {
  constructor(private readonly client: PrismaClientLike) {}

  async list(tenantId: string): Promise<ControlAuthorization[]> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${COLUMNS} FROM control_authorizations WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC`,
      tenantId,
    );
    return rows.map(toRecord);
  }

  async create(record: ControlAuthorization): Promise<ControlAuthorization> {
    const rows = await this.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO control_authorizations (id, tenant_id, device_id, plot_code, valid_from, valid_to, note, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      record.id,
      record.tenantId,
      record.deviceId ?? null,
      record.plotCode ?? null,
      record.validFrom,
      record.validTo,
      record.note ?? null,
      record.createdBy,
      record.createdAt,
    );
    return toRecord(rows[0] as Record<string, unknown>);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.client.$queryRawUnsafe<Array<{ id: string }>>(
      "DELETE FROM control_authorizations WHERE tenant_id = $1 AND id = $2 RETURNING id",
      tenantId,
      id,
    );
    return rows.length > 0;
  }

  async count(tenantId: string): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<Array<{ total: number }>>(
      "SELECT COUNT(*)::int AS total FROM control_authorizations WHERE tenant_id = $1",
      tenantId,
    );
    return Number(rows[0]?.total ?? 0);
  }

  async covers(tenantId: string, deviceId: string, plotCode: string, atIso: string): Promise<boolean> {
    // 通配列用 IS NULL OR 等值匹配；窗口闭区间与内存实现 coversOf 同一口径
    const rows = await this.client.$queryRawUnsafe<Array<{ hit: number }>>(
      `SELECT 1 AS hit FROM control_authorizations
       WHERE tenant_id = $1
         AND (device_id IS NULL OR device_id = $2)
         AND (plot_code IS NULL OR plot_code = $3)
         AND valid_from <= $4::timestamptz AND $4::timestamptz <= valid_to
       LIMIT 1`,
      tenantId,
      deviceId,
      plotCode,
      atIso,
    );
    return rows.length > 0;
  }
}

/** 内存实现：未接入数据库的本地模式与测试使用 */
export class InMemoryControlAuthorizationRepository implements ControlAuthorizationRepository {
  private readonly rows: ControlAuthorization[] = [];

  constructor(seed: ControlAuthorization[] = []) {
    this.rows.push(...seed);
  }

  async list(tenantId: string): Promise<ControlAuthorization[]> {
    return this.rows
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((row) => structuredClone(row));
  }

  async create(record: ControlAuthorization): Promise<ControlAuthorization> {
    this.rows.unshift(structuredClone(record));
    return structuredClone(record);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.tenantId === tenantId && row.id === id);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async count(tenantId: string): Promise<number> {
    return this.rows.filter((row) => row.tenantId === tenantId).length;
  }

  async covers(tenantId: string, deviceId: string, plotCode: string, atIso: string): Promise<boolean> {
    const atMs = Date.parse(atIso);
    return this.rows.some((row) => row.tenantId === tenantId && coversOf(row, deviceId, plotCode, atMs));
  }
}