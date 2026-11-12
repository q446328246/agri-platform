import type { EventTopicValue } from "@agri/contracts";
import type { PrismaClientLike, Tx } from "@agri/db";
import type { OutboxRecord, OutboxStore } from "@agri/mq";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 控制服务的本地消息表存储。
 *
 * 指令状态跃迁与待投递事件同事务写入 control_outbox（迁移 033），事务提交后由中继
 * 投递到共享事件日志，保证「指令改到位」与「事件发出去」要么同时成功要么同时回滚。
 * 与 plot/decision 同一口径：没有事务句柄就直接拒绝，不允许绕过事务写消息表。
 */
export class SqlControlOutboxStore implements OutboxStore {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    if (!tx || typeof (tx as Tx).$executeRawUnsafe !== "function") {
      throw new Error("SqlControlOutboxStore.enqueue 必须在事务中执行");
    }
    return tx as Tx;
  }

  async enqueue(tx: unknown, record: OutboxRecord): Promise<void> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO control_outbox (id, topic, payload_json, tenant_id, trace_id, producer, created_at, retry_count)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
      record.id,
      record.topic,
      JSON.stringify(record.payload),
      record.tenantId,
      record.traceId,
      record.producer,
      record.createdAt,
      record.retryCount,
    );
  }

  async listPending(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, topic, payload_json, tenant_id, trace_id, producer, created_at, published_at, retry_count, last_error
       FROM control_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
      limit,
    );
    return rows.map((row) => {
      const record: OutboxRecord = {
        id: String(row.id),
        topic: String(row.topic) as EventTopicValue,
        payload: row.payload_json,
        tenantId: String(row.tenant_id),
        traceId: String(row.trace_id),
        producer: String(row.producer),
        createdAt: toIsoTimestamp(row.created_at),
        retryCount: Number(row.retry_count),
      };
      if (row.published_at !== null && row.published_at !== undefined) record.publishedAt = toIsoTimestamp(row.published_at);
      if (row.last_error !== null && row.last_error !== undefined) record.lastError = String(row.last_error);
      return record;
    });
  }

  async markPublished(id: string): Promise<void> {
    await this.client.$executeRawUnsafe(`UPDATE control_outbox SET published_at = now() WHERE id = $1`, id);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.client.$executeRawUnsafe(`UPDATE control_outbox SET retry_count = retry_count + 1, last_error = $2 WHERE id = $1`, id, error);
  }
}
