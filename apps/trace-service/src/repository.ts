import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

export interface TraceRecord { id: string; traceCode: string; batchCode: string; plotCode: string; event: string; detail: string; operator: string; createdAt: string }

/** 处方下发事件写入的档案事件编码 */
export const PRESCRIPTION_EVENT = "PRESCRIPTION_ISSUED";

/** 设备结单事件写入的档案事件编码：人工补录入口不提供，接口直接拒绝 */
export const IRRIGATION_EVENT = "IRRIGATION_FINISHED";
export interface TraceRepository { list(plotCode?: string, event?: string, batchCode?: string): Promise<TraceRecord[]>; create(record: TraceRecord): Promise<TraceRecord>; findByCode(traceCode: string): Promise<TraceRecord | null>; chain(batchCode: string): Promise<TraceRecord[]> }

export class InMemoryTraceRepository implements TraceRepository {
  private readonly records: TraceRecord[] = [];
  async list(plotCode?: string, event?: string, batchCode?: string): Promise<TraceRecord[]> { return [...this.records].filter((record) => (!plotCode || record.plotCode === plotCode) && (!event || record.event === event) && (!batchCode || record.batchCode === batchCode)); }
  /** 追溯码唯一：事件重放时返回已存在的档案，不重复建档 */
  async create(record: TraceRecord): Promise<TraceRecord> { const existing = this.records.find((row) => row.traceCode === record.traceCode); if (existing) return existing; this.records.unshift(record); return record; }
  async findByCode(traceCode: string): Promise<TraceRecord | null> { return this.records.find((record) => record.traceCode === traceCode) ?? null; }
  /** 同一溯源码下按记录时间正序，即为完整生产链条 */
  async chain(batchCode: string): Promise<TraceRecord[]> { return this.records.filter((record) => record.batchCode === batchCode).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
}

export class SqlTraceRepository implements TraceRepository {
  constructor(private readonly client: PrismaClientLike) {}
  private map(row: Record<string, unknown>): TraceRecord { return { id: String(row.id), traceCode: String(row.trace_code), batchCode: String(row.batch_code ?? ""), plotCode: String(row.plot_code), event: String(row.event), detail: String(row.detail), operator: String(row.operator), createdAt: toIsoTimestamp(row.created_at) }; }
  async list(plotCode?: string, event?: string, batchCode?: string): Promise<TraceRecord[]> { const values: string[] = []; const conditions: string[] = []; if (plotCode) { values.push(plotCode); conditions.push(`plot_code = $${values.length}`); } if (event) { values.push(event); conditions.push(`event = $${values.length}`); } if (batchCode) { values.push(batchCode); conditions.push(`batch_code = $${values.length}`); } const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""; const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, trace_code, batch_code, plot_code, event, detail, operator, created_at FROM trace_records" + where + " ORDER BY created_at DESC", ...values); return rows.map((row) => this.map(row)); }
  async create(record: TraceRecord): Promise<TraceRecord> { await this.client.$executeRawUnsafe("INSERT INTO trace_records (id, trace_code, batch_code, plot_code, event, detail, operator, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (trace_code) DO NOTHING", record.id, record.traceCode, record.batchCode, record.plotCode, record.event, record.detail, record.operator, record.createdAt); return record; }
  async findByCode(traceCode: string): Promise<TraceRecord | null> { const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, trace_code, batch_code, plot_code, event, detail, operator, created_at FROM trace_records WHERE trace_code = $1 LIMIT 1", traceCode); return rows[0] ? this.map(rows[0]) : null; }
  async chain(batchCode: string): Promise<TraceRecord[]> { const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, trace_code, batch_code, plot_code, event, detail, operator, created_at FROM trace_records WHERE batch_code = $1 ORDER BY created_at ASC", batchCode); return rows.map((row) => this.map(row)); }
}
