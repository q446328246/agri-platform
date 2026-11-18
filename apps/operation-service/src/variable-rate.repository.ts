import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";
import type { VariableOperationType, VariableRatePlan } from "./variable-rate.js";

/**
 * 变量播种/施肥方案留痕（A15，迁移 055）。
 * 覆盖方案只在进程内保留最近 20 条，变量方案涉及投入品用量，
 * 要留给生产档案复盘，故 SQL 模式落库；内存模式同样保留最近 20 条供演示。
 */

export interface VariableRatePlanRecord {
  id: string;
  tenantId: string;
  plotCode: string;
  operationType: VariableOperationType;
  metric: string;
  plan: VariableRatePlan;
  createdAt: string;
}

export interface VariableRatePlanRepository {
  save(record: VariableRatePlanRecord): Promise<void>;
  /** 按建档时间倒序，缺省最近 20 条 */
  list(tenantId: string, limit?: number): Promise<VariableRatePlanRecord[]>;
}

const KEEP = 20;

export class InMemoryVariableRatePlanRepository implements VariableRatePlanRepository {
  private readonly plans = new Map<string, VariableRatePlanRecord[]>();
  async save(record: VariableRatePlanRecord): Promise<void> {
    const plans = this.plans.get(record.tenantId) ?? [];
    plans.unshift(record);
    if (plans.length > KEEP) plans.pop();
    this.plans.set(record.tenantId, plans);
  }
  async list(tenantId: string, limit = KEEP): Promise<VariableRatePlanRecord[]> {
    return (this.plans.get(tenantId) ?? []).slice(0, limit);
  }
}

function fromRow(row: Record<string, unknown>): VariableRatePlanRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    plotCode: String(row.plot_code),
    operationType: String(row.operation_type) as VariableOperationType,
    metric: String(row.metric ?? ""),
    // JSONB 经驱动可能已是对象也可能仍是字符串，两种都收
    plan: (typeof row.plan === "string" ? JSON.parse(row.plan) : row.plan) as VariableRatePlan,
    createdAt: toIsoTimestamp(row.created_at),
  };
}

export class SqlVariableRatePlanRepository implements VariableRatePlanRepository {
  constructor(private readonly client: PrismaClientLike) {}
  async save(record: VariableRatePlanRecord): Promise<void> {
    await this.client.$queryRawUnsafe(
      `INSERT INTO variable_rate_plans (id, tenant_id, plot_code, operation_type, metric, plan, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
      record.id, record.tenantId, record.plotCode, record.operationType, record.metric, JSON.stringify(record.plan), record.createdAt,
    );
  }
  async list(tenantId: string, limit = KEEP): Promise<VariableRatePlanRecord[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM variable_rate_plans WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      tenantId, limit,
    );
    return rows.map(fromRow);
  }
}