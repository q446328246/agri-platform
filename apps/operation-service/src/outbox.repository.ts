import type { PrismaClientLike } from "@agri/db";
import { EventTopic } from "@agri/contracts";
import type { OutboxRecord, OutboxStore } from "@agri/mq";
import { toIsoTimestamp } from "@agri/shared";

export class SqlOperationOutbox implements OutboxStore {
  constructor(private readonly client: PrismaClientLike) {}
  async enqueue(): Promise<void> { throw new Error("任务完成事件必须与状态转换原子写入"); }
  async listPending(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT * FROM operation_outbox WHERE published_at IS NULL ORDER BY created_at, id LIMIT $1", limit);
    return rows.map((row) => ({ id: String(row.id), topic: EventTopic.OperationTaskCompleted, payload: row.payload_json, tenantId: String(row.tenant_id), traceId: String(row.trace_id), producer: "operation", createdAt: toIsoTimestamp(row.created_at), retryCount: Number(row.retry_count), ...(row.last_error == null ? {} : { lastError: String(row.last_error) }) }));
  }
  async markPublished(id: string): Promise<void> { await this.client.$executeRawUnsafe("UPDATE operation_outbox SET published_at = now() WHERE id = $1", id); }
  async markFailed(id: string, error: string): Promise<void> { await this.client.$executeRawUnsafe("UPDATE operation_outbox SET retry_count = retry_count + 1, last_error = $2 WHERE id = $1", id, error); }
}
