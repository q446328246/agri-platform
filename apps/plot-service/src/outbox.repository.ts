import type { PrismaClientLike, Tx } from "@agri/db";
import type { EventTopicValue } from "@agri/contracts";
import type { OutboxRecord, OutboxStore } from "@agri/mq";
import { toIsoTimestamp } from "@agri/shared";

/**
 * 地块服务的本地消息表存储。
 *
 * 建档记录与 PlotCreated 事件同事务写入 plot_outbox，事务提交后由中继任务投递到
 * 共享事件日志，保证「地块落库」与「建档事件发布」要么同时成功，要么同时回滚。
 */
export class SqlPlotOutboxStore implements OutboxStore {
  constructor(private readonly client: PrismaClientLike) {}

  private executor(tx: unknown): Pick<Tx, "$queryRawUnsafe" | "$executeRawUnsafe"> {
    if (!tx || typeof (tx as Tx).$executeRawUnsafe !== "function") {
      throw new Error("SqlPlotOutboxStore.enqueue 必须在事务中执行");
    }
    return tx as Tx;
  }

  async enqueue(tx: unknown, record: OutboxRecord): Promise<void> {
    await this.executor(tx).$executeRawUnsafe(
      `INSERT INTO plot_outbox (id, topic, payload_json, tenant_id, trace_id, producer, created_at, retry_count)
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
       FROM plot_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
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
    await this.client.$executeRawUnsafe(`UPDATE plot_outbox SET published_at = now() WHERE id = $1`, id);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.client.$executeRawUnsafe(`UPDATE plot_outbox SET retry_count = retry_count + 1, last_error = $2 WHERE id = $1`, id, error);
  }
}
