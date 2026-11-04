import type { PrismaClientLike } from "@agri/db";

export interface TraceRecord { id: string; traceCode: string; plotCode: string; event: string; detail: string; operator: string; createdAt: string }
export interface TraceRepository { list(plotCode?: string): Promise<TraceRecord[]>; create(record: TraceRecord): Promise<TraceRecord>; findByCode(traceCode: string): Promise<TraceRecord | null> }

export class InMemoryTraceRepository implements TraceRepository {
  private readonly records: TraceRecord[] = [];
  async list(plotCode?: string): Promise<TraceRecord[]> { return [...this.records].filter((record) => !plotCode || record.plotCode === plotCode); }
  async create(record: TraceRecord): Promise<TraceRecord> { this.records.unshift(record); return record; }
  async findByCode(traceCode: string): Promise<TraceRecord | null> { return this.records.find((record) => record.traceCode === traceCode) ?? null; }
}

export class SqlTraceRepository implements TraceRepository {
  constructor(private readonly client: PrismaClientLike) {}
  private map(row: Record<string, unknown>): TraceRecord { return { id: String(row.id), traceCode: String(row.trace_code), plotCode: String(row.plot_code), event: String(row.event), detail: String(row.detail), operator: String(row.operator), createdAt: String(row.created_at) }; }
  async list(plotCode?: string): Promise<TraceRecord[]> { const rows = plotCode ? await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, trace_code, plot_code, event, detail, operator, created_at FROM trace_records WHERE plot_code = $1 ORDER BY created_at DESC", plotCode) : await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, trace_code, plot_code, event, detail, operator, created_at FROM trace_records ORDER BY created_at DESC"); return rows.map((row) => this.map(row)); }
  async create(record: TraceRecord): Promise<TraceRecord> { await this.client.$executeRawUnsafe("INSERT INTO trace_records (id, trace_code, plot_code, event, detail, operator, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", record.id, record.traceCode, record.plotCode, record.event, record.detail, record.operator, record.createdAt); return record; }
  async findByCode(traceCode: string): Promise<TraceRecord | null> { const rows = await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, trace_code, plot_code, event, detail, operator, created_at FROM trace_records WHERE trace_code = $1 LIMIT 1", traceCode); return rows[0] ? this.map(rows[0]) : null; }
}
