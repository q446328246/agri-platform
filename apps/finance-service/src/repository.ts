import type { PrismaClientLike } from "@agri/db";
import { toIsoTimestamp } from "@agri/shared";

export interface FinanceEntry { id: string; plotCode: string; season: string; kind: "INPUT" | "OUTPUT"; category: string; amount: number; unit: string; note: string; createdAt: string }
export interface FinanceSummary { plotCode: string | null; input: number; output: number; profit: number; currency: "CNY" }
export interface FinanceRepository { list(plotCode?: string): Promise<FinanceEntry[]>; create(entry: FinanceEntry): Promise<FinanceEntry>; summary(plotCode?: string): Promise<FinanceSummary> }

export class InMemoryFinanceRepository implements FinanceRepository {
  private readonly entries: FinanceEntry[] = [];
  async list(plotCode?: string): Promise<FinanceEntry[]> { return [...this.entries].filter((entry) => !plotCode || entry.plotCode === plotCode); }
  async create(entry: FinanceEntry): Promise<FinanceEntry> { this.entries.unshift(entry); return entry; }
  async summary(plotCode?: string): Promise<FinanceSummary> { const rows = await this.list(plotCode); const input = rows.filter((row) => row.kind === "INPUT").reduce((sum, row) => sum + row.amount, 0); const output = rows.filter((row) => row.kind === "OUTPUT").reduce((sum, row) => sum + row.amount, 0); return { plotCode: plotCode ?? null, input, output, profit: output - input, currency: "CNY" }; }
}

/** PostgreSQL 适配器。真实表结构由 finance-service 的迁移管理。 */
export class SqlFinanceRepository implements FinanceRepository {
  constructor(private readonly client: PrismaClientLike) {}
  private map(row: Record<string, unknown>): FinanceEntry { return { id: String(row.id), plotCode: String(row.plot_code), season: String(row.season), kind: row.kind === "OUTPUT" ? "OUTPUT" : "INPUT", category: String(row.category), amount: Number(row.amount), unit: String(row.unit), note: String(row.note ?? ""), createdAt: toIsoTimestamp(row.created_at) }; }
  async list(plotCode?: string): Promise<FinanceEntry[]> { const rows = plotCode ? await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, plot_code, season, kind, category, amount, unit, note, created_at FROM finance_entries WHERE plot_code = $1 ORDER BY created_at DESC", plotCode) : await this.client.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id, plot_code, season, kind, category, amount, unit, note, created_at FROM finance_entries ORDER BY created_at DESC"); return rows.map((row) => this.map(row)); }
  async create(entry: FinanceEntry): Promise<FinanceEntry> { await this.client.$executeRawUnsafe("INSERT INTO finance_entries (id, plot_code, season, kind, category, amount, unit, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", entry.id, entry.plotCode, entry.season, entry.kind, entry.category, entry.amount, entry.unit, entry.note, entry.createdAt); return entry; }
  async summary(plotCode?: string): Promise<FinanceSummary> { const rows = plotCode ? await this.client.$queryRawUnsafe<Array<{ kind: string; total: number }>>("SELECT kind, COALESCE(SUM(amount), 0) AS total FROM finance_entries WHERE plot_code = $1 GROUP BY kind", plotCode) : await this.client.$queryRawUnsafe<Array<{ kind: string; total: number }>>("SELECT kind, COALESCE(SUM(amount), 0) AS total FROM finance_entries GROUP BY kind"); const input = Number(rows.find((row) => row.kind === "INPUT")?.total ?? 0); const output = Number(rows.find((row) => row.kind === "OUTPUT")?.total ?? 0); return { plotCode: plotCode ?? null, input, output, profit: output - input, currency: "CNY" }; }
}
